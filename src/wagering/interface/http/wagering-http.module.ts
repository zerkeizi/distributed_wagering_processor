import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import {
  PROVIDER_IDENTITY,
  UnauthenticatedProviderIdentity,
} from "../../../shared/auth/provider-identity.port.ts";
import type { AppConfig } from "../../../shared/config/app-config.ts";
import { APP_CONFIG } from "../../../shared/config/config.module.ts";
import { ExponentialBackoff } from "../../../shared/domain/exponential-backoff.ts";
import { CLOCK, type Clock } from "../../application/ports/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "../../application/ports/id-generator.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { CreateWallet } from "../../application/use-cases/create-wallet.ts";
import { GetWagerTransaction } from "../../application/use-cases/get-wager-transaction.ts";
import { GetWallet } from "../../application/use-cases/get-wallet.ts";
import { ListLedger } from "../../application/use-cases/list-ledger.ts";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet.ts";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction.ts";
import { ReferenceResolutionPolicy } from "../../domain/reference-resolution-policy.ts";
import { WageringTelemetryAdapter } from "../../infrastructure/observability/wagering-telemetry.adapter.ts";
import { UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.module.ts";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { WageringController } from "./wagering.controller.ts";
import { WalletsController } from "./wallets.controller.ts";

/**
 * Os use cases não têm decorators do Nest: são montados aqui por factory, recebendo as portas.
 * Assim a camada de aplicação continua testável e independente do framework.
 */
@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: WAGERING_TELEMETRY, useClass: WageringTelemetryAdapter },
    { provide: PROVIDER_IDENTITY, useClass: UnauthenticatedProviderIdentity },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, WAGERING_TELEMETRY],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, t: WageringTelemetry) =>
        new CreateWallet(uow, clock, ids, t),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWallet(uow),
    },
    {
      provide: ListLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ListLedger(uow),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [APP_CONFIG, UNIT_OF_WORK, CLOCK, ID_GENERATOR, WAGERING_TELEMETRY],
      useFactory: (
        config: AppConfig,
        uow: UnitOfWork,
        clock: Clock,
        ids: IdGenerator,
        telemetry: WageringTelemetry,
      ) => {
        const retry = config.wagering.referenceRetry;
        return new SubmitWagerTransaction({
          uow,
          clock,
          ids,
          telemetry,
          resolutionPolicy: new ReferenceResolutionPolicy(
            retry.maxRetries,
            new ExponentialBackoff(retry.baseDelayMs, retry.maxDelayMs),
          ),
          walletLockTimeoutMs: config.wagering.walletLockTimeoutMs,
        });
      },
    },
    {
      provide: GetWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow),
    },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, CLOCK, WAGERING_TELEMETRY],
      useFactory: (uow: UnitOfWork, clock: Clock, t: WageringTelemetry) =>
        new ReconcileWallet(uow, clock, t),
    },
  ],
})
export class WageringHttpModule {}
