import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { openFreshDatabase } from "../support/database.ts";
import { useTestApp } from "../support/http-app.ts";
import { createTestQueues, eventually, sqs, type TestQueues } from "../support/sqs.ts";
import { createWallet, submitWager } from "../support/wagering-client.ts";

/** Outbox de ponta a ponta (CHALLENGE §11, ADR 0013), contra Postgres e LocalStack reais. */
let queues: TestQueues;
let fresh: Awaited<ReturnType<typeof openFreshDatabase>>;
beforeAll(async () => {
  queues = await createTestQueues();
  fresh = await openFreshDatabase("outbox");
});

// Banco exclusivo: a outbox só contém os eventos criados por esta suíte.
const app = useTestApp(() => ({
  ROLES: "api,outbox-publisher",
  DATABASE_URL: fresh.url,
  ...queues.env,
  OUTBOX_POLL_INTERVAL_MS: "100",
  OUTBOX_BATCH_SIZE: "500",
}));
// Depois do afterAll da app (registrado acima): a app fecha e confere a invariante antes de o
// banco exclusivo e as filas sumirem.
afterAll(async () => {
  await queues?.destroy();
  await fresh?.drop();
});

const eventsUrl = async () =>
  (
    await sqs.send(
      new (
        await import("@aws-sdk/client-sqs")
      ).GetQueueUrlCommand({ QueueName: queues.env.SQS_EVENTS_QUEUE_NAME }),
    )
  ).QueueUrl as string;

/** Lê (e apaga, como um consumidor faria) os eventos de um aggregate publicados na fila. */
async function drainEvents(
  url: string,
  aggregateId: string,
  seen: Map<string, Record<string, unknown>>,
) {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["MessageGroupId"],
    }),
  );
  for (const m of res.Messages ?? []) {
    const body = JSON.parse(m.Body ?? "{}");
    if (body.aggregateId === aggregateId) {
      expect(m.Attributes?.MessageGroupId).toBe(aggregateId);
      expect(m.MessageAttributes?.eventType?.StringValue).toBe(body.eventType);
      seen.set(body.eventId, body);
    }
    await sqs.send(
      new (await import("@aws-sdk/client-sqs")).DeleteMessageCommand({
        QueueUrl: url,
        ReceiptHandle: m.ReceiptHandle,
      }),
    );
  }
  return seen;
}

describe("outbox publisher", () => {
  test("eventos confirmados chegam à fila de eventos e ficam marcados como publicados", async () => {
    const w = await createWallet(app(), "100.00");
    await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    await submitWager(app(), w, { kind: "BET", amount: "1000.00" }); // rejeitada

    const url = await eventsUrl();
    const seen = new Map<string, Record<string, unknown>>();
    await eventually(
      () => drainEvents(url, w.walletId, seen),
      (s) => s.size >= 5,
      { timeoutMs: 20_000 },
    );
    const types = [...seen.values()].map((e) => e.eventType).sort();
    expect(types).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    // O envelope publicado é exatamente o gravado na outbox (eventId, versão, data com Money em string).
    const balanceChanged = [...seen.values()].filter((e) => e.eventType === "WalletBalanceChanged");
    expect(
      balanceChanged.map((e) => (e.data as { walletVersion: number }).walletVersion).sort(),
    ).toEqual([1, 2]);

    const pending = await app().db.sql(
      "select 1 from outbox_message where aggregate_id = ? and published_at is null",
      [w.walletId],
    );
    expect(pending).toHaveLength(0);
  }, 30_000);
});
