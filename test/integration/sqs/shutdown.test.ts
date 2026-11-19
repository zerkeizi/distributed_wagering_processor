import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../support/database.ts";
import { startTestApp } from "../support/http-app.ts";
import {
  createTestQueues,
  eventually,
  peek,
  queueDepth,
  sendRaw,
  type TestQueues,
} from "../support/sqs.ts";
import { createWallet, uuid } from "../support/wagering-client.ts";

/**
 * Encerramento gracioso (CHALLENGE §10: "em SIGTERM, concluir mensagens em andamento ou devolver a
 * visibilidade"). `app.close()` dispara o mesmo caminho que o SIGTERM (enableShutdownHooks).
 */
let queues: TestQueues;
let db: TestDatabase;

beforeAll(async () => {
  queues = await createTestQueues(5);
  db = await openTestDatabase();
});
afterAll(async () => {
  await queues?.destroy();
  await db?.orm.close();
});

function betMessage(wallet: { walletId: string; playerId: string }) {
  const ext = `tx-${uuid()}`;
  return {
    messageId: `msg-${uuid()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
  };
}

/** Segura o lock da wallet até `release()` — deixa a mensagem "em andamento" pelo tempo que quisermos. */
async function lockWallet(walletId: string): Promise<{ release(): void; done: Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => {
    locked = r;
  });
  const done = db.inTransaction(async (exec) => {
    await exec("select id from wallet where id = ? for update", [walletId]);
    locked();
    await held;
  });
  await isLocked;
  return { release, done };
}

const processed = async (ext: string) =>
  (await db.sql("select 1 from wager_transaction where external_transaction_id = ?", [ext])).length;

describe("SIGTERM", () => {
  test("mensagem em andamento termina dentro do prazo: efeito confirmado e ack antes de sair", async () => {
    const app = await startTestApp({
      ROLES: "api,consumer",
      ...queues.env,
      SQS_CONSUMER_WAIT_SECONDS: "1",
      SHUTDOWN_GRACE_MS: "5000",
      WALLET_LOCK_TIMEOUT_MS: "10000",
    });
    const wallet = await createWallet(app, "100.00");
    const lock = await lockWallet(wallet.walletId);
    const msg = betMessage(wallet);
    await sendRaw(queues.wagerUrl, JSON.stringify(msg), { groupId: wallet.walletId });
    await eventually(
      () => queueDepth(queues.wagerUrl),
      (d) => d.inFlight === 1,
    );

    const closing = app.close(); // SIGTERM
    await Bun.sleep(500);
    lock.release(); // a mensagem consegue terminar dentro dos 5 s de graça
    await lock.done;
    await closing;

    expect(await processed(msg.data.externalTransactionId)).toBe(1);
    expect(await queueDepth(queues.wagerUrl)).toEqual({ visible: 0, inFlight: 0 });
  }, 20_000);

  test("prazo estoura: a mensagem volta para a fila na hora (visibilidade 0) para outra instância", async () => {
    const app = await startTestApp({
      ROLES: "api,consumer",
      ...queues.env,
      SQS_CONSUMER_WAIT_SECONDS: "1",
      SHUTDOWN_GRACE_MS: "300",
      WALLET_LOCK_TIMEOUT_MS: "10000",
    });
    const wallet = await createWallet(app, "100.00");
    const lock = await lockWallet(wallet.walletId);
    const msg = betMessage(wallet);
    await sendRaw(queues.wagerUrl, JSON.stringify(msg), { groupId: wallet.walletId });
    await eventually(
      () => queueDepth(queues.wagerUrl),
      (d) => d.inFlight === 1,
    );

    const closing = app.close();
    // Sem a devolução, a mensagem ficaria invisível pelos 30 s do VisibilityTimeout da fila.
    const returned = await eventually(
      () => peek(queues.wagerUrl, 0),
      (msgs) => msgs.some((m) => m.Body?.includes(msg.messageId)),
      { timeoutMs: 3_000 },
    );
    expect(returned.length).toBeGreaterThan(0);

    // Libera o lock para o processo terminar de fechar (o pool espera a transação pendente).
    lock.release();
    await lock.done;
    await closing;

    // Outra instância pega a mensagem devolvida; se a primeira chegou a confirmar, o inbox evita
    // repetir o efeito. Em qualquer caso: exatamente um efeito.
    const successor = await startTestApp({
      ROLES: "api,consumer",
      ...queues.env,
      SQS_CONSUMER_WAIT_SECONDS: "1",
    });
    try {
      await eventually(
        () => queueDepth(queues.wagerUrl),
        (d) => d.visible === 0 && d.inFlight === 0,
        {
          timeoutMs: 10_000,
        },
      );
      expect(await processed(msg.data.externalTransactionId)).toBe(1);
      const [wallet2] = await db.sql<{ balance: string }>(
        "select balance::text from wallet where id = ?",
        [wallet.walletId],
      );
      expect(wallet2?.balance).toBe("90.00");
    } finally {
      await successor.close();
    }
  }, 30_000);
});
