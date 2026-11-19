import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../../src/wagering/infrastructure/persistence/mikro-orm.config.ts";
import { openFreshDatabase, TEST_DATABASE_URL } from "../support/database.ts";
import { useTestApp } from "../support/http-app.ts";
import {
  createTestQueues,
  eventually,
  queueDepth,
  sendRaw,
  type TestQueues,
} from "../support/sqs.ts";
import { createWallet, uuid, wagerBody } from "../support/wagering-client.ts";

/**
 * "PostgreSQL pode ficar temporariamente indisponível" (CHALLENGE §3). A queda é REAL: o banco
 * exclusivo desta suíte passa a recusar conexões (`ALLOW_CONNECTIONS false`) e as existentes são
 * derrubadas — sem afetar o banco compartilhado das outras suítes.
 *
 * As filas têm maxReceiveCount = 3 e backoff curto: sem o circuit breaker do consumer, mensagens
 * válidas iriam para a DLQ em poucos segundos de queda.
 */
let queues: TestQueues;
let fresh: Awaited<ReturnType<typeof openFreshDatabase>>;
let admin: MikroORM;
let databaseName: string;

beforeAll(async () => {
  queues = await createTestQueues(3);
  fresh = await openFreshDatabase("outage");
  databaseName = new URL(fresh.url).pathname.slice(1);
  admin = await MikroORM.init(createOrmOptions({ databaseUrl: TEST_DATABASE_URL, poolMax: 1 }));
});

const app = useTestApp(() => ({
  ROLES: "api,consumer",
  DATABASE_URL: fresh.url,
  ...queues.env,
  SQS_CONSUMER_WAIT_SECONDS: "1",
  SQS_RETRY_BASE_MS: "300",
  SQS_RETRY_MAX_MS: "600",
  SQS_CONSUMER_PAUSE_PROBE_MS: "300",
  SQS_CONSUMER_PAUSE_PROBE_MAX_MS: "1000",
  DATABASE_CONNECT_TIMEOUT_MS: "1000",
}));
// Depois do afterAll da app (registrado acima): a app fecha e confere a invariante antes de o
// banco exclusivo e as filas sumirem.
afterAll(async () => {
  await restoreDatabase();
  await admin?.close();
  await queues?.destroy();
  await fresh?.drop();
});

async function takeDatabaseDown(): Promise<void> {
  const sql = admin.em.fork().getConnection();
  await sql.execute(`alter database "${databaseName}" allow_connections false`);
  await sql.execute(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
    [databaseName],
  );
}

async function restoreDatabase(): Promise<void> {
  await admin?.em
    .fork()
    .getConnection()
    .execute(`alter database "${databaseName}" allow_connections true`);
}

async function metric(name: string): Promise<number> {
  const text = (await app().request("GET", "/metrics")).body as string;
  return Number(
    text
      .split("\n")
      .find((l) => l.startsWith(`${name} `))
      ?.split(" ")[1] ?? Number.NaN,
  );
}

describe("banco temporariamente indisponível", () => {
  test("consumer pausa durante a queda: nenhuma mensagem válida vai para a DLQ, tudo é aplicado na volta", async () => {
    const wallet = await createWallet(app(), "100.00");
    await takeDatabaseDown();
    try {
      const bets = Array.from({ length: 3 }, () =>
        wagerBody(wallet, { kind: "BET", amount: "10.00" }),
      );
      for (const bet of bets) {
        await sendRaw(
          queues.wagerUrl,
          JSON.stringify({
            messageId: `msg-${uuid()}`,
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: { ...bet.body, idempotencyKey: bet.idempotencyKey },
          }),
          { groupId: `g-${uuid()}` }, // grupos diferentes: as 3 seriam recebidas em paralelo
        );
      }
      // Tempo de sobra para, sem o breaker, as 3 esgotarem as 3 entregas e irem para a DLQ.
      await Bun.sleep(8_000);
      // O efeito que importa primeiro; a métrica depois.
      expect(await queueDepth(queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
      expect(await metric("wagering_consumer_paused")).toBe(1);
    } finally {
      await restoreDatabase();
    }

    await eventually(
      () => metric("wagering_consumer_paused"),
      (v) => v === 0,
      { timeoutMs: 15_000 },
    );
    await eventually(
      () => queueDepth(queues.wagerUrl),
      (d) => d.visible === 0 && d.inFlight === 0,
      { timeoutMs: 20_000 },
    );
    const [row] = await fresh.sql<{ balance: string; bets: string }>(
      `select w.balance::text,
              (select count(*) from wager_transaction t where t.wallet_id = w.id and t.kind = 'BET')::text as bets
         from wallet w where w.id = ?`,
      [wallet.walletId],
    );
    expect(row).toEqual({ balance: "70.00", bets: "3" });
    expect(await queueDepth(queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
  }, 60_000);

  test("HTTP durante a queda: 503 TEMPORARILY_UNAVAILABLE rápido, com Retry-After; reenvio aplica na volta", async () => {
    const wallet = await createWallet(app(), "100.00");
    const bet = wagerBody(wallet, { kind: "BET", amount: "25.00" });
    const send = () =>
      app().request("POST", "/wagering/transactions", {
        body: bet.body,
        headers: { "idempotency-key": bet.idempotencyKey },
      });

    await takeDatabaseDown();
    try {
      const started = performance.now();
      const res = await send();
      const elapsed = performance.now() - started;
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("TEMPORARILY_UNAVAILABLE");
      expect(res.headers.get("retry-after")).toBe("2");
      expect(elapsed).toBeLessThan(5_000); // timeout de conexão: não fica pendurado
      expect((await app().request("GET", "/health/live")).status).toBe(200);
      // Readiness tira a instância do balanceamento; o processo continua vivo (CHALLENGE §9).
      const ready = await app().request("GET", "/health/ready");
      expect(ready.status).toBe(503);
      expect(ready.body.checks.postgres.status).toBe("down");
      expect(ready.body.checks.sqs.status).toBe("up");
    } finally {
      await restoreDatabase();
    }

    const retried = await eventually(send, (r) => r.status !== 503, {
      timeoutMs: 15_000,
      intervalMs: 300,
    });
    expect(retried.status).toBe(201); // nada tinha sido gravado: o reenvio é a primeira aplicação
    expect(retried.body.balance.amount).toBe("75.00");
  }, 60_000);
});
