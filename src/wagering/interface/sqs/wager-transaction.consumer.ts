import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { AppConfig } from "../../../shared/config/app-config.ts";
import { APP_CONFIG } from "../../../shared/config/config.module.ts";
import { ExponentialBackoff } from "../../../shared/domain/exponential-backoff.ts";
import { SQS_CLIENT } from "../../../shared/infrastructure/infrastructure.module.ts";
import { SqsQueueResolver } from "../../../shared/infrastructure/sqs/sqs-queue-resolver.ts";
import { crashPoint } from "../../../shared/testing/crash-point.ts";
import { PersistenceUnavailableError } from "../../application/ports/persistence-errors.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.module.ts";
import { type HandlingDecision, WagerMessageHandler } from "./wager-message-handler.ts";

/** SQS limita o visibility timeout a 12 h. */
const MAX_VISIBILITY_SECONDS = 43_200;
const DLQ_SAMPLE_INTERVAL_MS = 15_000;

type MessageState = "queued" | "processing" | "done";

interface Tracked {
  readonly message: Message;
  state: MessageState;
}

/**
 * Consumer da fila `wager-transactions.fifo` (CHALLENGE §10, ADR 0014).
 *
 * - Long polling em lote; mensagens do mesmo MessageGroupId (= wallet) em sequência, grupos
 *   diferentes em paralelo. A ordem do FIFO é otimização: a correção vem do lock e do inbox.
 * - Ack (DeleteMessage) só depois que o handler devolveu — ou seja, depois do commit.
 * - SIGTERM: para de receber, espera as mensagens em andamento até `SHUTDOWN_GRACE_MS` e devolve
 *   à fila (visibilidade 0) tudo que não terminou.
 * - Circuit breaker: se o BANCO cai, o consumer para de receber mensagens e só sonda o banco até ele
 *   voltar. Sem isso, cada mensagem recebida durante a queda gastaria uma das entregas permitidas e,
 *   numa queda de ~1 min, mensagens válidas iriam para a DLQ (CHALLENGE §3).
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private readonly receiveAbort = new AbortController();
  private loop: Promise<void> | undefined;
  private current: { readonly batch: Tracked[]; readonly done: Promise<void> } | undefined;
  private dlqTimer: ReturnType<typeof setInterval> | undefined;
  private readonly backoff: ExponentialBackoff;
  private readonly probeBackoff: ExponentialBackoff;
  /** Circuit breaker aberto: banco indisponível, nada é recebido até ele responder. */
  private paused = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly queues: SqsQueueResolver,
    @Inject(WagerMessageHandler) private readonly handler: WagerMessageHandler,
    @Inject(WAGERING_TELEMETRY) private readonly telemetry: WageringTelemetry,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("WagerTransactionConsumer");
    const c = config.sqs.consumer;
    this.backoff = new ExponentialBackoff(c.retryBaseMs, Math.max(c.retryBaseMs, c.retryMaxMs));
    this.probeBackoff = new ExponentialBackoff(c.pauseProbeMs, c.pauseProbeMaxMs);
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.dlqTimer = setInterval(() => void this.sampleDlqDepth(), DLQ_SAMPLE_INTERVAL_MS);
    this.dlqTimer.unref();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.dlqTimer);
    this.receiveAbort.abort();
    const current = this.current;
    if (current) {
      this.logger.info({ signal, inFlight: current.batch.length }, "draining in-flight messages");
      const finished = await Promise.race([
        current.done.then(() => true),
        Bun.sleep(this.config.shutdownGraceMs).then(() => false),
      ]);
      if (!finished)
        this.logger.warn("shutdown grace period elapsed; returning messages to the queue");
      await this.releaseUnfinished(current.batch);
      // Mensagem que estourou o prazo pode continuar presa (ex.: esperando lock): não esperamos por
      // ela. Se ainda confirmar depois, a reentrega cai no inbox e não repete o efeito.
      if (!finished) return;
    }
    await this.loop;
  }

  private async run(): Promise<void> {
    const queueUrl = await this.waitForQueue();
    if (!queueUrl) return;
    this.logger.info({ queue: this.config.sqs.wagerQueueName }, "consumer started");
    let failures = 0;
    while (this.running) {
      if (this.paused) {
        await this.waitForDatabase();
        continue;
      }
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.config.sqs.consumer.batchSize,
            WaitTimeSeconds: this.config.sqs.consumer.waitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
            MessageAttributeNames: ["All"],
          }),
          { abortSignal: this.receiveAbort.signal },
        );
        failures = 0;
        const messages = res.Messages ?? [];
        if (messages.length === 0) continue;
        const batch: Tracked[] = messages.map((message) => ({ message, state: "queued" }));
        if (!this.running) {
          await this.releaseUnfinished(batch);
          break;
        }
        const done = this.processBatch(queueUrl, batch);
        this.current = { batch, done };
        await done;
        this.current = undefined;
      } catch (error) {
        if (!this.running) break;
        failures += 1;
        this.logger.warn({ err: error, failures }, "receive failed; backing off");
        await Bun.sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    }
    this.logger.info("consumer stopped");
  }

  /** Grupos (wallets) em paralelo; dentro do grupo, em ordem. */
  private async processBatch(queueUrl: string, batch: Tracked[]): Promise<void> {
    const groups = new Map<string, Tracked[]>();
    for (const tracked of batch) {
      const group = tracked.message.Attributes?.MessageGroupId ?? tracked.message.MessageId ?? "";
      groups.set(group, [...(groups.get(group) ?? []), tracked]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(queueUrl, group)));
  }

  private async processGroup(queueUrl: string, group: Tracked[]): Promise<void> {
    let delayRestSeconds: number | undefined;
    for (const tracked of group) {
      if (!this.running) return; // o shutdown devolve o que sobrou
      if (this.paused && delayRestSeconds === undefined) {
        // Outro grupo do lote descobriu que o banco caiu: nem tenta; devolve para depois.
        delayRestSeconds = this.pauseVisibilitySeconds();
      }
      if (delayRestSeconds !== undefined) {
        // Uma mensagem do grupo falhou de forma transitória: as seguintes esperam junto, para não
        // passarem na frente dela (preserva a ordem do FIFO).
        await this.changeVisibility(queueUrl, tracked.message, delayRestSeconds);
        tracked.state = "done";
        continue;
      }
      tracked.state = "processing";
      const decision = await this.decide(tracked.message);
      const delay = await this.apply(queueUrl, tracked.message, decision);
      tracked.state = "done";
      if (delay !== undefined) delayRestSeconds = delay;
    }
  }

  private async decide(message: Message): Promise<HandlingDecision> {
    try {
      return await this.handler.handle({
        body: message.Body ?? "",
        correlationId: message.MessageAttributes?.correlationId?.StringValue,
      });
    } catch (error) {
      if (error instanceof PersistenceUnavailableError) {
        return { action: "retry", reason: "dependency_unavailable", detail: error.name };
      }
      this.logger.error({ err: error, sqsMessageId: message.MessageId }, "handler failed");
      return { action: "retry", reason: "unexpected", detail: "handler threw" };
    }
  }

  /** @returns o atraso aplicado, se a mensagem foi adiada. */
  private async apply(
    queueUrl: string,
    message: Message,
    decision: HandlingDecision,
  ): Promise<number | undefined> {
    try {
      switch (decision.action) {
        case "ack":
          // Commit já aconteceu; morrer aqui faz o SQS reentregar e o inbox absorver (CHALLENGE §13.5).
          crashPoint("consumer:after-commit-before-ack");
          await this.delete(queueUrl, message);
          return undefined;
        case "dead-letter":
          await this.deadLetter(queueUrl, message, decision.reason, decision.detail);
          return undefined;
        case "retry": {
          if (decision.reason === "dependency_unavailable") {
            this.openCircuit();
            const seconds = this.pauseVisibilitySeconds();
            await this.changeVisibility(queueUrl, message, seconds);
            this.telemetry.retryScheduled("sqs_consumer");
            return seconds;
          }
          const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
          const seconds = Math.min(
            MAX_VISIBILITY_SECONDS,
            Math.ceil(this.backoff.delayMs(Math.max(1, receiveCount)) / 1000),
          );
          await this.changeVisibility(queueUrl, message, seconds);
          this.telemetry.retryScheduled("sqs_consumer");
          this.logger.warn(
            {
              sqsMessageId: message.MessageId,
              receiveCount,
              retryInSeconds: seconds,
              reason: decision.detail,
            },
            "transient failure; message will be retried",
          );
          return seconds;
        }
      }
    } catch (error) {
      // Não conseguiu falar com o SQS: a mensagem reaparece quando a visibilidade expirar, e o
      // inbox garante que um efeito já confirmado não se repete.
      this.logger.error(
        { err: error, sqsMessageId: message.MessageId },
        "failed to settle message with SQS",
      );
      return undefined;
    }
  }

  /** Move para a DLQ explicitamente (sem esperar o maxReceiveCount) e apaga da fila de origem. */
  private async deadLetter(queueUrl: string, message: Message, reason: string, detail: string) {
    const dlqUrl = await this.queues.urlFor(this.config.sqs.wagerDlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        MessageAttributes: {
          deadLetterReason: { DataType: "String", StringValue: reason },
          deadLetterDetail: { DataType: "String", StringValue: detail.slice(0, 256) },
          originalSqsMessageId: { DataType: "String", StringValue: message.MessageId ?? "unknown" },
        },
      }),
    );
    await this.delete(queueUrl, message);
    this.telemetry.deadLettered(reason);
    this.logger.warn({ sqsMessageId: message.MessageId, reason, detail }, "message moved to DLQ");
  }

  private delete(queueUrl: string, message: Message) {
    return this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private changeVisibility(queueUrl: string, message: Message, seconds: number) {
    return this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Visibilidade 0: a mensagem volta para a fila na hora, para outra instância pegar. */
  private async releaseUnfinished(batch: Tracked[]): Promise<void> {
    const queueUrl = await this.queues.urlFor(this.config.sqs.wagerQueueName);
    const unfinished = batch.filter((t) => t.state !== "done");
    await Promise.all(
      unfinished.map((t) =>
        this.changeVisibility(queueUrl, t.message, 0).catch((error) =>
          this.logger.warn(
            { err: error, sqsMessageId: t.message.MessageId },
            "failed to release message",
          ),
        ),
      ),
    );
    if (unfinished.length > 0) {
      this.logger.info(
        { released: unfinished.length },
        "returned unfinished messages to the queue",
      );
    }
  }

  private openCircuit(): void {
    if (this.paused) return;
    this.paused = true;
    this.telemetry.consumerPaused(true);
    this.logger.warn("database unavailable; consumer paused until it responds again");
  }

  /** Sonda o banco com backoff até ele responder, sem receber mensagens enquanto isso. */
  private async waitForDatabase(): Promise<void> {
    for (let attempt = 1; this.running; attempt++) {
      try {
        await this.uow.ping();
        this.paused = false;
        this.telemetry.consumerPaused(false);
        this.logger.info({ probes: attempt }, "database is back; consumer resumed");
        return;
      } catch {
        await this.sleepUnlessStopping(this.probeBackoff.delayMs(attempt));
      }
    }
  }

  /** Visibilidade curta: a mensagem volta logo, mas só é recebida de novo quando o banco voltar. */
  private pauseVisibilitySeconds(): number {
    return Math.max(1, Math.ceil(this.config.sqs.consumer.pauseProbeMs / 1000));
  }

  private async sleepUnlessStopping(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (this.running && Date.now() < deadline) {
      await Bun.sleep(Math.min(200, deadline - Date.now()));
    }
  }

  private async waitForQueue(): Promise<string | undefined> {
    for (let attempt = 1; this.running; attempt++) {
      try {
        return await this.queues.urlFor(this.config.sqs.wagerQueueName);
      } catch (error) {
        this.logger.warn({ err: error, attempt }, "queue not available yet");
        await Bun.sleep(Math.min(10_000, 500 * attempt));
      }
    }
    return undefined;
  }

  private async sampleDlqDepth(): Promise<void> {
    try {
      const dlqUrl = await this.queues.urlFor(this.config.sqs.wagerDlqName);
      const res = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      this.telemetry.dlqDepthObserved(Number(res.Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch {
      // métrica é best-effort
    }
  }
}
