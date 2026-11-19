import type { TestApp, TestResponse } from "./http-app.ts";

export const uuid = () => Bun.randomUUIDv7();

export interface TestWallet {
  readonly walletId: string;
  readonly playerId: string;
}

export async function createWallet(
  app: TestApp,
  amount = "100.00",
  currency = "BRL",
): Promise<TestWallet> {
  const playerId = uuid();
  const res = await app.request("POST", "/wallets", {
    body: { playerId, initialBalance: { amount, currency } },
  });
  if (res.status !== 201)
    throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id, playerId };
}

export interface WagerInput {
  readonly kind: string;
  readonly amount: string;
  readonly currency?: string;
  readonly externalTransactionId?: string;
  readonly referenceExternalTransactionId?: string;
  readonly roundId?: string;
  readonly providerId?: string;
  readonly idempotencyKey?: string;
  readonly playerId?: string;
}

/** Monta o corpo do CHALLENGE §9 com defaults; devolve também o externalTransactionId usado. */
export function wagerBody(wallet: TestWallet, input: WagerInput) {
  const providerId = input.providerId ?? "provider-a";
  const externalTransactionId = input.externalTransactionId ?? `tx-${uuid()}`;
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: input.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: input.playerId ?? wallet.playerId,
      walletId: wallet.walletId,
      roundId: input.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind: input.kind,
      money: { amount: input.amount, currency: input.currency ?? "BRL" },
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    },
  };
}

export async function submitWager(
  app: TestApp,
  wallet: TestWallet,
  input: WagerInput,
): Promise<TestResponse & { externalTransactionId: string }> {
  const w = wagerBody(wallet, input);
  const res = await app.request("POST", "/wagering/transactions", {
    body: w.body,
    headers: { "idempotency-key": w.idempotencyKey },
  });
  return { ...res, externalTransactionId: w.externalTransactionId };
}

export async function balanceOf(app: TestApp, walletId: string): Promise<string> {
  return (await app.request("GET", `/wallets/${walletId}`)).body.balance.amount;
}
