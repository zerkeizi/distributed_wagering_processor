import { DomainError } from "../../shared/domain/domain-error.ts";
import { FailureCode } from "./failure-code.ts";
import type { WagerTransactionStatus } from "./wager-transaction-kind.ts";

/** Dados de entrada que violam o contrato: o provider precisa corrigir antes de reenviar. */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    override readonly code:
      | FailureCode.InvalidPayload
      | FailureCode.UnsupportedKind
      | FailureCode.ReferenceRequired,
    message: string,
  ) {
    super(code, message);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.InsufficientFunds, `Wallet ${walletId} has insufficient funds`);
  }
}

export class WalletPlayerMismatchError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.WalletPlayerMismatch, `Wallet ${walletId} does not belong to this player`);
  }
}

/**
 * Tentativa de transicionar uma transação terminal ou de um estado que não permite a transição.
 * É erro de programação, não caminho de negócio (CHALLENGE §6.3).
 */
export class InvalidTransactionStateError extends Error {
  readonly code = FailureCode.InternalInvariantViolation;

  constructor(transactionId: string, from: WagerTransactionStatus, attempted: string) {
    super(`Transaction ${transactionId} cannot ${attempted} from status ${from}`);
    this.name = "InvalidTransactionStateError";
  }
}
