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
export interface WageringTelemetry {
  transactionCompleted(kind: string, status: string, channel: EntryChannel): void;
  reconciliationDivergence(divergence: ReconciliationDivergence): void;
}

export const WAGERING_TELEMETRY = Symbol("WAGERING_TELEMETRY");
