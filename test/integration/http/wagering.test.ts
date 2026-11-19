import { describe, expect, test } from "bun:test";
import { useTestApp } from "../support/http-app.ts";
import { assertLedgerConsistent } from "../support/ledger-consistency.ts";
import {
  balanceOf,
  createWallet,
  submitWager,
  uuid,
  wagerBody,
} from "../support/wagering-client.ts";

const app = useTestApp();

async function eventsOf(walletId: string): Promise<string[]> {
  const rows = await app().db.sql<{ event_type: string }>(
    "select event_type from outbox_message where aggregate_id = ? order by occurred_at, event_type",
    [walletId],
  );
  return rows.map((r) => r.event_type);
}

describe("POST /wagering/transactions — BET", () => {
  test("201 PROCESSED com o contrato do CHALLENGE §9", async () => {
    const w = await createWallet(app(), "1000.00");
    const res = await submitWager(app(), w, { kind: "BET", amount: "25.00" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      failureCode: null,
      idempotentReplay: false,
    });
    expect(await eventsOf(w.walletId)).toEqual([
      "WagerTransactionProcessed", // OPENING
      "WalletBalanceChanged",
      "WagerTransactionProcessed", // BET
      "WalletBalanceChanged",
    ]);
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("sem saldo → 422 REJECTED INSUFFICIENT_FUNDS, persistido e auditável, sem lançamento", async () => {
    const w = await createWallet(app(), "10.00");
    const res = await submitWager(app(), w, { kind: "BET", amount: "10.01" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const stored = await app().request("GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    expect(await eventsOf(w.walletId)).toContain("WagerTransactionRejected");
    await assertLedgerConsistent(app().db, w.walletId);
  });
});

describe("idempotência (CHALLENGE §9)", () => {
  test("requisição idêntica → mesma resposta com idempotentReplay: true e o saldo ORIGINAL", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = wagerBody(w, { kind: "BET", amount: "30.00" });
    const send = () =>
      app().request("POST", "/wagering/transactions", {
        body: bet.body,
        headers: { "idempotency-key": bet.idempotencyKey },
      });
    const first = await send();
    // O saldo muda depois da primeira resposta...
    await submitWager(app(), w, { kind: "BET", amount: "50.00" });
    const replay = await send();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    // ...mas o replay devolve o saldo observado naquele momento (CHALLENGE §7.7).
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe("70.00");
    expect(await balanceOf(app(), w.walletId)).toBe("20.00");
  });

  test("replay de uma rejeição continua 422 com o mesmo corpo", async () => {
    const w = await createWallet(app(), "1.00");
    const bet = wagerBody(w, { kind: "BET", amount: "5.00" });
    const send = () =>
      app().request("POST", "/wagering/transactions", {
        body: bet.body,
        headers: { "idempotency-key": bet.idempotencyKey },
      });
    const first = await send();
    const again = await send();
    expect([first.status, again.status]).toEqual([422, 422]);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("mesma key com payload diferente → 409 IDEMPOTENCY_KEY_CONFLICT, não replay", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = wagerBody(w, { kind: "BET", amount: "10.00" });
    await app().request("POST", "/wagering/transactions", {
      body: bet.body,
      headers: { "idempotency-key": bet.idempotencyKey },
    });
    const tampered = await app().request("POST", "/wagering/transactions", {
      body: { ...bet.body, money: { amount: "99.00", currency: "BRL" } },
      headers: { "idempotency-key": bet.idempotencyKey },
    });
    expect(tampered.status).toBe(409);
    expect(tampered.body.error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await balanceOf(app(), w.walletId)).toBe("90.00");
  });

  test("mesmo externalTransactionId com outra key → 409 EXTERNAL_ID_CONFLICT", async () => {
    const w = await createWallet(app(), "100.00");
    const first = await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    const res = await submitWager(app(), w, {
      kind: "BET",
      amount: "10.00",
      externalTransactionId: first.externalTransactionId,
      idempotencyKey: `another-key-${uuid()}`,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EXTERNAL_ID_CONFLICT");
    expect(await balanceOf(app(), w.walletId)).toBe("90.00");
  });

  test("headers e metadados não entram no hash: outro X-Correlation-Id é replay", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = wagerBody(w, { kind: "BET", amount: "1.00" });
    const send = (corr: string) =>
      app().request("POST", "/wagering/transactions", {
        body: bet.body,
        headers: { "idempotency-key": bet.idempotencyKey, "x-correlation-id": corr },
      });
    await send("a");
    const replay = await send("b");
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("Idempotency-Key ausente → 400", async () => {
    const w = await createWallet(app());
    const res = await app().request("POST", "/wagering/transactions", {
      body: wagerBody(w, { kind: "BET", amount: "1.00" }).body,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("Idempotency-Key");
  });
});

describe("WIN / LOSS", () => {
  test("WIN com referência à BET: credita e vincula o id interno", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    const win = await submitWager(app(), w, {
      kind: "WIN",
      amount: "35.00",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(win.status).toBe(201);
    expect(win.body.balance.amount).toBe("125.00");
    const stored = await app().request("GET", `/wagering/transactions/${win.body.transactionId}`);
    expect(stored.body.referenceTransactionId).toBe(bet.body.transactionId);
  });

  test("LOSS: PROCESSED sem mover saldo e sem lançamento, mas com evento Processed", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    const before = await eventsOf(w.walletId);
    const loss = await submitWager(app(), w, {
      kind: "LOSS",
      amount: "0.00",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
    expect((await eventsOf(w.walletId)).slice(before.length)).toEqual([
      "WagerTransactionProcessed",
    ]);
    const entries = await app().db.sql(
      "select 1 from wallet_ledger_entry where transaction_id = ?",
      [loss.body.transactionId],
    );
    expect(entries).toHaveLength(0);
  });
});

describe("REFUND / ROLLBACK", () => {
  test("REFUND devolve a BET uma única vez; segundo reversal → 422 REFERENCE_ALREADY_REVERSED", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = await submitWager(app(), w, { kind: "BET", amount: "40.00" });
    const refund = await submitWager(app(), w, {
      kind: "REFUND",
      amount: "40.00",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe("100.00");
    const rollback = await submitWager(app(), w, {
      kind: "ROLLBACK",
      amount: "40.00",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balanceOf(app(), w.walletId)).toBe("100.00");
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("ROLLBACK de WIN sem saldo → 422 REVERSAL_INSUFFICIENT_FUNDS (≠ aposta sem saldo)", async () => {
    const w = await createWallet(app(), "10.00");
    const bet = await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    const win = await submitWager(app(), w, {
      kind: "WIN",
      amount: "50.00",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submitWager(app(), w, { kind: "BET", amount: "45.00" });
    const rollback = await submitWager(app(), w, {
      kind: "ROLLBACK",
      amount: "50.00",
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    expect(await balanceOf(app(), w.walletId)).toBe("5.00");
  });

  test.each([
    ["valor diferente", { amount: "39.99" }, "AMOUNT_MISMATCH"],
    ["outra rodada", { roundId: "round-other" }, "REFERENCE_MISMATCH"],
  ])("REFUND com %s → 422 %s", async (_, override, code) => {
    const w = await createWallet(app(), "100.00");
    const bet = await submitWager(app(), w, { kind: "BET", amount: "40.00" });
    const res = await submitWager(app(), w, {
      kind: "REFUND",
      amount: "40.00",
      referenceExternalTransactionId: bet.externalTransactionId,
      ...override,
    });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe(code);
  });

  test("referência de outro provider não é encontrada (resolução é por provider)", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = await submitWager(app(), w, {
      kind: "BET",
      amount: "10.00",
      providerId: "provider-a",
    });
    const refund = await submitWager(app(), w, {
      kind: "REFUND",
      amount: "10.00",
      providerId: "provider-b",
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");
  });
});

describe("referência fora de ordem (CHALLENGE §7.1, ADR 0012)", () => {
  test("ROLLBACK antes da BET → 202 PENDING_REFERENCE, sem mexer no saldo", async () => {
    const w = await createWallet(app(), "100.00");
    const res = await submitWager(app(), w, {
      kind: "ROLLBACK",
      amount: "10.00",
      referenceExternalTransactionId: `late-bet-${uuid()}`,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "PENDING_REFERENCE",
      failureCode: null,
      balance: { amount: "100.00" },
    });
    expect(await eventsOf(w.walletId)).toContain("WagerTransactionPendingReference");
  });

  test("BET chega depois: dependente é reagendada para agora; reenvio do ROLLBACK resolve (201)", async () => {
    const w = await createWallet(app(), "100.00");
    const betExt = `late-bet-${uuid()}`;
    const rollback = wagerBody(w, {
      kind: "ROLLBACK",
      amount: "10.00",
      referenceExternalTransactionId: betExt,
    });
    const send = () =>
      app().request("POST", "/wagering/transactions", {
        body: rollback.body,
        headers: { "idempotency-key": rollback.idempotencyKey },
      });
    const pending = await send();
    expect(pending.status).toBe(202);

    // Reenvio antes da BET: continua pendente e NÃO consome tentativas do worker.
    const stillPending = await send();
    expect(stillPending.status).toBe(202);
    expect(stillPending.body.idempotentReplay).toBe(true);
    const [tx] = await app().db.sql<{ resolution_attempts: number; next: Date }>(
      "select resolution_attempts, next_resolution_at as next from wager_transaction where id = ?",
      [pending.body.transactionId],
    );
    expect(tx?.resolution_attempts).toBe(1);

    const bet = await submitWager(app(), w, {
      kind: "BET",
      amount: "10.00",
      externalTransactionId: betExt,
    });
    expect(bet.status).toBe(201);
    const [after] = await app().db.sql<{ next: Date }>(
      "select next_resolution_at as next from wager_transaction where id = ?",
      [pending.body.transactionId],
    );
    expect(new Date(after?.next ?? 0).getTime()).toBeLessThan(new Date(tx?.next ?? 0).getTime());

    const resolved = await send();
    expect(resolved.status).toBe(201);
    expect(resolved.body).toMatchObject({
      transactionId: pending.body.transactionId,
      status: "PROCESSED",
      idempotentReplay: true,
      balance: { amount: "100.00" },
    });
    await assertLedgerConsistent(app().db, w.walletId);
  });
});

describe("validação e wallet (ADR 0007)", () => {
  test("OPENING não pode ser submetido → 400 UNSUPPORTED_KIND", async () => {
    const w = await createWallet(app());
    const res = await submitWager(app(), w, { kind: "OPENING", amount: "1.00" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_KIND");
  });

  test("REFUND sem referência → 400 REFERENCE_REQUIRED", async () => {
    const w = await createWallet(app());
    const res = await submitWager(app(), w, { kind: "REFUND", amount: "1.00" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REFERENCE_REQUIRED");
  });

  test("wallet inexistente → 404 e nada é persistido", async () => {
    const res = await submitWager(
      app(),
      { walletId: uuid(), playerId: uuid() },
      { kind: "BET", amount: "1.00" },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
    const rows = await app().db.sql(
      "select 1 from wager_transaction where external_transaction_id = ?",
      [res.externalTransactionId],
    );
    expect(rows).toHaveLength(0);
  });

  test("player que não é dono da wallet → 422 WALLET_PLAYER_MISMATCH", async () => {
    const w = await createWallet(app());
    const res = await submitWager(app(), w, { kind: "BET", amount: "1.00", playerId: uuid() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("WALLET_PLAYER_MISMATCH");
  });

  test("moeda diferente da wallet → 422 CURRENCY_MISMATCH", async () => {
    const w = await createWallet(app(), "100.00", "BRL");
    const res = await submitWager(app(), w, { kind: "BET", amount: "1.00", currency: "USD" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CURRENCY_MISMATCH");
  });

  test("provider com prefixo reservado → 400", async () => {
    const w = await createWallet(app());
    const res = await submitWager(app(), w, {
      kind: "BET",
      amount: "1.00",
      providerId: "__system__",
    });
    expect(res.status).toBe(400);
  });
});

describe("consultas", () => {
  test("GET por id interno e por (provider, id externo) devolvem a mesma transação", async () => {
    const w = await createWallet(app());
    const bet = await submitWager(app(), w, { kind: "BET", amount: "5.00" });
    const byId = await app().request("GET", `/wagering/transactions/${bet.body.transactionId}`);
    const byExt = await app().request(
      "GET",
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byExt.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      kind: "BET",
      status: "PROCESSED",
      money: { amount: "5.00" },
    });
  });

  test("inexistente → 404 TRANSACTION_NOT_FOUND", async () => {
    const res = await app().request("GET", `/wagering/transactions/${uuid()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TRANSACTION_NOT_FOUND");
  });
});
