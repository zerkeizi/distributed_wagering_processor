import { DomainError } from "../../../shared/domain/domain-error.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import { FailureCode } from "../../domain/failure-code.ts";
import type { WagerTransaction } from "../../domain/wager-transaction.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

export class WagerTransactionNotFoundError extends DomainError {
  constructor(what: string) {
    super(FailureCode.TransactionNotFound, `Wager transaction ${what} not found`);
  }
}

export interface WagerTransactionView {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly balanceAfter: MoneyProps | null;
  readonly resolutionAttempts: number;
  readonly nextResolutionAt: string | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly updatedAt: string;
}

export function toWagerTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfter: tx.balanceAfter?.toJSON() ?? null,
    resolutionAttempts: tx.resolutionAttempts,
    nextResolutionAt: tx.nextResolutionAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
    updatedAt: tx.updatedAt.toISOString(),
  };
}

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.read((s) => s.transactions.findById(transactionId));
    if (!tx) throw new WagerTransactionNotFoundError(transactionId);
    return toWagerTransactionView(tx);
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const tx = await this.uow.read((s) =>
      s.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toWagerTransactionView(tx);
  }
}
