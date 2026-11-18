import { ExponentialBackoff } from "../../../../src/shared/domain/exponential-backoff.ts";
import { Money } from "../../../../src/shared/domain/money.ts";
import { ReferenceResolutionPolicy } from "../../../../src/wagering/domain/reference-resolution-policy.ts";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import { Wallet } from "../../../../src/wagering/domain/wallet.ts";

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER_ID = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
export const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";
export const PROVIDER_ID = "provider-a";
export const ROUND_ID = "round-987";

let sequence = 0;
/** Ids determinísticos e legíveis nos testes. */
export function nextId(prefix = "id"): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export function openWallet(initial = "100.00", currency = "BRL"): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: initial, currency }),
    openingTransactionId: nextId("opening"),
    openingEntryId: nextId("entry"),
    at: T0,
  }).wallet;
}

/** Wager transaction válida com defaults; cada teste sobrescreve só o que importa. */
export function wager(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  return WagerTransaction.create({
    id: nextId("tx"),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${overrides.providerId ?? PROVIDER_ID}:${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: "fortune-chimp",
    kind,
    money: brl("10.00"),
    referenceExternalTransactionId: undefined,
    correlationId: "corr-1",
    at: T0,
    ...overrides,
  });
}

/** Uma BET já processada sobre a wallet, como estaria no banco. */
export function processedBet(wallet: Wallet, amount = "10.00"): WagerTransaction {
  const bet = wager(WagerTransactionKind.Bet, { money: brl(amount) });
  wallet.debit({ entryId: nextId("entry"), transactionId: bet.id, money: bet.money, at: T0 });
  bet.markProcessed(undefined, T0, wallet.balance);
  return bet;
}

/** Política curta para testes: 2 novas tentativas, 1s → 4s. */
export const shortPolicy = new ReferenceResolutionPolicy(2, new ExponentialBackoff(1_000, 4_000));
