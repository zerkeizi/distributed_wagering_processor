import { InvariantViolationError } from "../domain/domain-error.ts";
import type { ExponentialBackoff } from "../domain/exponential-backoff.ts";
import type { IntegrationEvent } from "./integration-event.ts";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date | undefined;
  readonly publishedAt: Date | undefined;
}

/**
 * Evento de integração aguardando publicação (transactional outbox, README §11). Nasce na mesma
 * transação SQL da mudança que o originou; o id é o próprio `eventId`, que viaja junto na
 * publicação e permite ao consumidor descartar duplicatas.
 *
 * Não há limite de tentativas: um evento confirmado nunca é descartado (README §3). O atraso
 * fica visível na métrica de outbox lag (ADR 0013).
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa `attempts` e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date, backoff: ExponentialBackoff): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(this._attempts, now);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}
