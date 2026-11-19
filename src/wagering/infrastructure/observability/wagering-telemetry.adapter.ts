import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { MetricsService } from "../../../shared/observability/metrics.service.ts";
import type {
  EntryChannel,
  ReconciliationDivergence,
  SubmissionOutcome,
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

  duplicateDetected(source: "idempotent_replay" | "inbox"): void {
    this.metrics.duplicates.inc({ source });
  }

  idempotencyConflict(code: string): void {
    this.metrics.idempotencyConflicts.inc({ code });
  }

  lockConflict(type: "lock_timeout" | "deadlock"): void {
    this.metrics.lockConflicts.inc({ type });
  }

  retryScheduled(
    component: "sqs_consumer" | "outbox_publisher" | "pending_reference_worker",
  ): void {
    this.metrics.retries.inc({ component });
  }

  deadLettered(reason: string): void {
    this.metrics.dlqMessages.inc({ reason });
  }

  dlqDepthObserved(depth: number): void {
    this.metrics.dlqDepth.set(depth);
  }

  submissionObserved(channel: EntryChannel, outcome: SubmissionOutcome, seconds: number): void {
    this.metrics.processingDuration.observe({ channel, outcome }, seconds);
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
