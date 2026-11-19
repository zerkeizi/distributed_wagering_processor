import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import {
  PROVIDER_IDENTITY,
  UnauthenticatedProviderIdentity,
} from "../../../shared/auth/provider-identity.port.ts";
import { CLOCK, type Clock } from "../../application/ports/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "../../application/ports/id-generator.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "../../application/ports/telemetry.ts";
import type { UnitOfWork } from "../../application/ports/unit-of-work.ts";
import { CreateWallet } from "../../application/use-cases/create-wallet.ts";
import { GetWallet } from "../../application/use-cases/get-wallet.ts";
import { ListLedger } from "../../application/use-cases/list-ledger.ts";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet.ts";
import { WageringTelemetryAdapter } from "../../infrastructure/observability/wagering-telemetry.adapter.ts";
import { UNIT_OF_WORK } from "../../infrastructure/persistence/persistence.module.ts";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { WalletsController } from "./wallets.controller.ts";

/**
 * Os use cases não têm decorators do Nest: são montados aqui por factory, recebendo as portas.
 * Assim a camada de aplicação continua testável e independente do framework.
 */
@Module({
  controllers: [WalletsController],
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
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, CLOCK, WAGERING_TELEMETRY],
      useFactory: (uow: UnitOfWork, clock: Clock, t: WageringTelemetry) =>
        new ReconcileWallet(uow, clock, t),
    },
  ],
})
export class WageringHttpModule {}
