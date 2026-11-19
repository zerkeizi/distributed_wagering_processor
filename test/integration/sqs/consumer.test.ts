import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useTestApp } from "../support/http-app.ts";
import { assertLedgerConsistent } from "../support/ledger-consistency.ts";
import {
  createTestQueues,
  eventually,
  peek,
  queueDepth,
  sendRaw,
  type TestQueues,
} from "../support/sqs.ts";
import { balanceOf, createWallet, type TestWallet, uuid } from "../support/wagering-client.ts";

/**
 * Consumer real (CHALLENGE §10, ADR 0014): a aplicação sobe com o papel `consumer` contra o
 * LocalStack, com filas exclusivas desta suíte. Os testes publicam mensagens na fila e observam o
 * efeito no banco e nas filas — sem chamar o handler diretamente.
 */
let queues: TestQueues;
beforeAll(async () => {
  queues = await createTestQueues(3);
});
afterAll(async () => {
  await queues?.destroy();
});

// Registrado depois do beforeAll acima: as filas existem antes de a aplicação subir.
const app = useTestApp(() => ({
  ROLES: "api,consumer",
  ...queues.env,
  SQS_CONSUMER_WAIT_SECONDS: "1",
  SQS_RETRY_BASE_MS: "500",
  SQS_RETRY_MAX_MS: "1000",
  WALLET_LOCK_TIMEOUT_MS: "300",
}));

function envelope(
  w: TestWallet,
  data: Partial<Record<string, unknown>> & { kind: string; amount: string },
  messageId = `msg-${uuid()}`,
) {
  const externalTransactionId = (data.externalTransactionId as string) ?? `tx-${uuid()}`;
  const { amount, ...rest } = data;
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      money: { amount, currency: "BRL" },
      ...rest,
    },
  };
}

const publish = (body: unknown, opts: { groupId?: string; correlationId?: string } = {}) =>
  sendRaw(queues.wagerUrl, typeof body === "string" ? body : JSON.stringify(body), opts);

const txByExternalId = async (ext: string) =>
  (
    await app().db.sql<{
      id: string;
      status: string;
      failure_code: string | null;
      correlation_id: string;
    }>(
      "select id, status, failure_code, correlation_id from wager_transaction where external_transaction_id = ?",
      [ext],
    )
  )[0];

const inboxRows = (messageId: string) =>
  app().db.sql("select 1 from inbox_message where message_id = ?", [messageId]);

const queueDrained = () =>
  eventually(
    () => queueDepth(queues.wagerUrl),
    (d) => d.visible === 0 && d.inFlight === 0,
  );

async function metric(name: string, labels = ""): Promise<number> {
  const text = (await app().request("GET", "/metrics")).body as string;
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`${name}${labels} `) || l.startsWith(`${name}${labels}{`));
  return Number(line?.split(" ").at(-1) ?? 0);
}

describe("processamento", () => {
  test("BET via fila: aplicada, inbox gravado, mensagem apagada só depois do commit", async () => {
    const w = await createWallet(app(), "100.00");
    const msg = envelope(w, { kind: "BET", amount: "30.00" });
    await publish(msg, { groupId: w.walletId, correlationId: "corr-sqs-1" });

    const tx = await eventually(() => txByExternalId(msg.data.externalTransactionId), Boolean);
    expect(tx?.status).toBe("PROCESSED");
    expect(tx?.correlation_id).toBe("corr-sqs-1");
    expect(await inboxRows(msg.messageId)).toHaveLength(1);
    await queueDrained();
    expect(await balanceOf(app(), w.walletId)).toBe("70.00");
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("mesmo use case do HTTP: chave já usada no HTTP vira replay na fila (sem débito duplo)", async () => {
    const w = await createWallet(app(), "100.00");
    const msg = envelope(w, { kind: "BET", amount: "10.00" });
    const viaHttp = await app().request("POST", "/wagering/transactions", {
      body: (({ idempotencyKey, ...rest }) => rest)(msg.data),
      headers: { "idempotency-key": msg.data.idempotencyKey },
    });
    expect(viaHttp.status).toBe(201);
    await publish(msg, { groupId: w.walletId });
    await eventually(
      () => inboxRows(msg.messageId),
      (rows) => rows.length === 1,
    );
    await queueDrained();
    expect(await balanceOf(app(), w.walletId)).toBe("90.00");
  });

  test("rejeição de negócio (sem saldo) é terminal: REJECTED gravado, ack, nada na DLQ", async () => {
    const w = await createWallet(app(), "5.00");
    const msg = envelope(w, { kind: "BET", amount: "50.00" });
    await publish(msg, { groupId: w.walletId });
    const tx = await eventually(() => txByExternalId(msg.data.externalTransactionId), Boolean);
    expect(tx).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    await queueDrained();
    expect(await peek(queues.dlqUrl, 0)).toHaveLength(0);
  });

  test("wallet inexistente: nada persistido além do inbox, ack, nada na DLQ (ADR 0007)", async () => {
    const ghost = { walletId: uuid(), playerId: uuid() };
    const msg = envelope(ghost, { kind: "BET", amount: "1.00" });
    await publish(msg, { groupId: ghost.walletId });
    await eventually(
      () => inboxRows(msg.messageId),
      (rows) => rows.length === 1,
    );
    expect(await txByExternalId(msg.data.externalTransactionId)).toBeUndefined();
    await queueDrained();
    expect(await peek(queues.dlqUrl, 0)).toHaveLength(0);
  });
});

describe("inbox e redelivery", () => {
  test("a mesma mensagem entregue 3 vezes → um único efeito, um único registro de inbox", async () => {
    const w = await createWallet(app(), "100.00");
    const msg = envelope(w, { kind: "BET", amount: "25.00" });
    const before = await metric("wagering_duplicates_detected_total", '{source="inbox"}');
    // Deduplication ids diferentes: o SQS entrega as 3 (simula reenvio do produtor/redelivery).
    for (let i = 0; i < 3; i++) await publish(msg, { groupId: w.walletId });

    await eventually(
      () => metric("wagering_duplicates_detected_total", '{source="inbox"}'),
      (n) => n >= before + 2,
    );
    await queueDrained();
    expect(await inboxRows(msg.messageId)).toHaveLength(1);
    expect(await balanceOf(app(), w.walletId)).toBe("75.00");
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("messageId diferente com a mesma idempotency key → replay da transação, sem novo débito", async () => {
    const w = await createWallet(app(), "100.00");
    const first = envelope(w, { kind: "BET", amount: "10.00" });
    const second = { ...first, messageId: `msg-${uuid()}` };
    await publish(first, { groupId: w.walletId });
    await publish(second, { groupId: w.walletId });
    await eventually(
      () => inboxRows(second.messageId),
      (rows) => rows.length === 1,
    );
    await queueDrained();
    expect(await balanceOf(app(), w.walletId)).toBe("90.00");
  });
});

describe("DLQ imediata para mensagens permanentemente inválidas", () => {
  async function expectDeadLettered(reason: string, marker: string) {
    const messages = await eventually(
      () => peek(queues.dlqUrl),
      (msgs) => msgs.some((m) => m.Body?.includes(marker)),
    );
    const dead = messages.find((m) => m.Body?.includes(marker));
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(reason);
    return dead;
  }

  test("JSON malformado", async () => {
    const marker = `garbage-${uuid()}`;
    await publish(`{ not json ${marker}`);
    await expectDeadLettered("malformed_json", marker);
  });

  test("schema inválido (campo obrigatório ausente)", async () => {
    const marker = `msg-${uuid()}`;
    await publish({ messageId: marker, type: "WagerTransactionRequested", data: {} });
    await expectDeadLettered("invalid_schema", marker);
  });

  test("OPENING pela fila → UNSUPPORTED_KIND", async () => {
    const w = await createWallet(app(), "1.00");
    const msg = envelope(w, { kind: "OPENING", amount: "1.00" });
    await publish(msg, { groupId: w.walletId });
    const dead = await expectDeadLettered("invalid_payload", msg.messageId);
    expect(dead?.MessageAttributes?.deadLetterDetail?.StringValue).toBe("UNSUPPORTED_KIND");
  });

  test("messageId reaproveitado com outro conteúdo → DLQ; o efeito original fica intacto", async () => {
    const w = await createWallet(app(), "100.00");
    const original = envelope(w, { kind: "BET", amount: "10.00" });
    await publish(original, { groupId: w.walletId });
    await eventually(
      () => inboxRows(original.messageId),
      (rows) => rows.length === 1,
    );
    const forged = envelope(w, { kind: "BET", amount: "60.00" }, original.messageId);
    await publish(forged, { groupId: w.walletId });
    await expectDeadLettered("message_id_reused", forged.data.externalTransactionId);
    expect(await balanceOf(app(), w.walletId)).toBe("90.00");
  });
});

describe("falhas transitórias", () => {
  /** Segura o lock da wallet direto no banco, fazendo o consumer estourar o lock_timeout. */
  async function holdWalletLock(walletId: string, ms: number): Promise<void> {
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    void app().db.inTransaction(async (exec) => {
      await exec("select id from wallet where id = ? for update", [walletId]);
      locked();
      await Bun.sleep(ms);
    });
    await isLocked;
  }

  test("lock ocupado → retry com backoff → processa uma única vez quando libera", async () => {
    const w = await createWallet(app(), "100.00");
    const retriesBefore = await metric("wagering_retries_total", '{component="sqs_consumer"}');
    await holdWalletLock(w.walletId, 1_500);
    const msg = envelope(w, { kind: "BET", amount: "40.00" });
    await publish(msg, { groupId: w.walletId });

    const tx = await eventually(() => txByExternalId(msg.data.externalTransactionId), Boolean, {
      timeoutMs: 15_000,
    });
    expect(tx?.status).toBe("PROCESSED");
    expect(await metric("wagering_retries_total", '{component="sqs_consumer"}')).toBeGreaterThan(
      retriesBefore,
    );
    await queueDrained();
    expect(await balanceOf(app(), w.walletId)).toBe("60.00");
  });

  test("falha que persiste além do limite de tentativas → redrive para a DLQ, sem efeito", async () => {
    const w = await createWallet(app(), "100.00");
    await holdWalletLock(w.walletId, 9_000);
    const msg = envelope(w, { kind: "BET", amount: "1.00" });
    await publish(msg, { groupId: w.walletId });

    // maxReceiveCount = 3 nas filas desta suíte: na 4ª entrega o SQS move para a DLQ sozinho.
    const dead = await eventually(
      () => peek(queues.dlqUrl),
      (msgs) => msgs.some((m) => m.Body?.includes(msg.messageId)),
      { timeoutMs: 20_000, intervalMs: 500 },
    );
    expect(
      dead.find((m) => m.Body?.includes(msg.messageId))?.MessageAttributes?.deadLetterReason,
    ).toBeUndefined();
    expect(await txByExternalId(msg.data.externalTransactionId)).toBeUndefined();
    expect(await balanceOf(app(), w.walletId)).toBe("100.00");
  }, 30_000);
});
