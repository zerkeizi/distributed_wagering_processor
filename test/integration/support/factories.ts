import { Money } from "../../../src/shared/domain/money.ts";
import { OutboxMessage } from "../../../src/shared/messaging/outbox-message.ts";
import { WalletBalanceChanged } from "../../../src/wagering/domain/events/wallet-balance-changed.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import { Wallet } from "../../../src/wagering/domain/wallet.ts";
import type { TestDatabase } from "./database.ts";

export const uuid = () => Bun.randomUUIDv7();
export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

export interface OpenedWallet {
  readonly walletId: string;
  readonly playerId: string;
  readonly openingTransactionId: string | undefined;
}

/**
 * Abre uma wallet direto pelos repositórios (o use case chega no passo 4): wallet, transação OPENING,
 * lançamento e evento na outbox, tudo na mesma transação SQL.
 */
export async function openWalletInDb(
  db: TestDatabase,
  initial = "100.00",
  currency = "BRL",
): Promise<OpenedWallet> {
  const now = new Date();
  const walletId = uuid();
  const playerId = uuid();
  const money = Money.from({ amount: initial, currency });
  const opening = money.isZero()
    ? undefined
    : WagerTransaction.createOpening({
        id: uuid(),
        walletId,
        playerId,
        money,
        correlationId: "test",
        at: now,
      });
  await db.uow.transactional(async (scope) => {
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: money,
      openingTransactionId: opening?.id ?? uuid(),
      openingEntryId: uuid(),
      at: now,
    });
    scope.wallets.add(wallet);
    if (opening && openingEntry) {
      opening.markProcessed(undefined, now, wallet.balance);
      scope.transactions.add(opening);
      scope.ledger.append(openingEntry);
      scope.outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: uuid(),
            correlationId: "test",
            occurredAt: now,
          }),
        ),
      );
    }
  });
  return { walletId, playerId, openingTransactionId: opening?.id };
}
