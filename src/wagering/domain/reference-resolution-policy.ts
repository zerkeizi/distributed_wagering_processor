import { ExponentialBackoff } from "../../shared/domain/exponential-backoff.ts";

/**
 * Quanto esperar por uma reference fora de ordem (CHALLENGE §7.1, ARCHITECTURE.md). O default —
 * 10 novas tentativas, backoff 2s → 5min — dá ~18,5 min, suficiente para cobrir atrasos e
 * redeliveries normais do provider sem deixar transações pendentes indefinidamente.
 */
export class ReferenceResolutionPolicy {
  constructor(
    readonly maxRetries: number,
    readonly backoff: ExponentialBackoff,
  ) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
  }

  static default(): ReferenceResolutionPolicy {
    return new ReferenceResolutionPolicy(10, new ExponentialBackoff(2_000, 300_000));
  }

  /**
   * @param retriesSoFar novas tentativas já agendadas (`resolutionAttempts`).
   * @returns quando tentar de novo, ou `undefined` se o limite foi atingido.
   */
  nextAttemptAt(retriesSoFar: number, now: Date): Date | undefined {
    if (retriesSoFar >= this.maxRetries) return undefined;
    return this.backoff.nextAttemptAt(retriesSoFar + 1, now);
  }
}
