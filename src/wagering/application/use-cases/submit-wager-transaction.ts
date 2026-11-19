import type { KeyedMutex } from "../../../shared/concurrency/keyed-mutex.ts";
import { DomainError } from "../../../shared/domain/domain-error.ts";
import { CurrencyMismatchError, Money, type MoneyProps } from "../../../shared/domain/money.ts";
import { InboxMessage } from "../../../shared/messaging/inbox-message.ts";
import { crashPoint } from "../../../shared/testing/crash-point.ts";
import { ErrorCode } from "../../domain/error-code.ts";
import { WalletPlayerMismatchError } from "../../domain/errors.ts";
import { FailureCode } from "../../domain/failure-code.ts";
import { evaluateReference } from "../../domain/reference-policy.ts";
import type { ReferenceResolutionPolicy } from "../../domain/reference-resolution-policy.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction-kind.ts";
import type { Wallet } from "../../domain/wallet.ts";
import { WalletNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import {
  LockTimeoutError,
  PersistenceBusyError,
  UniqueViolationError,
} from "../ports/persistence-errors.ts";
import type { EntryChannel, WageringTelemetry } from "../ports/telemetry.ts";
import type { TransactionScope, UnitOfWork } from "../ports/unit-of-work.ts";
import { TransactionSettler } from "../transaction-settler.ts";

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly correlationId: string;
  readonly channel: EntryChannel;
  /** Entrada via SQS: registro de inbox gravado na MESMA transação do efeito (CHALLENGE §10). */
  readonly inbox?: {
    readonly consumerName: string;
    readonly messageId: string;
    readonly payloadHash: string;
  };
}

/**
 * - `created`: transação nova registrada neste pedido.
 * - `replayed`: reenvio de transação já registrada; nada mudou.
 * - `resolved`: reenvio de transação pendente cuja reference chegou; mudou de estado agora (ADR 0012).
 */
export type SubmissionOutcome = "created" | "replayed" | "resolved";

export interface SubmissionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  /** Saldo observado ao finalizar (replay devolve o original, CHALLENGE §7.7); pendente: saldo atual. */
  readonly balance: MoneyProps;
  readonly failureCode: FailureCode | null;
  readonly idempotentReplay: boolean;
  readonly outcome: SubmissionOutcome;
}

/** Mesma idempotency key com payload diferente, ou mesmo id externo com outra key (ADR 0008). */
export class IdempotencyConflictError extends DomainError {
  constructor(
    code: ErrorCode.IdempotencyKeyConflict | ErrorCode.ExternalIdConflict,
    readonly existingTransactionId: string,
  ) {
    super(
      code,
      code === ErrorCode.IdempotencyKeyConflict
        ? "Idempotency-Key was already used with a different payload"
        : "externalTransactionId was already submitted with a different Idempotency-Key",
    );
  }
}

const IDEMPOTENCY_CONSTRAINTS = new Set([
  "wager_transaction_idempotency_uq",
  "wager_transaction_external_id_uq",
]);

export interface SubmitWagerTransactionDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telemetry: WageringTelemetry;
  readonly resolutionPolicy: ReferenceResolutionPolicy;
  readonly walletLockTimeoutMs: number;
  /** Fila por wallet dentro da instância (compartilhada com o worker); ver `KeyedMutex`. */
  readonly walletMutex: KeyedMutex;
}

/**
 * Caso de uso único para HTTP e SQS (CHALLENGE §10). Tudo acontece numa transação SQL com a wallet
 * travada (ADR 0003): idempotência, regras, ledger, saldo, outbox e inbox são confirmados juntos
 * ou nada é (CHALLENGE §11).
 */
export class SubmitWagerTransaction {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: SubmitWagerTransactionDeps) {
    this.settler = new TransactionSettler(deps.ids, deps.resolutionPolicy);
  }

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    const startedAt = performance.now();
    const { telemetry } = this.deps;
    try {
      const result = await this.executeWithRaceRetry(command);
      telemetry.submissionObserved(command.channel, result.outcome, elapsed(startedAt));
      if (result.outcome === "replayed") telemetry.duplicateDetected("idempotent_replay");
      else telemetry.transactionCompleted(command.kind, result.status, command.channel);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        telemetry.idempotencyConflict(error.code);
        telemetry.submissionObserved(command.channel, "conflict", elapsed(startedAt));
      } else {
        if (error instanceof LockTimeoutError) telemetry.lockConflict("lock_timeout");
        if (error instanceof PersistenceBusyError) telemetry.lockConflict("pool_exhausted");
        telemetry.submissionObserved(command.channel, "error", elapsed(startedAt));
      }
      throw error;
    }
  }

  /**
   * Dois pedidos com a mesma key em wallets DIFERENTES não se serializam pelo lock: ambos podem não
   * achar nada e tentar inserir. A constraint única barra o segundo no commit; repetir uma vez faz
   * ele enxergar o primeiro e cair no caminho normal (replay ou conflito).
   */
  private async executeWithRaceRetry(
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmissionResult> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        IDEMPOTENCY_CONSTRAINTS.has(error.constraint ?? "")
      ) {
        return this.attempt(command);
      }
      throw error;
    }
  }

  private async attempt(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    const { clock, ids } = this.deps;
    const now = clock.now();
    // Valida o contrato e calcula o payloadHash ANTES de tocar no banco: entrada inválida não trava nada.
    const candidate = WagerTransaction.create({
      id: ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: parseKind(command.kind),
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: command.correlationId,
      at: now,
    });

    // Fila por wallet ANTES de pedir conexão: uma hot wallet não esgota o pool e não trava as outras.
    return this.deps.walletMutex.run(
      candidate.walletId,
      this.deps.walletLockTimeoutMs,
      () => new LockTimeoutError(),
      () => this.applyLocked(command, candidate, now),
    );
  }

  private applyLocked(
    command: SubmitWagerTransactionCommand,
    candidate: WagerTransaction,
    now: Date,
  ): Promise<SubmissionResult> {
    return this.deps.uow.transactional(
      async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(candidate.walletId);
        assertWalletAccepts(wallet, candidate);

        const existing = await scope.transactions.findByIdempotencyKey(
          candidate.providerId,
          candidate.idempotencyKey,
        );
        if (existing) {
          if (!existing.matchesPayload(candidate.payloadHash)) {
            throw new IdempotencyConflictError(ErrorCode.IdempotencyKeyConflict, existing.id);
          }
          this.recordInbox(scope, command, now);
          return this.replay(scope, existing, wallet, now);
        }
        const sameExternalId = await scope.transactions.findByExternalId(
          candidate.providerId,
          candidate.externalTransactionId,
        );
        if (sameExternalId) {
          throw new IdempotencyConflictError(ErrorCode.ExternalIdConflict, sameExternalId.id);
        }

        const outcome = await this.settler.settleAndStage(scope, candidate, wallet, now, "add");
        this.recordInbox(scope, command, now);
        // Tudo registrado no Unit of Work, nada confirmado: morrer aqui não pode deixar rastro (CHALLENGE §3).
        crashPoint("submit:before-commit");
        return toResult(candidate, wallet, outcome.status, false, "created");
      },
      { lockTimeoutMs: this.deps.walletLockTimeoutMs },
    );
  }

  /**
   * Reenvio idêntico. Estado terminal: devolve o resultado original sem tocar em nada. Pendente:
   * tenta resolver a reference agora (ADR 0012); se ela ainda não existe, nada muda — reenvios do
   * provider não consomem as tentativas do worker.
   */
  private async replay(
    scope: TransactionScope,
    existing: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<SubmissionResult> {
    if (existing.status !== WagerTransactionStatus.PendingReference) {
      return toResult(existing, wallet, existing.status, true, "replayed");
    }
    const reference = await this.settler.findReference(scope, existing);
    if (!reference || evaluateReference(existing, reference).outcome === "wait") {
      return toResult(existing, wallet, existing.status, true, "replayed");
    }
    const outcome = await this.settler.settleAndStage(
      scope,
      existing,
      wallet,
      now,
      "save",
      reference,
    );
    return toResult(existing, wallet, outcome.status, true, "resolved");
  }

  private recordInbox(scope: TransactionScope, command: SubmitWagerTransactionCommand, now: Date) {
    if (!command.inbox) return;
    const message = InboxMessage.receive({ ...command.inbox, receivedAt: now });
    message.markProcessed(now);
    scope.inbox.add(message);
  }
}

/**
 * O kind chega como string (HTTP já validou o formato; a fila não). Valores fora do enum, e OPENING,
 * são recusados por `WagerTransaction.create` com UNSUPPORTED_KIND.
 */
function parseKind(kind: string): WagerTransactionKind {
  return kind as WagerTransactionKind;
}

/** Wallet inexistente ou divergente: recusa sem persistir nada (ADR 0007). */
function assertWalletAccepts(
  wallet: Wallet | undefined,
  tx: WagerTransaction,
): asserts wallet is Wallet {
  if (!wallet) throw new WalletNotFoundError(tx.walletId);
  if (wallet.playerId !== tx.playerId) throw new WalletPlayerMismatchError(wallet.id);
  if (wallet.currency !== tx.money.currency) {
    throw new CurrencyMismatchError(wallet.currency, tx.money.currency);
  }
}

function toResult(
  tx: WagerTransaction,
  wallet: Wallet,
  status: WagerTransactionStatus,
  idempotentReplay: boolean,
  outcome: SubmissionOutcome,
): SubmissionResult {
  return {
    transactionId: tx.id,
    status,
    balance: (tx.balanceAfter ?? wallet.balance).toJSON(),
    failureCode: tx.failureCode ?? null,
    idempotentReplay,
    outcome,
  };
}

function elapsed(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}
