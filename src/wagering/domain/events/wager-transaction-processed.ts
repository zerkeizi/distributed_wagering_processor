import { InvariantViolationError } from "../../../shared/domain/domain-error.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import {
  type EventContext,
  IntegrationEvent,
} from "../../../shared/messaging/integration-event.ts";
import type { WagerTransaction } from "../wager-transaction.ts";
import { type WagerTransactionKind, WagerTransactionStatus } from "../wager-transaction-kind.ts";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (CHALLENGE §11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || !tx.processedAt || !tx.balanceAfter) {
      throw new InvariantViolationError(`transaction ${tx.id} is not processed`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId ?? null,
        gameId: tx.gameId ?? null,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: tx.balanceAfter.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}
