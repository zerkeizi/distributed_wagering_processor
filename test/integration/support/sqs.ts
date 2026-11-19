import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export interface TestQueues {
  readonly env: Record<string, string>;
  readonly wagerUrl: string;
  readonly dlqUrl: string;
  destroy(): Promise<void>;
}

/** Filas exclusivas de uma suíte (prefixo aleatório): suítes não consomem mensagens umas das outras. */
export async function createTestQueues(maxReceiveCount = 3): Promise<TestQueues> {
  const prefix = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const names = {
    wager: `${prefix}-wager-transactions.fifo`,
    dlq: `${prefix}-wager-transactions-dlq.fifo`,
    events: `${prefix}-wagering-events.fifo`,
  };
  const create = async (name: string, attributes: Record<string, string> = {}) =>
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false", ...attributes },
        }),
      )
    ).QueueUrl as string;
  const dlqUrl = await create(names.dlq);
  const dlqArn = (
    await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
    )
  ).Attributes?.QueueArn;
  const wagerUrl = await create(names.wager, {
    VisibilityTimeout: "30",
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(maxReceiveCount),
    }),
  });
  const eventsUrl = await create(names.events);
  return {
    env: {
      SQS_WAGER_QUEUE_NAME: names.wager,
      SQS_WAGER_DLQ_NAME: names.dlq,
      SQS_EVENTS_QUEUE_NAME: names.events,
    },
    wagerUrl,
    dlqUrl,
    async destroy() {
      for (const url of [wagerUrl, dlqUrl, eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
      }
    },
  };
}

export async function sendRaw(
  queueUrl: string,
  body: string,
  options: { groupId?: string; dedupId?: string; correlationId?: string } = {},
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId ?? "g",
      MessageDeduplicationId: options.dedupId ?? crypto.randomUUID(),
      ...(options.correlationId
        ? {
            MessageAttributes: {
              correlationId: { DataType: "String", StringValue: options.correlationId },
            },
          }
        : {}),
    }),
  );
}

/** Mensagens visíveis + em processamento (invisíveis). */
export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const attrs = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    )
  ).Attributes;
  return {
    visible: Number(attrs?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(attrs?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/** Lê (sem apagar) as mensagens de uma fila, com atributos — usado para inspecionar a DLQ. */
export async function peek(queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      VisibilityTimeout: 0,
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  return res.Messages ?? [];
}

/** Espera uma condição assíncrona (polling), com prazo. */
export async function eventually<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!accept(last)) {
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    await Bun.sleep(intervalMs);
    last = await probe();
  }
  return last;
}
