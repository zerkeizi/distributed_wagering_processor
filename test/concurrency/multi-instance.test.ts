import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { openFreshDatabase } from "../integration/support/database.ts";
import { assertLedgerConsistent } from "../integration/support/ledger-consistency.ts";
import {
  createTestQueues,
  eventually,
  queueDepth,
  sendRaw,
  sqs,
  type TestQueues,
} from "../integration/support/sqs.ts";
import { type Instance, requestWithFailover, spawnInstance, stopAll } from "./support/instances.ts";

/**
 * Cenários do CHALLENGE §13 que só fazem sentido com PROCESSOS separados:
 *   4. ≥ 3 instâncias simultâneas
 *   5. worker morto depois do commit e antes do ack
 *   6. publisher morto depois de publicar e antes de marcar (outbox)
 *   7. ROLLBACK/REFUND antes da referência, resolvido pelos workers
 *   8. reinício do serviço com comprovação da consistência final
 * Banco exclusivo deste arquivo; filas exclusivas por cenário.
 */
let db: Awaited<ReturnType<typeof openFreshDatabase>>;
beforeAll(async () => {
  db = await openFreshDatabase("multi");
});
afterAll(async () => {
  await db?.drop();
});

let running: Instance[] = [];
afterEach(async () => {
  await stopAll(running);
  running = [];
});

const uuid = () => Bun.randomUUIDv7();

function baseEnv(queues: TestQueues): Record<string, string> {
  return {
    DATABASE_URL: db.url,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ...queues.env,
    SQS_CONSUMER_WAIT_SECONDS: "1",
    SQS_RETRY_BASE_MS: "500",
    SQS_RETRY_MAX_MS: "2000",
    OUTBOX_POLL_INTERVAL_MS: "200",
    OUTBOX_LEASE_MS: "3000",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "200",
    REFERENCE_RETRY_BASE_MS: "200",
    REFERENCE_RETRY_MAX_DELAY_MS: "1000",
    WALLET_LOCK_TIMEOUT_MS: "5000",
    SHUTDOWN_GRACE_MS: "3000",
  };
}

async function spawn(
  name: string,
  queues: TestQueues,
  extra: Record<string, string> = {},
  options: { waitReady?: boolean } = {},
) {
  const instance = await spawnInstance(name, { ...baseEnv(queues), ...extra }, options);
  running.push(instance);
  return instance;
}

const live = () => running;

async function createWallet(amount: string, via = 0) {
  const playerId = uuid();
  const res = await requestWithFailover(live, via, "POST", "/wallets", {
    body: { playerId, initialBalance: { amount, currency: "BRL" } },
  });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function wager(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: { ext?: string; ref?: string } = {},
) {
  const ext = extra.ext ?? `tx-${uuid()}`;
  return {
    ext,
    key: `provider-a:${ext}`,
    body: {
      providerId: "provider-a",
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
      ...(extra.ref ? { referenceExternalTransactionId: extra.ref } : {}),
    },
  };
}

const viaHttp = (w: ReturnType<typeof wager>, via: number) =>
  requestWithFailover(live, via, "POST", "/wagering/transactions", {
    body: w.body,
    headers: { "idempotency-key": w.key },
  });

const viaQueue = (queues: TestQueues, w: ReturnType<typeof wager>, messageId = `msg-${uuid()}`) =>
  sendRaw(
    queues.wagerUrl,
    JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...w.body, idempotencyKey: w.key },
    }),
    { groupId: w.body.walletId },
  );

const drained = (queues: TestQueues, timeoutMs = 30_000) =>
  eventually(
    () => queueDepth(queues.wagerUrl),
    (d) => d.visible === 0 && d.inFlight === 0,
    {
      timeoutMs,
      intervalMs: 250,
    },
  );

const outboxPending = async () =>
  Number(
    (
      await db.sql<{ n: string }>(
        "select count(*)::text as n from outbox_message where published_at is null",
      )
    )[0]?.n,
  );

/** Uma transação por id externo — nunca duas (débito/crédito duplicado é falha eliminatória). */
async function assertNoDuplicateTransactions(): Promise<void> {
  const dupes = await db.sql(
    "select provider_id, external_transaction_id from wager_transaction group by 1, 2 having count(*) > 1",
  );
  expect(dupes).toHaveLength(0);
}

async function assertAllWalletsConsistent(): Promise<void> {
  const wallets = await db.sql<{ id: string }>("select id from wallet");
  for (const w of wallets) await assertLedgerConsistent(db, w.id);
}

describe("≥ 3 instâncias simultâneas (CHALLENGE §13.4, §13.7)", () => {
  test("HTTP espalhado em 3 processos + fila consumida pelos 3 + workers: tudo exato e consistente", async () => {
    const queues = await createTestQueues(5);
    try {
      await Promise.all(["i1", "i2", "i3"].map((n) => spawn(n, queues)));

      const wallets = await Promise.all(
        Array.from({ length: 8 }, (_, i) => createWallet("100.00", i)),
      );
      // Por wallet: 30 BETs de 5.00 pelo HTTP (3 instâncias) + 10 pela fila = 200.00 pedidos sobre 100.00.
      const httpBets = wallets.flatMap((w) =>
        Array.from({ length: 30 }, () => wager(w, "BET", "5.00")),
      );
      const queueBets = wallets.flatMap((w) =>
        Array.from({ length: 10 }, () => wager(w, "BET", "5.00")),
      );
      // E um ROLLBACK que chega ANTES da BET que ele desfaz, em instância diferente (cenário 7).
      const late = wallets.map((w) => {
        const bet = wager(w, "BET", "1.00");
        return { bet, rollback: wager(w, "ROLLBACK", "1.00", { ref: bet.ext }) };
      });
      for (const l of late) expect((await viaHttp(l.rollback, 0)).status).toBe(202);

      await Promise.all([
        ...httpBets.map((b, i) => viaHttp(b, i)),
        ...queueBets.map((b) => viaQueue(queues, b)),
        // Reenvios: as mesmas requisições HTTP de novo, para outra instância (retry do provider).
        ...httpBets.slice(0, 40).map((b, i) => viaHttp(b, i + 1)),
        ...late.map((l, i) => viaHttp(l.bet, i + 2)),
      ]);
      await drained(queues);

      // O ROLLBACK de cada BET atrasada foi resolvido sozinho por algum dos 3 workers.
      for (const l of late) {
        const res = await requestWithFailover(
          live,
          0,
          "GET",
          `/providers/provider-a/wagering/transactions/${l.rollback.ext}`,
        );
        await eventually(
          async () =>
            (
              await requestWithFailover(
                live,
                0,
                "GET",
                `/providers/provider-a/wagering/transactions/${l.rollback.ext}`,
              )
            ).body.status,
          (s) => s !== "PENDING_REFERENCE",
        );
        expect(res.status).toBe(200);
      }

      for (const w of wallets) {
        const [row] = await db.sql<{ balance: string; processed: string }>(
          `select w.balance::text,
                  (select count(*) from wager_transaction t
                    where t.wallet_id = w.id and t.kind = 'BET' and t.status = 'PROCESSED' and t.amount = 5.00)::text as processed
             from wallet w where w.id = ?`,
          [w.walletId],
        );
        // A BET de 1.00 atrasada sempre se anula (aplicada e revertida, ou rejeitada junto com o
        // ROLLBACK): o saldo fecha exatamente com as BETs de 5.00 aplicadas, e elas esgotam a wallet.
        const processed = Number(row?.processed);
        expect(Number(row?.balance)).toBe(100 - 5 * processed);
        expect(processed).toBeGreaterThanOrEqual(19);
        expect(processed).toBeLessThanOrEqual(20);
      }
      await assertNoDuplicateTransactions();
      await assertAllWalletsConsistent();
      await eventually(outboxPending, (n) => n === 0, { timeoutMs: 20_000 });
    } finally {
      await queues.destroy();
    }
  }, 120_000);
});

describe("crashes", () => {
  test("processo morto ANTES do commit: nada fica gravado e a reentrega aplica normalmente (CHALLENGE §3)", async () => {
    const queues = await createTestQueues(5, 3);
    try {
      const doomed = await spawn("doomed-before-commit", queues, {
        ROLES: "api,consumer",
        FAULT_CRASH_AT: "submit:before-commit",
      });
      const w = await createWallet("100.00");
      const bet = wager(w, "BET", "30.00");
      await viaQueue(queues, bet);

      await doomed.proc.exited;
      expect(doomed.proc.signalCode).toBe("SIGKILL");
      // Morreu com transação, lançamento, saldo, outbox e inbox já registrados — e nada disso existe.
      expect(
        await db.sql("select 1 from wager_transaction where external_transaction_id = ?", [
          bet.ext,
        ]),
      ).toHaveLength(0);
      const [before] = await db.sql<{ balance: string; version: number }>(
        "select balance::text, version from wallet where id = ?",
        [w.walletId],
      );
      expect(before).toEqual({ balance: "100.00", version: 1 });

      running = running.filter((i) => i !== doomed);
      await spawn("successor", queues, { ROLES: "api,consumer" });
      await drained(queues);
      expect(
        await db.sql("select 1 from wager_transaction where external_transaction_id = ?", [
          bet.ext,
        ]),
      ).toHaveLength(1);
      const [after] = await db.sql<{ balance: string }>(
        "select balance::text from wallet where id = ?",
        [w.walletId],
      );
      expect(after?.balance).toBe("70.00");
      await assertLedgerConsistent(db, w.walletId);
    } finally {
      await queues.destroy();
    }
  }, 60_000);

  test("worker morto DEPOIS do commit e ANTES do ack: outra instância recebe de novo e o inbox absorve (§13.5)", async () => {
    const queues = await createTestQueues(5, 3); // visibilidade de 3 s: a reentrega vem rápido
    try {
      const doomed = await spawn("doomed", queues, {
        ROLES: "api,consumer",
        FAULT_CRASH_AT: "consumer:after-commit-before-ack",
      });
      const w = await createWallet("100.00");
      const bet = wager(w, "BET", "30.00");
      await viaQueue(queues, bet);

      await doomed.proc.exited; // morreu com SIGKILL no crash point
      expect(doomed.proc.signalCode).toBe("SIGKILL");
      const committed = await db.sql(
        "select status from wager_transaction where external_transaction_id = ?",
        [bet.ext],
      );
      expect(committed).toEqual([{ status: "PROCESSED" }]); // o commit aconteceu…
      expect(
        (await queueDepth(queues.wagerUrl)).inFlight + (await queueDepth(queues.wagerUrl)).visible,
      ).toBe(1); // …mas o ack não

      running = running.filter((i) => i !== doomed);
      await spawn("successor", queues, { ROLES: "api,consumer" });
      await drained(queues);

      expect(
        await db.sql("select 1 from wager_transaction where external_transaction_id = ?", [
          bet.ext,
        ]),
      ).toHaveLength(1);
      const [wallet] = await db.sql<{ balance: string }>(
        "select balance::text from wallet where id = ?",
        [w.walletId],
      );
      expect(wallet?.balance).toBe("70.00"); // debitado uma única vez
      await assertLedgerConsistent(db, w.walletId);
    } finally {
      await queues.destroy();
    }
  }, 60_000);

  test("publisher morto DEPOIS de publicar e ANTES de marcar: outro republica após o lease, sem perda (§11, §13.6)", async () => {
    const queues = await createTestQueues();
    try {
      // Sem publisher: os eventos ficam pendentes até o publisher "condenado" subir.
      await spawn("api-only", queues, { ROLES: "api" });
      const w = await createWallet("100.00");
      const eventIds = (
        await db.sql<{ id: string }>("select id from outbox_message where aggregate_id = ?", [
          w.walletId,
        ])
      ).map((r) => r.id);
      expect(eventIds).toHaveLength(2); // WagerTransactionProcessed (OPENING) + WalletBalanceChanged

      const doomed = await spawn(
        "doomed-publisher",
        queues,
        {
          ROLES: "outbox-publisher",
          FAULT_CRASH_AT: "outbox:after-publish-before-mark",
        },
        { waitReady: false },
      );
      await doomed.proc.exited;
      expect(doomed.proc.signalCode).toBe("SIGKILL");
      expect(await outboxPending()).toBeGreaterThan(0); // publicou ao menos um, mas não marcou

      running = running.filter((i) => i !== doomed);
      await spawn("successor-publisher", queues, { ROLES: "outbox-publisher" });
      await eventually(outboxPending, (n) => n === 0, { timeoutMs: 20_000 }); // após o lease (3 s)

      // Na fila de eventos: cada evento exatamente uma vez. O republish usa o mesmo eventId como
      // MessageDeduplicationId, então o SQS FIFO descarta a cópia; fora da janela de dedup do SQS, o
      // consumidor descartaria pelo eventId do envelope.
      const url = (
        await sqs.send(new GetQueueUrlCommand({ QueueName: queues.env.SQS_EVENTS_QUEUE_NAME }))
      ).QueueUrl as string;
      const received: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
        );
        for (const m of res.Messages ?? []) {
          const event = JSON.parse(m.Body ?? "{}");
          // A fila também recebe eventos pendentes de cenários anteriores (mesmo banco): só os desta wallet.
          if (event.aggregateId === w.walletId) received.push(event.eventId);
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }),
          );
        }
      }
      expect(received.sort()).toEqual([...eventIds].sort());
    } finally {
      await queues.destroy();
    }
  }, 60_000);
});

describe("reinício do serviço (CHALLENGE §13.8)", () => {
  test("SIGKILL numa instância e SIGTERM noutra no meio da carga, reinício, e consistência final", async () => {
    const queues = await createTestQueues(5, 3);
    try {
      await Promise.all(["r1", "r2", "r3"].map((n) => spawn(n, queues)));
      const wallets = await Promise.all(
        Array.from({ length: 6 }, (_, i) => createWallet("50.00", i)),
      );
      const bets = wallets.flatMap((w) =>
        Array.from({ length: 20 }, () => wager(w, "BET", "5.00")),
      );

      const load = (async () => {
        for (let i = 0; i < bets.length; i++) {
          const bet = bets[i];
          if (!bet) continue;
          if (i % 2 === 0) await viaHttp(bet, i);
          else await viaQueue(queues, bet);
        }
      })();

      await Bun.sleep(400);
      const [r1, r2] = running;
      await r1?.kill("SIGKILL"); // queda abrupta
      await r2?.kill("SIGTERM"); // desligamento gracioso
      running = running.filter((i) => i.alive);
      running.push(
        await spawnInstance("r1-restarted", baseEnv(queues)),
        await spawnInstance("r2-restarted", baseEnv(queues)),
      );

      await load;
      // Reenvia tudo de novo (provider que não sabe o que chegou): nada pode duplicar.
      await Promise.all(bets.map((b, i) => (i % 2 === 0 ? viaHttp(b, i) : viaQueue(queues, b))));
      await drained(queues, 45_000);
      await eventually(outboxPending, (n) => n === 0, { timeoutMs: 20_000 });

      for (const w of wallets) {
        const [row] = await db.sql<{ balance: string; processed: string }>(
          `select w.balance::text,
                  (select count(*) from wager_transaction t where t.wallet_id = w.id and t.status = 'PROCESSED' and t.kind = 'BET')::text as processed
             from wallet w where w.id = ?`,
          [w.walletId],
        );
        expect(row).toEqual({ balance: "0.00", processed: "10" }); // 50.00 / 5.00
        const reconciliation = await requestWithFailover(
          live,
          0,
          "POST",
          `/wallets/${w.walletId}/reconciliation`,
        );
        expect(reconciliation.body.consistent).toBe(true);
      }
      await assertNoDuplicateTransactions();
      await assertAllWalletsConsistent();
      expect((await queueDepth(queues.dlqUrl)).visible).toBe(0);
    } finally {
      await queues.destroy();
    }
  }, 180_000);
});
