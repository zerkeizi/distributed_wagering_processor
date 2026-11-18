import { Global, Module } from "@nestjs/common";
import { LoggingModule } from "./logging.module.ts";
import { MetricsController } from "./metrics.controller.ts";
import { MetricsService } from "./metrics.service.ts";

@Global()
@Module({
  imports: [LoggingModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
