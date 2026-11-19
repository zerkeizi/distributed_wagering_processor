import { describe, expect, test } from "bun:test";
import pino, { stdSerializers } from "pino";
import {
  scrubErrorText,
  serializeError,
} from "../../../../src/shared/observability/error-serializer.ts";

/** Mesmo encadeamento do pino-http: serializer padrão primeiro, o nosso por cima. */
function logLine(err: unknown): string {
  const lines: string[] = [];
  const logger = pino(
    { serializers: { err: stdSerializers.wrapErrorSerializer(serializeError as never) } },
    { write: (line: string) => lines.push(line) },
  );
  logger.error({ err }, "boom");
  return lines.join("");
}

/** Formato real de um erro de check constraint do Postgres via MikroORM (capturado contra o banco). */
function checkViolation(): Error {
  const row = "01a1f20d-9aa7-771e-bd0a-f18f57420ed2, 01a1f20d-9a95-7315, BRL, -987.65, 2";
  const err = new Error(
    `new row for relation "wallet" violates check constraint "wallet_balance_non_negative_ck"\n - detail: Failing row contains (${row}).`,
  ) as Error & Record<string, unknown>;
  err.name = "CheckConstraintViolationException";
  Object.assign(err, {
    code: "23514",
    sqlState: "23514",
    constraint: "wallet_balance_non_negative_ck",
    table: "wallet",
    detail: `Failing row contains (${row}).`,
    sqlMessage: err.message,
    where: "PL/pgSQL function with balance -987.65",
    internalQuery: "update wallet set balance = -987.65",
  });
  return err;
}

describe("serializeError (CHALLENGE §12)", () => {
  test("valores da linha não aparecem no log; o diagnóstico continua lá", () => {
    const line = logLine(checkViolation());
    expect(line).not.toContain("-987.65");
    expect(line).not.toContain("01a1f20d-9aa7");
    const { err } = JSON.parse(line);
    expect(err).toMatchObject({
      type: "CheckConstraintViolationException",
      code: "23514",
      constraint: "wallet_balance_non_negative_ck",
      table: "wallet",
    });
    expect(err.message).toContain("wallet_balance_non_negative_ck");
    for (const field of ["detail", "sqlMessage", "where", "internalQuery"]) {
      expect(err[field]).toBeUndefined();
    }
  });

  test("a causa é higienizada também (erro traduzido carrega o original em `cause`)", () => {
    const wrapped = new Error("database unavailable", { cause: checkViolation() });
    const line = logLine(wrapped);
    expect(line).not.toContain("-987.65");
    expect(JSON.parse(line).err.cause.constraint).toBe("wallet_balance_non_negative_ck");
  });

  test("detail de unique violation (Key (...)=(...)) também é cortado", () => {
    expect(
      scrubErrorText("duplicate key - detail: Key (provider_id, key)=(provider-a, k-1) exists"),
    ).toBe("duplicate key");
    expect(scrubErrorText("Key (provider_id, key)=(provider-a, k-1) already exists.")).toBe(
      "Key (provider_id, key)= [REDACTED]",
    );
  });

  test("erro comum passa intacto; não-objeto passa como está", () => {
    const { err } = JSON.parse(logLine(new TypeError("x is not a function")));
    expect(err.type).toBe("TypeError");
    expect(err.message).toBe("x is not a function");
    expect(err.stack).toContain("TypeError");
    expect(serializeError("plain")).toBe("plain");
  });
});
