import { type DynamicModule, Module } from "@nestjs/common";
import { AppController } from "./app.controller.ts";
import { HealthModule } from "./health/health.module.ts";
import { type AppConfig, loadConfig } from "./shared/config/app-config.ts";
import { ConfigModule } from "./shared/config/config.module.ts";
import { InfrastructureModule } from "./shared/infrastructure/infrastructure.module.ts";
import { ObservabilityModule } from "./shared/observability/observability.module.ts";
import { PersistenceModule } from "./wagering/infrastructure/persistence/persistence.module.ts";

/**
 * O servidor HTTP sobe em toda instância (health e métricas são sempre necessários); os papéis
 * em `ROLES` ligam os módulos de negócio e os workers, que entram nos próximos passos.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule,
        InfrastructureModule,
        PersistenceModule,
        HealthModule,
      ],
      controllers: [AppController],
    };
  }
}
