import { describe, expect, test } from "bun:test";
import { useTestApp } from "../support/http-app.ts";
import { assertLedgerConsistent } from "../support/ledger-consistency.ts";

const app = useTestApp();
const uuid = () => Bun.randomUUIDv7();

async function createWallet(amount = "1000.00", currency = "BRL", playerId = uuid()) {
  const res = await app().request("POST", "/wallets", {
    body: { playerId, initialBalance: { amount, currency } },
  });
  return { res, playerId, walletId: res.body?.id as string };
}

describe("POST /wallets", () => {
  test("201 com o contrato do CHALLENGE §9 e version 1", async () => {
    const { res, playerId } = await createWallet("1000.00");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("saldo inicial > 0: OPENING + lançamento CREDIT + 2 eventos, tudo na mesma transação", async () => {
    const { walletId } = await createWallet("250.75");
    const db = app().db;
    const txs = await db.sql<{ kind: string; provider_id: string; status: string; amount: string }>(
      "select kind, provider_id, status, amount::text from wager_transaction where wallet_id = ?",
      [walletId],
    );
    expect(txs).toEqual([
      { kind: "OPENING", provider_id: "__system__", status: "PROCESSED", amount: "250.75" },
    ]);
    const entries = await db.sql<{ direction: string; wallet_version: number }>(
      "select direction, wallet_version from wallet_ledger_entry where wallet_id = ?",
      [walletId],
    );
    expect(entries).toEqual([{ direction: "CREDIT", wallet_version: 1 }]);
    const events = await db.sql<{ event_type: string }>(
      "select event_type from outbox_message where aggregate_id = ? order by event_type",
      [walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    await assertLedgerConsistent(db, walletId);
  });

  test("saldo inicial zero: sem OPENING, sem lançamento, sem eventos", async () => {
    const { res, walletId } = await createWallet("0.00");
    expect(res.status).toBe(201);
    const [counts] = await app().db.sql<{ txs: string; entries: string; events: string }>(
      `select (select count(*) from wager_transaction where wallet_id = ?)::text as txs,
              (select count(*) from wallet_ledger_entry where wallet_id = ?)::text as entries,
              (select count(*) from outbox_message where aggregate_id = ?)::text as events`,
      [walletId, walletId, walletId],
    );
    expect(counts).toEqual({ txs: "0", entries: "0", events: "0" });
  });

  test("wallet duplicada para o mesmo player + moeda → 409 WALLET_ALREADY_EXISTS", async () => {
    const { playerId } = await createWallet("10.00", "BRL");
    const again = await createWallet("99.00", "BRL", playerId);
    expect(again.res.status).toBe(409);
    expect(again.res.body.error.code).toBe("WALLET_ALREADY_EXISTS");
    // Nada da tentativa duplicada foi gravado: só a primeira wallet existe para o player.
    const wallets = await app().db.sql("select 1 from wallet where player_id = ?", [playerId]);
    expect(wallets).toHaveLength(1);
  });

  test("o mesmo player em outra moeda é outra wallet", async () => {
    const { playerId } = await createWallet("10.00", "BRL");
    const usd = await createWallet("10.00", "USD", playerId);
    expect(usd.res.status).toBe(201);
  });

  test("criação concorrente da mesma wallet: exatamente uma vence", async () => {
    const playerId = uuid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createWallet("100.00", "BRL", playerId)),
    );
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
  });

  test.each([
    ["playerId ausente", { initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["playerId não-UUID", { playerId: "abc", initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["amount como number", { playerId: uuid(), initialBalance: { amount: 10, currency: "BRL" } }],
    [
      "amount com 1 casa",
      { playerId: uuid(), initialBalance: { amount: "10.5", currency: "BRL" } },
    ],
    ["amount negativo", { playerId: uuid(), initialBalance: { amount: "-1.00", currency: "BRL" } }],
    [
      "notação científica",
      { playerId: uuid(), initialBalance: { amount: "1e3", currency: "BRL" } },
    ],
    ["moeda minúscula", { playerId: uuid(), initialBalance: { amount: "1.00", currency: "brl" } }],
    ["initialBalance ausente", { playerId: uuid() }],
  ])("400 INVALID_PAYLOAD: %s", async (_, body) => {
    const res = await app().request("POST", "/wallets", { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("JSON malformado → 400 no mesmo envelope de erro", async () => {
    const res = await app().request("POST", "/wallets", { body: '{"playerId":' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets/:walletId", () => {
  test("200 com saldo atual", async () => {
    const { walletId } = await createWallet("42.00");
    const res = await app().request("GET", `/wallets/${walletId}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual({ amount: "42.00", currency: "BRL" });
  });

  test("404 WALLET_NOT_FOUND para id inexistente; 400 para id que não é UUID", async () => {
    const missing = await app().request("GET", `/wallets/${uuid()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("WALLET_NOT_FOUND");
    const invalid = await app().request("GET", "/wallets/not-a-uuid");
    expect(invalid.status).toBe(400);
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  async function walletWithEntries(extra: number) {
    const { walletId, playerId } = await createWallet("100.00");
    // Lançamentos extras direto pelo banco (o endpoint de apostas chega no passo 5).
    const db = app().db;
    for (let i = 0; i < extra; i++) {
      const v = i + 2;
      const before = (100 - i).toFixed(2);
      const after = (100 - i - 1).toFixed(2);
      const txId = uuid();
      await db.inTransaction(async (exec) => {
        await exec(
          `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
             balance_after, processed_at, correlation_id, created_at, updated_at)
           values (?, 'p', ?, ?, ?, ?, ?, 'BRL', 'r', 'g', 'BET', 1.00, 'PROCESSED', ?, now(), 'c', now(), now())`,
          [txId, txId, txId, "a".repeat(64), walletId, playerId, after],
        );
        await exec(
          `insert into wallet_ledger_entry (id, wallet_id, transaction_id, currency, direction, amount,
             balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'BRL', 'DEBIT', 1.00, ?, ?, ?, now())`,
          [uuid(), walletId, txId, before, after, v],
        );
        await exec("update wallet set balance = ?, version = ? where id = ?", [after, v, walletId]);
      });
    }
    return walletId;
  }

  test("pagina do mais recente para o mais antigo com cursor opaco até o fim", async () => {
    const walletId = await walletWithEntries(4); // 5 lançamentos
    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const res = await app().request("GET", `/wallets/${walletId}/ledger${query}`);
      expect(res.status).toBe(200);
      versions.push(...res.body.items.map((i: { walletVersion: number }) => i.walletVersion));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(versions).toEqual([5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  test("lançamentos novos não deslocam as páginas seguintes (cursor estável)", async () => {
    const walletId = await walletWithEntries(3); // versões 1..4
    const first = await app().request("GET", `/wallets/${walletId}/ledger?limit=2`);
    expect(first.body.items.map((i: { walletVersion: number }) => i.walletVersion)).toEqual([4, 3]);
    // Um novo lançamento entra no topo entre uma página e outra...
    const playerId = (await app().request("GET", `/wallets/${walletId}`)).body.playerId;
    const txId = uuid();
    await app().db.inTransaction(async (exec) => {
      await exec(
        `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key,
           payload_hash, wallet_id, player_id, currency, round_id, game_id, kind, amount, status,
           balance_after, processed_at, correlation_id, created_at, updated_at)
         values (?, 'p', ?, ?, ?, ?, ?, 'BRL', 'r', 'g', 'WIN', 5.00, 'PROCESSED', 102.00, now(), 'c', now(), now())`,
        [txId, txId, txId, "a".repeat(64), walletId, playerId],
      );
      await exec(
        `insert into wallet_ledger_entry (id, wallet_id, transaction_id, currency, direction, amount,
           balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'BRL', 'CREDIT', 5.00, 97.00, 102.00, 5, now())`,
        [uuid(), walletId, txId],
      );
      await exec("update wallet set balance = 102.00, version = 5 where id = ?", [walletId]);
    });
    // ...e a segunda página continua exatamente de onde a primeira parou.
    const second = await app().request(
      "GET",
      `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.items.map((i: { walletVersion: number }) => i.walletVersion)).toEqual([
      2, 1,
    ]);
  });

  test("limit padrão 50 e limites inválidos → 400", async () => {
    const { walletId } = await createWallet("1.00");
    const ok = await app().request("GET", `/wallets/${walletId}/ledger`);
    expect(ok.status).toBe(200);
    expect(ok.body.nextCursor).toBeNull();
    for (const limit of ["0", "201", "-1", "abc", "1.5"]) {
      const res = await app().request("GET", `/wallets/${walletId}/ledger?limit=${limit}`);
      expect(res.status).toBe(400);
    }
  });

  test("cursor malformado ou de outra wallet → 400", async () => {
    const a = await walletWithEntries(2);
    const b = (await createWallet("1.00")).walletId;
    const page = await app().request("GET", `/wallets/${a}/ledger?limit=1`);
    const foreign = await app().request(
      "GET",
      `/wallets/${b}/ledger?cursor=${encodeURIComponent(page.body.nextCursor)}`,
    );
    expect(foreign.status).toBe(400);
    const garbage = await app().request("GET", `/wallets/${a}/ledger?cursor=%%%`);
    expect(garbage.status).toBe(400);
  });

  test("wallet inexistente → 404", async () => {
    const res = await app().request("GET", `/wallets/${uuid()}/ledger`);
    expect(res.status).toBe(404);
  });
});

describe("POST /wallets/:walletId/reconciliation", () => {
  test("wallet consistente: contrato do CHALLENGE §9", async () => {
    const { walletId } = await createWallet("975.00");
    const res = await app().request("POST", `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 1,
      anomalies: [],
    });
  });

  test("divergência é sinalizada, contada em métrica e NÃO corrigida", async () => {
    const { walletId } = await createWallet("100.00");
    const before = await divergenceCount();
    // Corrompe o saldo passando por cima das triggers (só possível como superusuário, de propósito).
    await app().db.inTransaction(async (exec) => {
      await exec("set local session_replication_role = replica");
      await exec("update wallet set balance = 150.00 where id = ?", [walletId]);
    });

    const res = await app().request("POST", `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.consistent).toBe(false);
    expect(res.body.storedBalance.amount).toBe("150.00");
    expect(res.body.calculatedBalance.amount).toBe("100.00");
    expect(res.body.difference.amount).toBe("50.00");
    expect(res.body.anomalies.map((a: { type: string }) => a.type)).toEqual([
      "BALANCE_MISMATCH",
      "LAST_ENTRY_MISMATCH",
    ]);
    expect(await divergenceCount()).toBe(before + 1);

    // Não corrige silenciosamente: o saldo errado continua lá até alguém agir.
    const wallet = await app().request("GET", `/wallets/${walletId}`);
    expect(wallet.body.balance.amount).toBe("150.00");
  });

  test("wallet inexistente → 404", async () => {
    const res = await app().request("POST", `/wallets/${uuid()}/reconciliation`);
    expect(res.status).toBe(404);
  });
});

describe("contrato transversal", () => {
  test("X-Correlation-Id é ecoado e aparece no corpo de erro", async () => {
    const res = await app().request("GET", `/wallets/${uuid()}`, {
      headers: { "x-correlation-id": "corr-test-1" },
    });
    expect(res.headers.get("x-correlation-id")).toBe("corr-test-1");
    expect(res.body.error.correlationId).toBe("corr-test-1");
  });

  test("rota inexistente → 404 no envelope padrão", async () => {
    const res = await app().request("GET", "/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});

async function divergenceCount(): Promise<number> {
  const res = await app().request("GET", "/metrics");
  const match = /^wagering_reconciliation_divergences_total (\d+)/m.exec(res.body as string);
  return Number(match?.[1] ?? 0);
}
