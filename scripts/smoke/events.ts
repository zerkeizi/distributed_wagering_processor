/**
 * Workers de fundo contra o compose (bun run infra:up):
 *   1) ROLLBACK chega antes da BET → 202; a BET chega → o worker de PENDING_REFERENCE resolve o
 *      ROLLBACK sozinho, sem reenvio do provider.
 *   2) Os eventos de integração da wallet chegam em `wagering-events.fifo` pelo outbox publisher.
 */
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // biome-ignore lint/suspicious/noExplicitAny: inspeção livre do JSON de resposta
  return { status: res.status, body: (await res.json()) as any };
}

export async function smokeEvents(): Promise<void> {
  const playerId = crypto.randomUUID();
  const wallet = await api("POST", "/wallets", {
    playerId,
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  const walletId = wallet.body.id as string;
  const submit = (kind: string, ext: string, amount: string, ref?: string) =>
    api(
      "POST",
      "/wagering/transactions",
      {
        providerId: "provider-a",
        externalTransactionId: ext,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind,
        money: { amount, currency: "BRL" },
        ...(ref ? { referenceExternalTransactionId: ref } : {}),
      },
      { "idempotency-key": `provider-a:${ext}` },
    );

  const betExt = `bet-${crypto.randomUUID()}`;
  const rbExt = `rollback-${crypto.randomUUID()}`;
  console.log(`Wallet ${walletId} aberta com 100.00\n`);
  console.log("1) Referência fora de ordem:");
  const rb = await submit("ROLLBACK", rbExt, "40.00", betExt);
  console.log(`   ROLLBACK antes da BET  → ${rb.status} ${rb.body.status}`);
  const bet = await submit("BET", betExt, "40.00");
  console.log(
    `   BET chega              → ${bet.status} ${bet.body.status} · saldo ${bet.body.balance.amount}`,
  );
  const started = Date.now();
  let resolved: { status: string; balanceAfter: { amount: string } | null } | undefined;
  while (Date.now() - started < 15_000) {
    const r = await api("GET", `/providers/provider-a/wagering/transactions/${rbExt}`);
    if (r.body.status !== "PENDING_REFERENCE") {
      resolved = r.body;
      break;
    }
    await Bun.sleep(200);
  }
  console.log(
    `   worker resolveu o ROLLBACK sozinho em ${Date.now() - started} ms → ${resolved?.status} · saldo ${resolved?.balanceAfter?.amount}`,
  );

  console.log("\n2) Eventos publicados em wagering-events.fifo (via outbox):");
  const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: "wagering-events.fifo" })))
    .QueueUrl as string;
  const mine: { type: string; version?: number; ts: string }[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && mine.length < 7) {
    // FIFO só entrega a próxima mensagem de um grupo depois que a anterior é apagada: consumimos
    // (apagamos) os eventos desta wallet, como um consumidor de verdade faria.
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    for (const m of res.Messages ?? []) {
      const e = JSON.parse(m.Body ?? "{}");
      if (e.aggregateId !== walletId) continue; // de outras wallets: volta à fila após a visibilidade
      if (!mine.some((x) => x.ts === e.eventId)) {
        mine.push({ type: e.eventType, version: e.data?.walletVersion, ts: e.eventId });
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  for (const e of mine.sort((a, b) => a.ts.localeCompare(b.ts))) {
    console.log(`   ${e.type}${e.version ? ` (walletVersion ${e.version})` : ""}`);
  }
}
