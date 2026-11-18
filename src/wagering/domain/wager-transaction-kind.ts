export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca submetido por provider (ADR 0015). */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. Existe só em memória dentro da transação SQL (ADR 0004). */
  Pending = "PENDING",
  /** Aguardando a reference chegar; reprocessada pelo worker (CHALLENGE §7.1). */
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export const PROVIDER_SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];
