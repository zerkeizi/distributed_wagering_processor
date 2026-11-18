/**
 * Atraso exponencial com teto: tentativa 1 espera `baseMs`, cada tentativa seguinte dobra, até
 * `maxMs`. Sem jitter de propósito: o espalhamento entre instâncias já vem do claim com
 * SKIP LOCKED, e um atraso determinístico mantém os testes reproduzíveis.
 */
export class ExponentialBackoff {
  constructor(
    readonly baseMs: number,
    readonly maxMs: number,
  ) {
    if (!Number.isInteger(baseMs) || baseMs <= 0) throw new RangeError("baseMs must be > 0");
    if (!Number.isInteger(maxMs) || maxMs < baseMs) throw new RangeError("maxMs must be >= baseMs");
  }

  /** @param attempt 1 para a primeira nova tentativa. */
  delayMs(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be >= 1");
    // Limita o expoente para não estourar antes de aplicar o teto.
    return Math.min(this.maxMs, this.baseMs * 2 ** Math.min(attempt - 1, 32));
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayMs(attempt));
  }
}
