import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { SQS_CLIENT } from "../infrastructure.module.ts";

/** Resolve nome → URL da fila uma vez e guarda (a URL não muda durante a vida do processo). */
@Injectable()
export class SqsQueueResolver {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  urlFor(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${queueName} has no URL`);
        return r.QueueUrl;
      });
      // Falha (ex.: LocalStack ainda subindo) não fica em cache: a próxima chamada tenta de novo.
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}
