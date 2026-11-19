import { Money, type MoneyProps } from "../../../shared/domain/money.ts";
import { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.ts";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction-kind.ts";
import { Wallet } from "../../domain/wallet.ts";
import { WalletAlreadyExistsError } from "../errors.ts";
import { eventContext } from "../event-context.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import { UniqueViolationError } from "../ports/persistence-errors.ts";
import type { WageringTelemetry } from "../ports/telemetry.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { toWalletView, type WalletView } from "../views.ts";

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

/**
 * Abre a wallet. Com saldo inicial > 0, a transação interna OPENING, o lançamento CREDIT e os
 * eventos são gravados na MESMA transação SQL da wallet (CHALLENGE §9, ADR 0015).
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();

    try {
      const view = await this.uow.transactional(async (scope) => {
        const opening = initialBalance.isZero()
          ? undefined
          : WagerTransaction.createOpening({
              id: this.ids.next(),
              walletId,
              playerId: command.playerId,
              money: initialBalance,
              correlationId: command.correlationId,
              at: now,
            });
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: opening?.id ?? walletId,
          openingEntryId: this.ids.next(),
          at: now,
        });
        scope.wallets.add(wallet);

        if (opening && openingEntry) {
          opening.markProcessed(undefined, now, wallet.balance);
          scope.transactions.add(opening);
          scope.ledger.append(openingEntry);
          const ctx = () => eventContext(this.ids, command.correlationId, opening.id, now);
          scope.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())));
          scope.outbox.add(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())),
          );
        }
        return toWalletView(wallet);
      });
      if (!initialBalance.isZero()) {
        this.telemetry.transactionCompleted(
          WagerTransactionKind.Opening,
          WagerTransactionStatus.Processed,
          "http",
        );
      }
      return view;
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraint === "wallet_player_currency_uq"
      ) {
        throw new WalletAlreadyExistsError(initialBalance.currency);
      }
      throw error;
    }
  }
}
