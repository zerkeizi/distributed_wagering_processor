import { DomainError } from "../../../shared/domain/domain-error.ts";
import { CurrencyMismatchError, Money, type MoneyProps } from "../../../shared/domain/money.ts";
import { InboxMessage } from "../../../shared/messaging/inbox-message.ts";
import { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import { WalletPlayerMismatchError } from "../../domain/errors.ts";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.ts";
import { FailureCode } from "../../domain/failure-code.ts";
import { evaluateReference } from "../../domain/reference-policy.ts";
import type { ReferenceResolutionPolicy } from "../../domain/reference-resolution-policy.ts";
import { type SettlementOutcome, settle } from "../../domain/settlement.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction-kind.ts";
import type { Wallet } from "../../domain/wallet.ts";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.ts";
import { WalletNotFoundError } from "../errors.ts";
import { eventContext } from "../event-context.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import { LockTimeoutError, UniqueViolationError } from "../ports/persistence-errors.ts";
import type { EntryChannel, WageringTelemetry } from "../ports/telemetry.ts";
import type { TransactionScope, UnitOfWork } from "../ports/unit-of-work.ts";

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
    code: FailureCode.IdempotencyKeyConflict | FailureCode.ExternalIdConflict,
    readonly existingTransactionId: string,
  ) {
    super(
      code,
      code === FailureCode.IdempotencyKeyConflict
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
}

/**
 * Caso de uso único para HTTP e SQS (CHALLENGE §10). Tudo acontece numa transação SQL com a wallet
 * travada (ADR 0003): idempotência, regras, ledger, saldo, outbox e inbox são confirmados juntos
 * ou nada é (CHALLENGE §11).
 */
export class SubmitWagerTransaction {
  constructor(private readonly deps: SubmitWagerTransactionDeps) {}

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
    const { uow, clock, ids } = this.deps;
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

    return uow.transactional(
      async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(candidate.walletId);
        assertWalletAccepts(wallet, candidate);

        const existing = await scope.transactions.findByIdempotencyKey(
          candidate.providerId,
          candidate.idempotencyKey,
        );
        if (existing) {
          if (!existing.matchesPayload(candidate.payloadHash)) {
            throw new IdempotencyConflictError(FailureCode.IdempotencyKeyConflict, existing.id);
          }
          this.recordInbox(scope, command, now);
          return this.replay(scope, existing, wallet, now);
        }
        const sameExternalId = await scope.transactions.findByExternalId(
          candidate.providerId,
          candidate.externalTransactionId,
        );
        if (sameExternalId) {
          throw new IdempotencyConflictError(FailureCode.ExternalIdConflict, sameExternalId.id);
        }

        const outcome = await this.settleAndStage(scope, candidate, wallet, now, "add");
        this.recordInbox(scope, command, now);
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
    const reference = await this.findReference(scope, existing);
    if (!reference || evaluateReference(existing, reference).outcome === "wait") {
      return toResult(existing, wallet, existing.status, true, "replayed");
    }
    const outcome = await this.settleAndStage(scope, existing, wallet, now, "save", reference);
    return toResult(existing, wallet, outcome.status, true, "resolved");
  }

  /**
   * Aplica as regras e registra no scope tudo o que o resultado exige: transação, lançamento, saldo,
   * eventos e o reagendamento de quem esperava por esta transação.
   */
  private async settleAndStage(
    scope: TransactionScope,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    mode: "add" | "save",
    preloadedReference?: Awaited<ReturnType<SubmitWagerTransaction["findReference"]>>,
  ): Promise<SettlementOutcome> {
    const reference = preloadedReference ?? (await this.findReference(scope, tx));
    const outcome = settle({
      transaction: tx,
      wallet,
      reference,
      resolutionPolicy: this.deps.resolutionPolicy,
      ledgerEntryId: this.deps.ids.next(),
      at: now,
    });

    if (mode === "add") scope.transactions.add(tx);
    else scope.transactions.save(tx);

    const ledgerEntry =
      outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry) {
      scope.ledger.append(ledgerEntry);
      scope.wallets.save(wallet);
    }
    this.stageEvents(scope, tx, wallet, ledgerEntry, now);

    if (tx.isTerminal()) {
      await scope.transactions.rescheduleWaitingOn(tx.providerId, tx.externalTransactionId, now);
    }
    return outcome;
  }

  private stageEvents(
    scope: TransactionScope,
    tx: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    now: Date,
  ): void {
    const ctx = () => eventContext(this.deps.ids, tx.correlationId, tx.id, now);
    const enqueue = (event: Parameters<typeof OutboxMessage.enqueue>[0]) =>
      scope.outbox.add(OutboxMessage.enqueue(event));
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        enqueue(WagerTransactionProcessed.from(tx, ctx()));
        if (ledgerEntry) enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        enqueue(WagerTransactionRejected.from(tx, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        enqueue(WagerTransactionPendingReference.from(tx, ctx()));
        break;
    }
  }

  private findReference(scope: TransactionScope, tx: WagerTransaction) {
    return tx.referenceExternalTransactionId === undefined
      ? Promise.resolve(undefined)
      : scope.transactions.findReference(tx.providerId, tx.referenceExternalTransactionId);
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
