import { InvariantViolationError } from "../../../shared/domain/domain-error.ts";
import type { MoneyProps } from "../../../shared/domain/money.ts";
import {
  type EventContext,
  IntegrationEvent,
} from "../../../shared/messaging/integration-event.ts";
import type { LedgerDirection } from "../wager-transaction-kind.ts";
import type { Wallet } from "../wallet.ts";
import type { WalletLedgerEntry } from "../wallet-ledger-entry.ts";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda: um evento por ledger entry (CHALLENGE §11). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError(`ledger entry ${entry.id} is not from wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
