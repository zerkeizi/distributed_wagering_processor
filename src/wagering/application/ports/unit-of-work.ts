import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "./repositories.ts";

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface TransactionOptions {
  /** Tempo máximo esperando lock de linha antes de falhar com LockTimeoutError (ADR 0003). */
  readonly lockTimeoutMs?: number;
  /**
   * `snapshot`: REPEATABLE READ read-only — todas as leituras enxergam o mesmo instante do banco,
   * sem travar nada (usado pela reconciliação). Default: READ COMMITTED.
   */
  readonly isolation?: "read-committed" | "snapshot";
}

/**
 * Fronteira transacional: tudo que o `work` registrar nos repositórios é confirmado junto no
 * commit, ou nada é (CHALLENGE §6.5, §11). Se `work` lançar, a transação sofre rollback.
 */
export interface UnitOfWork {
  transactional<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  /** Leituras fora de transação explícita (consultas). Escritas registradas aqui são descartadas. */
  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}
