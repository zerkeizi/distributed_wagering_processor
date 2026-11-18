import { InvariantViolationError } from "../../../shared/domain/domain-error.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import {
  type EventContext,
  IntegrationEvent,
} from "../../../shared/messaging/integration-event.ts";
import type { FailureCode } from "../failure-code.ts";
import type { WagerTransaction } from "../wager-transaction.ts";
import { type WagerTransactionKind, WagerTransactionStatus } from "../wager-transaction-kind.ts";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  failureCode: FailureCode;
  rejectedAt: string;
}

/** Transação rejeitada por regra de negócio, inclusive reference que nunca chegou (CHALLENGE §7.1). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || !tx.failureCode) {
      throw new InvariantViolationError(`transaction ${tx.id} is not rejected`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId ?? null,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
        failureCode: tx.failureCode,
        rejectedAt: tx.updatedAt.toISOString(),
      },
    });
  }
}
