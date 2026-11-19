import { describe, expect, test } from "bun:test";
import pino, { stdSerializers } from "pino";
import { serializeError } from "../../../src/shared/observability/error-serializer.ts";
import { WalletSchema } from "../../../src/wagering/infrastructure/persistence/records.ts";
import { useTestDatabase } from "../support/database.ts";
import { openWalletInDb } from "../support/factories.ts";

/**
 * CHALLENGE §12 com erros REAIS do Postgres: uma violação de constraint devolve a linha inteira
 * (saldo incluído) em `detail` e, via MikroORM, também na `message`. O log não pode carregar isso.
 */
const db = useTestDatabase();
const NEGATIVE = "-987.65";

function logLine(err: unknown): string {
  const lines: string[] = [];
  pino(
    { serializers: { err: stdSerializers.wrapErrorSerializer(serializeError as never) } },
    { write: (line: string) => lines.push(line) },
  ).error({ err: new Error("unexpected", { cause: err }) }, "unhandled error");
  return lines.join("");
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the database to refuse");
}

describe("logs de erro do banco não vazam valores da linha", () => {
  test("SQL cru (erro do driver pg)", async () => {
    const w = await openWalletInDb(db());
    const err = await caught(() =>
      db().sql("update wallet set balance = ? where id = ?", [NEGATIVE, w.walletId]),
    );
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).toContain(NEGATIVE); // o risco existe
    const line = logLine(err);
    expect(line).not.toContain(NEGATIVE);
    expect(line).not.toContain(w.playerId);
    expect(JSON.parse(line).err.cause.constraint).toBe("wallet_balance_non_negative_ck");
  });

  test("flush do MikroORM (exceção convertida, detail repetido na message)", async () => {
    const w = await openWalletInDb(db());
    const err = await caught(() =>
      db()
        .orm.em.fork()
        .transactional(async (em) => {
          const wallet = await em.findOneOrFail(WalletSchema, { id: w.walletId });
          wallet.balance = NEGATIVE;
        }),
    );
    expect((err as Error).message).toContain(NEGATIVE);
    const line = logLine(err);
    expect(line).not.toContain(NEGATIVE);
    expect(line).not.toContain(w.playerId);
    expect(JSON.parse(line).err.cause).toMatchObject({
      type: "CheckConstraintViolationException",
      constraint: "wallet_balance_non_negative_ck",
    });
  });
});
