import { Module } from "@nestjs/common";
import {
  PROVIDER_IDENTITY,
  UnauthenticatedProviderIdentity,
} from "../shared/auth/provider-identity.port.ts";
import { KeyedMutex, WALLET_MUTEX } from "../shared/concurrency/keyed-mutex.ts";
import type { AppConfig } from "../shared/config/app-config.ts";
import { APP_CONFIG } from "../shared/config/config.module.ts";
import { ExponentialBackoff } from "../shared/domain/exponential-backoff.ts";
import { CLOCK, type Clock } from "./application/ports/clock.ts";
import { ID_GENERATOR, type IdGenerator } from "./application/ports/id-generator.ts";
import { WAGERING_TELEMETRY, type WageringTelemetry } from "./application/ports/telemetry.ts";
import type { UnitOfWork } from "./application/ports/unit-of-work.ts";
import { CreateWallet } from "./application/use-cases/create-wallet.ts";
import { GetWagerTransaction } from "./application/use-cases/get-wager-transaction.ts";
import { GetWallet } from "./application/use-cases/get-wallet.ts";
import { ListLedger } from "./application/use-cases/list-ledger.ts";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet.ts";
import { SubmitWagerTransaction } from "./application/use-cases/submit-wager-transaction.ts";
import { ReferenceResolutionPolicy } from "./domain/reference-resolution-policy.ts";
import { WageringTelemetryAdapter } from "./infrastructure/observability/wagering-telemetry.adapter.ts";
import { UNIT_OF_WORK } from "./infrastructure/persistence/persistence.module.ts";

/**
 * Monta os use cases (sem decorators do Nest) por factory, recebendo as portas. HTTP e consumer SQS
 * importam este módulo e usam exatamente as mesmas instâncias (CHALLENGE §10).
 */
@Module({
  providers: [
    // Uma fila por instância da aplicação: HTTP, consumer e worker dela compartilham a mesma. Factory,
    // não `useValue`: um valor no decorator seria único por PROCESSO, e várias apps no mesmo processo
    // (testes de concorrência) deixariam de se comportar como instâncias separadas.
    { provide: WALLET_MUTEX, useFactory: () => new KeyedMutex() },
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
      inject: [APP_CONFIG, UNIT_OF_WORK, CLOCK, ID_GENERATOR, WAGERING_TELEMETRY, WALLET_MUTEX],
      useFactory: (
        config: AppConfig,
        uow: UnitOfWork,
        clock: Clock,
        ids: IdGenerator,
        telemetry: WageringTelemetry,
        walletMutex: KeyedMutex,
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
          walletMutex,
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
  exports: [
    WALLET_MUTEX,
    WAGERING_TELEMETRY,
    PROVIDER_IDENTITY,
    CreateWallet,
    GetWallet,
    ListLedger,
    ReconcileWallet,
    SubmitWagerTransaction,
    GetWagerTransaction,
  ],
})
export class WageringCoreModule {}
