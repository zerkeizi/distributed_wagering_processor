/**
 * Fila de ponta a ponta contra o compose (bun run infra:up): publica mensagens direto na
 * `wager-transactions.fifo` do LocalStack e observa o efeito pela API. As 3 réplicas consomem a fila.
 *   1) BET pela fila → aplicada.
 *   2) A mesma mensagem (mesmo messageId) entregue de novo 3× → inbox ignora, sem débito extra.
 *   3) Mensagem malformada → vai para a DLQ com o motivo.
 */
import {
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // biome-ignore lint/suspicious/noExplicitAny: inspeção livre do JSON de resposta
  return { status: res.status, body: (await res.json()) as any };
}

const queueUrl = async (name: string) =>
  (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl as string;

async function publish(url: string, body: string, groupId: string, correlationId: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageAttributes: { correlationId: { DataType: "String", StringValue: correlationId } },
    }),
  );
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  throw new Error("timed out waiting");
}

export async function smokeSqs(): Promise<void> {
  const wagerUrl = await queueUrl("wager-transactions.fifo");
  const dlqUrl = await queueUrl("wager-transactions-dlq.fifo");
  const run = `sqs-${Date.now()}`;

  const playerId = crypto.randomUUID();
  const wallet = await api("POST", "/wallets", {
    playerId,
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
  const walletId = wallet.body.id as string;
  console.log(`Wallet ${walletId} aberta com 100.00\n`);

  const ext = `bet-${crypto.randomUUID()}`;
  const message = {
    messageId: `${run}-msg-1`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
    },
  };

  console.log("1) BET de 30.00 publicada na fila:");
  await publish(wagerUrl, JSON.stringify(message), walletId, `${run}-1`);
  const tx = await waitFor(async () => {
    const res = await api("GET", `/providers/provider-a/wagering/transactions/${ext}`);
    return res.status === 200 ? res.body : undefined;
  });
  console.log(`   transação ${tx.id}: ${tx.status} · saldo depois: ${tx.balanceAfter.amount}`);

  console.log("\n2) A mesma mensagem (mesmo messageId) entregue mais 3 vezes:");
  for (let i = 2; i <= 4; i++)
    await publish(wagerUrl, JSON.stringify(message), walletId, `${run}-${i}`);
  await Bun.sleep(3_000);
  const after = await api("GET", `/wallets/${walletId}`);
  const ledger = await api("GET", `/wallets/${walletId}/ledger`);
  const debits = ledger.body.items.filter(
    (i: { direction: string }) => i.direction === "DEBIT",
  ).length;
  console.log(
    `   saldo: ${after.body.balance.amount} · lançamentos de débito: ${debits} (inbox ignorou as reentregas)`,
  );

  console.log("\n3) Mensagem malformada:");
  const marker = `${run}-garbage`;
  await publish(wagerUrl, `{ isto não é JSON ${marker}`, "smoke", `${run}-garbage`);
  const dead = await waitFor(async () => {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 0,
        MessageAttributeNames: ["All"],
      }),
    );
    return (res.Messages ?? []).find((m: Message) => m.Body?.includes(marker));
  });
  console.log(`   na DLQ, motivo: ${dead.MessageAttributes?.deadLetterReason?.StringValue}`);

  const metrics = await (await fetch(`${BASE_URL}/metrics`)).text();
  const pick = (prefix: string) =>
    metrics
      .split("\n")
      .filter((l) => l.startsWith(prefix))
      .join("\n   ");
  console.log("\nMétricas da réplica que atendeu este GET /metrics (cada réplica tem as suas):");
  console.log(`   ${pick("wagering_duplicates_detected_total{")}`);
  console.log(`   ${pick("wagering_dlq_messages_total{")}`);
}
