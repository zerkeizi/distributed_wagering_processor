import { Module } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { SqsQueueResolver } from "../../../shared/infrastructure/sqs/sqs-queue-resolver.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction.ts";
import { UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.module.ts";
import { WageringCoreModule } from "../../wagering-core.module.ts";
import { WagerMessageHandler } from "./wager-message-handler.ts";
import { WagerTransactionConsumer } from "./wager-transaction.consumer.ts";

/** Entrada SQS: ativado pelo papel `consumer` em ROLES. */
@Module({
  imports: [WageringCoreModule],
  providers: [
    SqsQueueResolver,
    {
      provide: WagerMessageHandler,
      inject: [SubmitWagerTransaction, UNIT_OF_WORK, WAGERING_TELEMETRY, PinoLogger],
      useFactory: (
        submit: SubmitWagerTransaction,
        uow: UnitOfWork,
        telemetry: WageringTelemetry,
        logger: PinoLogger,
      ) => {
        logger.setContext("WagerMessageHandler");
        return new WagerMessageHandler(submit, uow, telemetry, logger);
      },
    },
    WagerTransactionConsumer,
  ],
})
export class SqsConsumerModule {}
