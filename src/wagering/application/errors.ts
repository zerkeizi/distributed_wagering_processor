import { DomainError } from "../../shared/domain/domain-error.ts";
import { FailureCode } from "../domain/failure-code.ts";

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.WalletNotFound, `Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(currency: string) {
    super(FailureCode.WalletAlreadyExists, `Player already has a ${currency} wallet`);
  }
}

/** Entrada que viola o contrato da API (formato, campos obrigatórios, cursor inválido). */
export class InvalidRequestError extends DomainError {
  constructor(
    message: string,
    readonly details: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    super(FailureCode.InvalidPayload, message);
  }
}
