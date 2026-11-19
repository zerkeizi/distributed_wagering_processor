/**
 * Todos os valores possíveis de `error.code` no envelope de erro da API (ADR 0010). São erros da
 * REQUISIÇÃO: nada é persistido como wager transaction. O provider decide pelo grupo:
 */
export enum ErrorCode {
  // Corrigir a requisição — reenviar igual dá o mesmo erro.
  InvalidPayload = "INVALID_PAYLOAD",
  UnsupportedKind = "UNSUPPORTED_KIND",
  ReferenceRequired = "REFERENCE_REQUIRED",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  PayloadTooLarge = "PAYLOAD_TOO_LARGE",

  // Recurso inexistente ou já existente.
  WalletNotFound = "WALLET_NOT_FOUND",
  TransactionNotFound = "TRANSACTION_NOT_FOUND",
  RouteNotFound = "ROUTE_NOT_FOUND",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",

  // Conflito de idempotência (ADR 0008) — nunca é replay.
  IdempotencyKeyConflict = "IDEMPOTENCY_KEY_CONFLICT",
  ExternalIdConflict = "EXTERNAL_ID_CONFLICT",

  // Autorização (ADR 0005; inativo enquanto não houver IdP).
  Forbidden = "FORBIDDEN",

  // Transitório — reenviar a MESMA requisição (mesma Idempotency-Key), respeitando Retry-After.
  TemporarilyUnavailable = "TEMPORARILY_UNAVAILABLE",
  LockTimeout = "LOCK_TIMEOUT",

  // Bug: sem detalhes na resposta, stack só no log.
  InternalError = "INTERNAL_ERROR",
}
