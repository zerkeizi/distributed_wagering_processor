import type { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";

/**
 * Operações do publisher sobre a outbox, cada uma numa transação curta própria (ADR 0013): nenhuma
 * conexão fica presa enquanto o broker responde.
 */
export interface OutboxStore {
  /**
   * Reserva até `limit` eventos pendentes e vencidos que ninguém reservou (ou cuja reserva expirou),
   * com `FOR UPDATE SKIP LOCKED`: publishers concorrentes nunca pegam o mesmo evento ao mesmo tempo.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  /** Grava `attempts`/`nextAttemptAt` já calculados pelo domínio e libera a reserva. */
  saveRetry(message: OutboxMessage): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
}

export const OUTBOX_STORE = Symbol("OUTBOX_STORE");

/** Destino dos eventos de integração (SQS em produção). Deve ser idempotente por `eventId`. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
