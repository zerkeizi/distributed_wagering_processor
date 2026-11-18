import { describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "../../../../src/shared/domain/exponential-backoff.ts";

describe("ExponentialBackoff", () => {
  const backoff = new ExponentialBackoff(2_000, 300_000);

  test("dobra a cada tentativa até o teto", () => {
    const delays = Array.from({ length: 10 }, (_, i) => backoff.delayMs(i + 1));
    expect(delays).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ]);
  });

  test("não estoura em tentativas muito altas", () => {
    expect(backoff.delayMs(10_000)).toBe(300_000);
  });

  test("nextAttemptAt soma o atraso ao instante dado", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(backoff.nextAttemptAt(2, now).toISOString()).toBe("2026-01-01T00:00:04.000Z");
  });

  test("parâmetros inválidos", () => {
    expect(() => new ExponentialBackoff(0, 10)).toThrow(RangeError);
    expect(() => new ExponentialBackoff(10, 5)).toThrow(RangeError);
    expect(() => backoff.delayMs(0)).toThrow(RangeError);
  });
});
