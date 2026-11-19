import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { AppConfig } from "../../../shared/config/app-config.ts";
import { APP_CONFIG } from "../../../shared/config/config.module.ts";
import { PollingLoop } from "../../../shared/workers/polling-loop.ts";
import { RelayOutbox } from "../../application/use-cases/relay-outbox.ts";

/** Papel `outbox-publisher`: várias instâncias podem rodar juntas (claim com SKIP LOCKED). */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(RelayOutbox) relay: RelayOutbox,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("OutboxPublisher");
    this.loop = new PollingLoop(
      async () => {
        const result = await relay.tick();
        if (result.failed > 0)
          this.logger.warn(result, "some events failed to publish; retry scheduled");
        // Lote cheio: provavelmente há mais; roda de novo sem esperar.
        return result.claimed >= config.outbox.batchSize;
      },
      config.outbox.pollIntervalMs,
      (error) => this.logger.error({ err: error }, "outbox relay tick failed"),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
    this.logger.info("outbox publisher started");
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
    this.logger.info("outbox publisher stopped");
  }
}
