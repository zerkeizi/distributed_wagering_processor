import type { MoneyProps } from "../../../shared/domain/money.ts";

export type EntryChannel = "http" | "sqs" | "worker";

export interface ReconciliationDivergence {
  readonly walletId: string;
  readonly difference: MoneyProps;
  readonly anomalies: readonly { readonly type: string; readonly walletVersion?: number }[];
}

/**
 * Sinais operacionais que os use cases emitem (CHALLENGE §12). A porta esconde se viram métrica,
 * log ou ambos — o adapter decide; os use cases não conhecem prom-client nem pino.
 */
export type SubmissionOutcome = "created" | "replayed" | "resolved" | "conflict" | "error";

export interface WageringTelemetry {
  /** Uma transação mudou de estado (nova, ou pendente que se resolveu). */
  transactionCompleted(kind: string, status: string, channel: EntryChannel): void;
  /** Reenvio servido sem novo efeito: `idempotent_replay` (mesma key) ou `inbox` (mesmo messageId). */
  duplicateDetected(source: "idempotent_replay" | "inbox"): void;
  idempotencyConflict(code: string): void;
  lockConflict(type: "lock_timeout" | "deadlock"): void;
  retryScheduled(component: "sqs_consumer" | "outbox_publisher" | "pending_reference_worker"): void;
  deadLettered(reason: string): void;
  dlqDepthObserved(depth: number): void;
  submissionObserved(channel: EntryChannel, outcome: SubmissionOutcome, seconds: number): void;
  reconciliationDivergence(divergence: ReconciliationDivergence): void;
}

export const WAGERING_TELEMETRY = Symbol("WAGERING_TELEMETRY");
