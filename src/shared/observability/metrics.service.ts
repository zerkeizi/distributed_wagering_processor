import { Injectable } from "@nestjs/common";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/**
 * Catálogo único de métricas (CHALLENGE §12). Declaradas todas no boot para que `/metrics`
 * já exponha a série completa (com zero) antes do primeiro evento — dashboards e alertas não
 * precisam lidar com séries ausentes.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Wager transactions por desfecho; `channel` = http | sqs | worker. */
  readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions by kind, final status and entry channel",
    labelNames: ["kind", "status", "channel"] as const,
    registers: [this.registry],
  });

  /** `source` = idempotent_replay (mesma key + hash) | inbox (mesmo messageId). */
  readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicate submissions detected and served without new side effects",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: "wagering_idempotency_conflicts_total",
    help: "Same idempotency key or external id with a different payload",
    labelNames: ["code"] as const,
    registers: [this.registry],
  });

  /** `component` = sqs_consumer | outbox_publisher | pending_reference_worker. */
  readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries scheduled after a transient failure",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages moved to the dead-letter queue",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  /** `type` = lock_timeout | deadlock | serialization. */
  readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Wallet lock contention that surfaced as an error",
    labelNames: ["type"] as const,
    registers: [this.registry],
  });

  /** Profundidade da DLQ (inclui o que o redrive do SQS moveu sozinho), amostrada pelo consumer. */
  readonly dlqDepth = new Gauge({
    name: "wagering_dlq_depth",
    help: "Approximate number of messages waiting in the dead-letter queue",
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age in seconds of the oldest unpublished outbox event (0 when empty)",
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending_events",
    help: "Unpublished outbox events",
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager transaction submission",
    labelNames: ["channel", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliations that found stored balance and ledger out of sync",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
