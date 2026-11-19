import type { KeyedMutex } from "../../../shared/concurrency/keyed-mutex.ts";
import { FailureCode } from "../../domain/failure-code.ts";
import type { ReferenceResolutionPolicy } from "../../domain/reference-resolution-policy.ts";
import { WagerTransactionStatus } from "../../domain/wager-transaction-kind.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import {
  LockTimeoutError,
  PersistenceBusyError,
  PersistenceUnavailableError,
} from "../ports/persistence-errors.ts";
import type { WageringTelemetry } from "../ports/telemetry.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { TransactionSettler } from "../transaction-settler.ts";

export interface ResolvePendingReferencesDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telemetry: WageringTelemetry;
  readonly resolutionPolicy: ReferenceResolutionPolicy;
  readonly walletLockTimeoutMs: number;
  readonly walletMutex: KeyedMutex;
  readonly batchSize: number;
  readonly onFailure?: (transactionId: string, error: unknown) => void;
}

export interface ResolutionTickResult {
  readonly examined: number;
  readonly resolved: number;
  readonly stillPending: number;
  readonly failed: number;
}

/**
 * Worker agendado de referências fora de ordem (CHALLENGE §7.1). Para cada pendente vencida:
 * trava a wallet, relê a transação (outra instância pode ter chegado antes) e aplica as mesmas regras
 * da submissão. Reference ausente → nova tentativa com backoff, ou REJECTED REFERENCE_NOT_FOUND ao
 * esgotar. Erro permanente que não é de negócio → FAILED (ADR 0011).
 *
 * Ordem de lock igual à da submissão (wallet → transação): nenhum deadlock entre as duas.
 */
export class ResolvePendingReferences {
  private readonly settler: TransactionSettler;

  constructor(private readonly deps: ResolvePendingReferencesDeps) {
    this.settler = new TransactionSettler(deps.ids, deps.resolutionPolicy);
  }

  async tick(): Promise<ResolutionTickResult> {
    const { uow, clock } = this.deps;
    const due = await uow.read((s) =>
      s.transactions.findDueForResolution(clock.now(), this.deps.batchSize),
    );
    let resolved = 0;
    let stillPending = 0;
    let failed = 0;
    for (const candidate of due) {
      try {
        const status = await this.resolveOne(candidate.id, candidate.walletId);
        if (status === WagerTransactionStatus.PendingReference) stillPending++;
        else if (status !== undefined) resolved++;
      } catch (error) {
        if (
          error instanceof LockTimeoutError ||
          error instanceof PersistenceUnavailableError ||
          error instanceof PersistenceBusyError
        ) {
          continue; // transitório: continua vencida, a próxima rodada tenta de novo
        }
        this.deps.onFailure?.(candidate.id, error);
        await this.markFailed(candidate.id, candidate.walletId);
        failed++;
      }
    }
    return { examined: due.length, resolved, stillPending, failed };
  }

  /** @returns o novo status, ou `undefined` se outra instância já tratou esta transação. */
  private resolveOne(transactionId: string, walletId: string) {
    return this.inWalletQueue(walletId, () => this.resolveLocked(transactionId, walletId));
  }

  private resolveLocked(transactionId: string, walletId: string) {
    const { uow, clock, telemetry } = this.deps;
    return uow.transactional(
      async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(walletId);
        const tx = await scope.transactions.findById(transactionId);
        const now = clock.now();
        if (
          !wallet ||
          !tx ||
          tx.status !== WagerTransactionStatus.PendingReference ||
          (tx.nextResolutionAt && tx.nextResolutionAt.getTime() > now.getTime())
        ) {
          return undefined;
        }
        await this.settler.settleAndStage(scope, tx, wallet, now, "save");
        if (tx.status === WagerTransactionStatus.PendingReference) {
          telemetry.retryScheduled("pending_reference_worker");
        } else {
          telemetry.transactionCompleted(tx.kind, tx.status, "worker");
        }
        return tx.status;
      },
      { lockTimeoutMs: this.deps.walletLockTimeoutMs },
    );
  }

  /** Transação separada: a que falhou sofreu rollback. FAILED é terminal e auditável. */
  private markFailed(transactionId: string, walletId: string): Promise<void> {
    return this.inWalletQueue(walletId, () => this.markFailedLocked(transactionId, walletId));
  }

  /** Mesma fila por wallet da submissão: o worker também não segura conexão esperando lock. */
  private inWalletQueue<T>(walletId: string, task: () => Promise<T>): Promise<T> {
    return this.deps.walletMutex.run(
      walletId,
      this.deps.walletLockTimeoutMs,
      () => new LockTimeoutError(),
      task,
    );
  }

  private async markFailedLocked(transactionId: string, walletId: string): Promise<void> {
    const { uow, clock, telemetry } = this.deps;
    await uow.transactional(
      async (scope) => {
        await scope.wallets.findByIdForUpdate(walletId);
        const tx = await scope.transactions.findById(transactionId);
        if (!tx || tx.isTerminal()) return;
        tx.fail(FailureCode.InternalInvariantViolation, clock.now());
        scope.transactions.save(tx);
        telemetry.transactionCompleted(tx.kind, tx.status, "worker");
      },
      { lockTimeoutMs: this.deps.walletLockTimeoutMs },
    );
  }
}
