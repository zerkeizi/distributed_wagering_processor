import { SQSClient } from "@aws-sdk/client-sqs";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import type { AppConfig } from "../config/app-config.ts";
import { APP_CONFIG } from "../config/config.module.ts";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

/**
 * Pool dedicado aos health checks: uma conexão só, para que a sonda de readiness não dispute
 * conexões com o fluxo financeiro (que terá o pool do MikroORM no passo 3).
 */
export const HEALTH_PG_POOL = Symbol("HEALTH_PG_POOL");

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.aws.region,
          ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
          ...(config.aws.credentials ? { credentials: config.aws.credentials } : {}),
        }),
    },
    {
      provide: HEALTH_PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const pool = new Pool({
          connectionString: config.database.url,
          max: 1,
          connectionTimeoutMillis: config.healthCheckTimeoutMs,
          idleTimeoutMillis: 30_000,
        });
        // Sem listener, um erro numa conexão ociosa (ex.: Postgres reiniciado) derruba o processo.
        pool.on("error", () => {});
        return pool;
      },
    },
  ],
  exports: [SQS_CLIENT, HEALTH_PG_POOL],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(HEALTH_PG_POOL) private readonly pool: Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.pool.end();
  }
}
