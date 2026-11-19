import { PinoLogger } from "nestjs-pino";
import { DomainError } from "../../../shared/domain/domain-error.ts";
import { InboxMessage } from "../../../shared/messaging/inbox-message.ts";
import { runWithLogContext } from "../../../shared/observability/log-context.ts";
import {
  LockTimeoutError,
  PersistenceUnavailableError,
  UniqueViolationError,
} from "../../application/ports/persistence-errors.ts";
import type { WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import type { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction.ts";
import { ErrorCode } from "../../domain/error-code.ts";
import { canonicalJson } from "../../domain/payload-hash.ts";
import {
  type WagerTransactionRequestedMessage,
  wagerTransactionRequestedMessage,
} from "../contracts.ts";

export const WAGER_TRANSACTIONS_CONSUMER = "wager-transactions";

export interface ReceivedMessage {
  readonly body: string;
  /** Atributo de mensagem `correlationId`, se o produtor mandou. */
  readonly correlationId: string | undefined;
}

/**
 * O que fazer com a mensagem (ADR 0014):
 * - `ack`: efeito confirmado (ou já existia) — apagar da fila.
 * - `dead-letter`: nunca vai dar certo — mover para a DLQ agora, sem gastar retries.
 * - `retry`: falha transitória — não apagar; volta à fila depois de um backoff.
 */
export type HandlingDecision =
  | { readonly action: "ack"; readonly reason: "processed" | "duplicate" | "business_rejected" }
  | { readonly action: "dead-letter"; readonly reason: string; readonly detail: string }
  | {
      readonly action: "retry";
      /**
       * `dependency_unavailable`: o banco caiu — não é problema DESTA mensagem; o consumer pausa.
       * `transient`: problema pontual (ex.: wallet disputada) — só esta mensagem espera.
       */
      readonly reason: "dependency_unavailable" | "transient" | "unexpected";
      readonly detail: string;
    };

/** Erros de forma do conteúdo: reenviar a mesma mensagem nunca vai funcionar. */
const PERMANENT_CODES = new Set<string>([
  ErrorCode.InvalidPayload,
  ErrorCode.UnsupportedKind,
  ErrorCode.ReferenceRequired,
]);

/**
 * Decide o destino de uma mensagem da fila `wager-transactions.fifo`. Não fala com o SQS: quem
 * apaga, move para a DLQ ou adia é o consumer, e só depois que esta decisão volta — ou seja, depois
 * do commit (CHALLENGE §10: ack somente após o commit).
 */
export class WagerMessageHandler {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly uow: UnitOfWork,
    private readonly telemetry: WageringTelemetry,
    private readonly logger: PinoLogger,
  ) {}

  async handle(message: ReceivedMessage): Promise<HandlingDecision> {
    let json: unknown;
    try {
      json = JSON.parse(message.body);
    } catch {
      return { action: "dead-letter", reason: "malformed_json", detail: "body is not valid JSON" };
    }
    const parsed = wagerTransactionRequestedMessage.safeParse(json);
    if (!parsed.success) {
      // Só os caminhos dos campos: o conteúdo pode ter dados financeiros (CHALLENGE §12).
      const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return {
        action: "dead-letter",
        reason: "invalid_schema",
        detail: `invalid fields: ${fields}`,
      };
    }
    const envelope = parsed.data;
    const correlationId = message.correlationId ?? envelope.messageId;
    return runWithLogContext(
      {
        correlationId,
        messageId: envelope.messageId,
        providerId: envelope.data.providerId,
        walletId: envelope.data.walletId,
      },
      () => this.process(envelope, correlationId),
    );
  }

  private async process(
    envelope: WagerTransactionRequestedMessage,
    correlationId: string,
  ): Promise<HandlingDecision> {
    // Hash do conteúdo de negócio da mensagem (tipo + dados); `occurredAt` é metadado de transporte.
    const payloadHash = new Bun.CryptoHasher("sha256")
      .update(canonicalJson({ type: envelope.type, data: envelope.data }))
      .digest("hex");

    let seen: InboxMessage | undefined;
    try {
      seen = await this.uow.read((s) =>
        s.inbox.find(WAGER_TRANSACTIONS_CONSUMER, envelope.messageId),
      );
    } catch (error) {
      // Banco fora já na consulta ao inbox: mesma classificação de quando falha no use case.
      return this.classify(error, envelope.messageId, payloadHash);
    }
    if (seen) {
      if (!seen.matchesPayload(payloadHash)) {
        return {
          action: "dead-letter",
          reason: "message_id_reused",
          detail: "messageId already processed with a different payload",
        };
      }
      this.telemetry.duplicateDetected("inbox");
      this.logger.info("duplicate message ignored (inbox)");
      return { action: "ack", reason: "duplicate" };
    }

    const { idempotencyKey, ...fields } = envelope.data;
    try {
      const result = await this.submit.execute({
        ...fields,
        idempotencyKey,
        correlationId,
        channel: "sqs",
        inbox: {
          consumerName: WAGER_TRANSACTIONS_CONSUMER,
          messageId: envelope.messageId,
          payloadHash,
        },
      });
      this.logger.info(
        {
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
        },
        "message processed",
      );
      return { action: "ack", reason: "processed" };
    } catch (error) {
      return this.classify(error, envelope.messageId, payloadHash);
    }
  }

  private async classify(
    error: unknown,
    messageId: string,
    payloadHash: string,
  ): Promise<HandlingDecision> {
    if (error instanceof UniqueViolationError && error.constraint === "inbox_message_pk") {
      // Outra entrega da mesma mensagem confirmou primeiro (visibilidade expirou no meio do caminho).
      this.telemetry.duplicateDetected("inbox");
      return { action: "ack", reason: "duplicate" };
    }
    if (error instanceof DomainError) {
      if (PERMANENT_CODES.has(error.code)) {
        return { action: "dead-letter", reason: "invalid_payload", detail: error.code };
      }
      // Erro de negócio (wallet inexistente, divergente, conflito de idempotência): terminal.
      // Nada foi gravado na transação que falhou, então o inbox é registrado à parte (ADR 0007).
      await this.recordInbox(messageId, payloadHash);
      this.logger.warn({ failureCode: error.code }, "message rejected by business rule");
      return { action: "ack", reason: "business_rejected" };
    }
    if (error instanceof PersistenceUnavailableError) {
      return { action: "retry", reason: "dependency_unavailable", detail: error.name };
    }
    if (error instanceof LockTimeoutError) {
      return { action: "retry", reason: "transient", detail: error.name };
    }
    // Inesperado (bug?): tenta de novo; se persistir, o redrive do SQS leva para a DLQ.
    this.logger.error({ err: error }, "unexpected error processing message");
    return {
      action: "retry",
      reason: "unexpected",
      detail: error instanceof Error ? error.name : "unknown",
    };
  }

  private async recordInbox(messageId: string, payloadHash: string): Promise<void> {
    const now = new Date();
    const message = InboxMessage.receive({
      consumerName: WAGER_TRANSACTIONS_CONSUMER,
      messageId,
      payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    try {
      await this.uow.transactional(async (scope) => scope.inbox.add(message));
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
  }
}
