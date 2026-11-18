import { InvariantViolationError } from "../../../shared/domain/domain-error.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import {
  type EventContext,
  IntegrationEvent,
} from "../../../shared/messaging/integration-event.ts";
import type { WagerTransaction } from "../wager-transaction.ts";
import { type WagerTransactionKind, WagerTransactionStatus } from "../wager-transaction-kind.ts";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/**
 * Reference ausente na primeira tentativa. Emitido uma vez, na entrada em PENDING_REFERENCE;
 * novas tentativas agendadas pelo worker não geram evento (seriam ruído para o consumidor).
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !tx.referenceExternalTransactionId ||
      !tx.nextResolutionAt
    ) {
      throw new InvariantViolationError(`transaction ${tx.id} is not pending a reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextResolutionAt.toISOString(),
      },
    });
  }
}
