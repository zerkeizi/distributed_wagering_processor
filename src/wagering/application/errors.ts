import { DomainError } from "../../shared/domain/domain-error.ts";
import { ErrorCode } from "../domain/error-code.ts";

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(ErrorCode.WalletNotFound, `Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(currency: string) {
    super(ErrorCode.WalletAlreadyExists, `Player already has a ${currency} wallet`);
  }
}

/** Entrada que viola o contrato da API (formato, campos obrigatórios, cursor inválido). */
export class InvalidRequestError extends DomainError {
  constructor(
    message: string,
    readonly details: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    super(ErrorCode.InvalidPayload, message);
  }
}
