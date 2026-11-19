import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { MetricsService } from "../../../shared/observability/metrics.service.ts";
import type {
  EntryChannel,
  ReconciliationDivergence,
  WageringTelemetry,
} from "../../application/ports/telemetry.ts";

/** Implementa a porta de telemetria com prom-client (métricas) e pino (logs estruturados). */
@Injectable()
export class WageringTelemetryAdapter implements WageringTelemetry {
  constructor(
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("Wagering");
  }

  transactionCompleted(kind: string, status: string, channel: EntryChannel): void {
    this.metrics.transactions.inc({ kind, status, channel });
  }

  reconciliationDivergence(divergence: ReconciliationDivergence): void {
    this.metrics.reconciliationDivergences.inc();
    // Diferença e tipos de anomalia ajudam o diagnóstico; nenhum saldo completo vai para o log.
    this.logger.warn(
      {
        walletId: divergence.walletId,
        differenceAmount: divergence.difference.amount,
        anomalies: divergence.anomalies.map((a) => a.type),
      },
      "wallet reconciliation found a divergence",
    );
  }
}
