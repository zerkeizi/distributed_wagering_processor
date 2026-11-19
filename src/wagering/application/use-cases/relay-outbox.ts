import type { ExponentialBackoff } from "../../../shared/domain/exponential-backoff.ts";
import { crashPoint } from "../../../shared/testing/crash-point.ts";
import type { Clock } from "../ports/clock.ts";
import type { EventPublisher, OutboxStore } from "../ports/outbox-store.ts";
import type { WageringTelemetry } from "../ports/telemetry.ts";

export interface RelayOutboxOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly backoff: ExponentialBackoff;
}

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Publica eventos confirmados (transactional outbox, CHALLENGE §11, ADR 0013). Garantia
 * at-least-once: o evento só é marcado como publicado depois que o broker aceitou; se o processo
 * morrer entre os dois, a reserva expira e outro publisher publica de novo — com o mesmo `eventId`,
 * que o consumidor usa para descartar a duplicata.
 */
export class RelayOutbox {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
    private readonly options: RelayOutboxOptions,
  ) {}

  async tick(): Promise<RelayResult> {
    const now = this.clock.now();
    const batch = await this.store.claimDue(now, this.options.batchSize, this.options.leaseMs);
    let published = 0;
    let failed = 0;
    // Em ordem de ocorrência: dentro de uma wallet, os eventos saem na ordem em que aconteceram.
    for (const message of batch) {
      try {
        await this.publisher.publish(message);
        crashPoint("outbox:after-publish-before-mark");
        message.markPublished(this.clock.now());
        await this.store.markPublished(message);
        published++;
      } catch {
        // Sem limite de tentativas: evento confirmado nunca é descartado (CHALLENGE §3).
        message.scheduleRetry(this.clock.now(), this.options.backoff);
        await this.store.saveRetry(message);
        this.telemetry.retryScheduled("outbox_publisher");
        failed++;
      }
    }
    this.telemetry.outboxObserved(await this.store.stats(this.clock.now()));
    return { claimed: batch.length, published, failed };
  }
}
