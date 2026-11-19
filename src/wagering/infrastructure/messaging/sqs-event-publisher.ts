import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { SqsQueueResolver } from "../../../shared/infrastructure/sqs/sqs-queue-resolver.ts";
import type { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import type { EventPublisher } from "../../application/ports/outbox-store.ts";

/**
 * Publica na `wagering-events.fifo` (ADR 0013): grupo = aggregateId (wallet), para ordem por wallet;
 * deduplicação = eventId, então republicar o mesmo evento dentro da janela de 5 min do SQS FIFO nem
 * chega ao consumidor. Fora da janela, o consumidor deduplica pelo `eventId` do envelope.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueueResolver,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.urlFor(this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
          eventId: { DataType: "String", StringValue: message.id },
        },
      }),
    );
  }
}
