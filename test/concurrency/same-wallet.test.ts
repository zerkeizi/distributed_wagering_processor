import { describe, expect, test } from "bun:test";
import { useTestApp } from "../integration/support/http-app.ts";
import {
  assertLedgerConsistent,
  ledgerConsistency,
} from "../integration/support/ledger-consistency.ts";
import {
  balanceOf,
  createWallet,
  submitWager,
  uuid,
  wagerBody,
} from "../integration/support/wagering-client.ts";

/**
 * Paralelismo real (CHALLENGE §13 "Concorrência"): as requisições saem todas ao mesmo tempo com
 * Promise.all contra o servidor HTTP, e cada uma abre sua própria conexão e transação no Postgres.
 * Nada é sequencial nem mockado — a disputa pelo lock da wallet acontece de verdade no banco.
 */
const app = useTestApp({ WALLET_LOCK_TIMEOUT_MS: "15000" });

const debits = async (walletId: string) =>
  (
    await app().db.sql<{ n: string }>(
      "select count(*)::text as n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'",
      [walletId],
    )
  )[0]?.n;

describe("concorrência na mesma wallet", () => {
  test("cenário 1: a mesma BET enviada 50 vezes em paralelo → um único débito", async () => {
    const w = await createWallet(app(), "100.00");
    const bet = wagerBody(w, { kind: "BET", amount: "25.00" });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        app().request("POST", "/wagering/transactions", {
          body: bet.body,
          headers: { "idempotency-key": bet.idempotencyKey },
        }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    // Todas as respostas falam da mesma transação e do mesmo saldo observado.
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.balance.amount))).toEqual(new Set(["75.00"]));
    expect(await debits(w.walletId)).toBe("1");
    expect(await balanceOf(app(), w.walletId)).toBe("75.00");
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("cenário 2 (CHALLENGE §8): saldo 100, duas BETs de 80 simultâneas — repetido em 20 wallets", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(app(), "100.00")),
    );
    await Promise.all(
      wallets.map(async (w) => {
        const [a, b] = await Promise.all([
          submitWager(app(), w, { kind: "BET", amount: "80.00" }),
          submitWager(app(), w, { kind: "BET", amount: "80.00" }),
        ]);
        const outcomes = [a, b].map((r) => `${r.status}:${r.body.status}:${r.body.failureCode}`);
        expect(outcomes.sort()).toEqual(["201:PROCESSED:null", "422:REJECTED:INSUFFICIENT_FUNDS"]);
        expect(await balanceOf(app(), w.walletId)).toBe("20.00");
        expect(await debits(w.walletId)).toBe("1");
        await assertLedgerConsistent(app().db, w.walletId);
      }),
    );
  });

  test("nenhum retry duplica o débito: reenviar as duas BETs depois devolve os resultados originais", async () => {
    const w = await createWallet(app(), "100.00");
    const a = wagerBody(w, { kind: "BET", amount: "80.00" });
    const b = wagerBody(w, { kind: "BET", amount: "80.00" });
    const send = (x: typeof a) =>
      app().request("POST", "/wagering/transactions", {
        body: x.body,
        headers: { "idempotency-key": x.idempotencyKey },
      });
    const first = await Promise.all([send(a), send(b)]);
    const retries = await Promise.all([send(a), send(b), send(a), send(b)]);
    expect(retries.every((r) => r.body.idempotentReplay)).toBe(true);
    expect(retries.map((r) => r.body.status)).toEqual([
      first[0]?.body.status,
      first[1]?.body.status,
      first[0]?.body.status,
      first[1]?.body.status,
    ]);
    expect(await debits(w.walletId)).toBe("1");
    expect(await balanceOf(app(), w.walletId)).toBe("20.00");
  });

  test("hot wallet: 100 BETs distintas de 1.00 sobre 50.00 → exatamente 50 aplicadas, saldo 0.00", async () => {
    const w = await createWallet(app(), "50.00");
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => submitWager(app(), w, { kind: "BET", amount: "1.00" })),
    );
    const processed = responses.filter((r) => r.body.status === "PROCESSED");
    const rejected = responses.filter((r) => r.body.failureCode === "INSUFFICIENT_FUNDS");
    expect(processed).toHaveLength(50);
    expect(rejected).toHaveLength(50);
    expect(await balanceOf(app(), w.walletId)).toBe("0.00");
    const c = await ledgerConsistency(app().db, w.walletId);
    expect(c).toMatchObject({ entries: 51, version: 51, chainBreaks: 0 });
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("REFUND e ROLLBACK da mesma BET em paralelo: só um reversal é aplicado (ADR 0006)", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(app(), "100.00")),
    );
    await Promise.all(
      wallets.map(async (w) => {
        const bet = await submitWager(app(), w, { kind: "BET", amount: "30.00" });
        const reversals = await Promise.all(
          ["REFUND", "ROLLBACK", "REFUND", "ROLLBACK"].map((kind) =>
            submitWager(app(), w, {
              kind,
              amount: "30.00",
              referenceExternalTransactionId: bet.externalTransactionId,
            }),
          ),
        );
        expect(reversals.filter((r) => r.body.status === "PROCESSED")).toHaveLength(1);
        expect(
          reversals.filter((r) => r.body.failureCode === "REFERENCE_ALREADY_REVERSED"),
        ).toHaveLength(3);
        expect(await balanceOf(app(), w.walletId)).toBe("100.00");
        await assertLedgerConsistent(app().db, w.walletId);
      }),
    );
  });

  test("mesma key em wallets diferentes ao mesmo tempo: um vence, o outro é conflito (nunca 500)", async () => {
    const providerId = `provider-${uuid()}`;
    const ext = `tx-${uuid()}`;
    for (let round = 0; round < 10; round++) {
      const [w1, w2] = await Promise.all([createWallet(app()), createWallet(app())]);
      const key = `${providerId}:${ext}:${round}`;
      const make = (w: typeof w1) =>
        wagerBody(w, {
          kind: "BET",
          amount: "1.00",
          providerId,
          externalTransactionId: `${ext}-${round}`,
          idempotencyKey: key,
        });
      const [r1, r2] = await Promise.all(
        [make(w1), make(w2)].map((x) =>
          app().request("POST", "/wagering/transactions", {
            body: x.body,
            headers: { "idempotency-key": x.idempotencyKey },
          }),
        ),
      );
      expect([r1?.status, r2?.status].sort()).toEqual([201, 409]);
    }
  });
});
