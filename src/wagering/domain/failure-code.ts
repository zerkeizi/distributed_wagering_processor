/**
 * Resultado de uma wager transaction que não foi aplicada: gravado em `failure_code`, devolvido no
 * corpo `422` e nos eventos (CHALLENGE §7.2). Só existem aqui códigos que podem ser PERSISTIDOS.
 * Erros de requisição (payload inválido, conflito, wallet inexistente, indisponibilidade) nunca viram
 * transação e ficam em `ErrorCode`.
 */
export enum FailureCode {
  // Rejeição de negócio — transação REJECTED (terminal e auditável). Ação do provider: desistir.
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",

  // Falha interna — transação FAILED (ADR 0011). Ação do provider: escalar para suporte.
  InternalInvariantViolation = "INTERNAL_INVARIANT_VIOLATION",
}

export function isBusinessRejection(code: FailureCode): boolean {
  return code !== FailureCode.InternalInvariantViolation;
}
