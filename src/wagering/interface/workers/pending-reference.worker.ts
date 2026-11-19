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
import { ResolvePendingReferences } from "../../application/use-cases/resolve-pending-references.ts";

/** Papel `pending-reference-worker` (CHALLENGE §7.1). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(ResolvePendingReferences) resolver: ResolvePendingReferences,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("PendingReferenceWorker");
    this.loop = new PollingLoop(
      async () => {
        const result = await resolver.tick();
        if (result.examined > 0) this.logger.info(result, "pending references examined");
        return result.examined >= config.pendingReferences.batchSize;
      },
      config.pendingReferences.pollIntervalMs,
      (error) => this.logger.error({ err: error }, "pending reference tick failed"),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
    this.logger.info("pending reference worker started");
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
    this.logger.info("pending reference worker stopped");
  }
}
