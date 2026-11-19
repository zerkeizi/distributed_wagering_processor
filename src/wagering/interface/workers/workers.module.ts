import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type DynamicModule, Module, type Provider } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { type KeyedMutex, WALLET_MUTEX } from "../../../shared/concurrency/keyed-mutex.ts";
import type { AppConfig, Role } from "../../../shared/config/app-config.ts";
import { APP_CONFIG } from "../../../shared/config/config.module.ts";
import { ExponentialBackoff } from "../../../shared/domain/exponential-backoff.ts";
import { SQS_CLIENT } from "../../../shared/infrastructure/infrastructure.module.ts";
import { SqsQueueResolver } from "../../../shared/infrastructure/sqs/sqs-queue-resolver.ts";
import { CLOCK, type Clock } from "../../application/ports/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "../../application/ports/id-generator.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { RelayOutbox } from "../../application/use-cases/relay-outbox.ts";
import { ResolvePendingReferences } from "../../application/use-cases/resolve-pending-references.ts";
import { ReferenceResolutionPolicy } from "../../domain/reference-resolution-policy.ts";
import { SqsEventPublisher } from "../../infrastructure/messaging/sqs-event-publisher.ts";
import { MikroOrmOutboxStore } from "../../infrastructure/persistence/mikro-orm-outbox-store.ts";
import { UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.module.ts";
import { WageringCoreModule } from "../../wagering-core.module.ts";
import { OutboxPublisherWorker } from "./outbox-publisher.worker.ts";
import { PendingReferenceWorker } from "./pending-reference.worker.ts";

const outboxProviders: Provider[] = [
  SqsQueueResolver,
  {
    provide: RelayOutbox,
    inject: [MikroORM, SQS_CLIENT, SqsQueueResolver, CLOCK, WAGERING_TELEMETRY, APP_CONFIG],
    useFactory: (
      orm: MikroORM,
      sqs: SQSClient,
      queues: SqsQueueResolver,
      clock: Clock,
      telemetry: WageringTelemetry,
      config: AppConfig,
    ) =>
      new RelayOutbox(
        new MikroOrmOutboxStore(orm),
        new SqsEventPublisher(sqs, queues, config.sqs.eventsQueueName),
        clock,
        telemetry,
        {
          batchSize: config.outbox.batchSize,
          leaseMs: config.outbox.leaseMs,
          backoff: new ExponentialBackoff(config.outbox.retryBaseMs, config.outbox.retryMaxMs),
        },
      ),
  },
  OutboxPublisherWorker,
];

const pendingReferenceProviders: Provider[] = [
  {
    provide: ResolvePendingReferences,
    inject: [
      UNIT_OF_WORK,
      CLOCK,
      ID_GENERATOR,
      WAGERING_TELEMETRY,
      APP_CONFIG,
      PinoLogger,
      WALLET_MUTEX,
    ],
    useFactory: (
      uow: UnitOfWork,
      clock: Clock,
      ids: IdGenerator,
      telemetry: WageringTelemetry,
      config: AppConfig,
      logger: PinoLogger,
      walletMutex: KeyedMutex,
    ) => {
      const retry = config.wagering.referenceRetry;
      logger.setContext("ResolvePendingReferences");
      return new ResolvePendingReferences({
        uow,
        clock,
        ids,
        telemetry,
        resolutionPolicy: new ReferenceResolutionPolicy(
          retry.maxRetries,
          new ExponentialBackoff(retry.baseDelayMs, retry.maxDelayMs),
        ),
        walletLockTimeoutMs: config.wagering.walletLockTimeoutMs,
        walletMutex,
        batchSize: config.pendingReferences.batchSize,
        onFailure: (transactionId, error) =>
          logger.error(
            { err: error, transactionId },
            "pending reference failed permanently; marking FAILED",
          ),
      });
    },
  },
  PendingReferenceWorker,
];

/** Workers de fundo, ligados pelos papéis em ROLES. */
@Module({})
export class WorkersModule {
  static forRoles(roles: readonly Role[]): DynamicModule {
    return {
      module: WorkersModule,
      imports: [WageringCoreModule],
      providers: [
        ...(roles.includes("outbox-publisher") ? outboxProviders : []),
        ...(roles.includes("pending-reference-worker") ? pendingReferenceProviders : []),
      ],
    };
  }
}
