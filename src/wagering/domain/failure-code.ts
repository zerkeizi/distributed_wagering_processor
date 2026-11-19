/**
 * Taxonomia estável de falhas (CHALLENGE §7.2, ARCHITECTURE.md). O provider decide o que fazer
 * pela categoria do código, sem interpretar mensagens.
 */
export enum FailureCode {
  // Corrigir o payload — nada é persistido, reenviar igual dá o mesmo erro.
  InvalidPayload = "INVALID_PAYLOAD",
  UnsupportedKind = "UNSUPPORTED_KIND",
  ReferenceRequired = "REFERENCE_REQUIRED",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",
  TransactionNotFound = "TRANSACTION_NOT_FOUND",
  IdempotencyKeyConflict = "IDEMPOTENCY_KEY_CONFLICT",
  ExternalIdConflict = "EXTERNAL_ID_CONFLICT",

  // Rejeição de negócio — a transação fica REJECTED (terminal e auditável).
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",

  // Transitória — reenviar a mesma requisição.
  TemporarilyUnavailable = "TEMPORARILY_UNAVAILABLE",
  LockTimeout = "LOCK_TIMEOUT",

  // Interna — a transação fica FAILED (ADR 0011).
  InternalInvariantViolation = "INTERNAL_INVARIANT_VIOLATION",
}

export type FailureCategory = "invalid-request" | "business-rejection" | "transient" | "internal";

const CATEGORY: Readonly<Record<FailureCode, FailureCategory>> = {
  [FailureCode.InvalidPayload]: "invalid-request",
  [FailureCode.UnsupportedKind]: "invalid-request",
  [FailureCode.ReferenceRequired]: "invalid-request",
  [FailureCode.CurrencyMismatch]: "invalid-request",
  [FailureCode.WalletPlayerMismatch]: "invalid-request",
  [FailureCode.WalletNotFound]: "invalid-request",
  [FailureCode.WalletAlreadyExists]: "invalid-request",
  [FailureCode.TransactionNotFound]: "invalid-request",
  [FailureCode.IdempotencyKeyConflict]: "invalid-request",
  [FailureCode.ExternalIdConflict]: "invalid-request",
  [FailureCode.InsufficientFunds]: "business-rejection",
  [FailureCode.ReversalInsufficientFunds]: "business-rejection",
  [FailureCode.ReferenceNotFound]: "business-rejection",
  [FailureCode.ReferenceMismatch]: "business-rejection",
  [FailureCode.ReferenceKindNotAllowed]: "business-rejection",
  [FailureCode.ReferenceNotProcessed]: "business-rejection",
  [FailureCode.ReferenceAlreadyReversed]: "business-rejection",
  [FailureCode.AmountMismatch]: "business-rejection",
  [FailureCode.TemporarilyUnavailable]: "transient",
  [FailureCode.LockTimeout]: "transient",
  [FailureCode.InternalInvariantViolation]: "internal",
};

export function failureCategory(code: FailureCode): FailureCategory {
  return CATEGORY[code];
}
