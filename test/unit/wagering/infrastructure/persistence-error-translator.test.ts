import { describe, expect, test } from "bun:test";
import {
  LockTimeoutError,
  PersistenceUnavailableError,
} from "../../../../src/wagering/application/ports/persistence-errors.ts";
import { translatePersistenceError } from "../../../../src/wagering/infrastructure/persistence/persistence-error-translator.ts";

const pgError = (code: string | undefined, message = "boom") =>
  Object.assign(new Error(message), { code });

describe("translatePersistenceError — banco indisponível vira 503, nunca 500", () => {
  test.each([
    ["conexão recusada pelo SO", pgError("ECONNREFUSED")],
    ["DNS do host do banco", pgError("ENOTFOUND")],
    ["falha de conexão (08006)", pgError("08006")],
    ["sem conexões livres (53300)", pgError("53300", "too many clients")],
    ["desligamento administrativo (57P01)", pgError("57P01")],
    ["banco ainda subindo (57P03)", pgError("57P03", "the database system is starting up")],
    [
      "banco recusando conexões (55000)",
      pgError("55000", 'database "x" is not currently accepting connections'),
    ],
    [
      "conexão derrubada no meio da query (sem código)",
      pgError(undefined, "Connection terminated unexpectedly"),
    ],
    [
      "timeout de conexão do pool (sem código)",
      pgError(undefined, "Connection terminated due to connection timeout"),
    ],
  ])("%s", (_, error) => {
    expect(translatePersistenceError(error)).toBeInstanceOf(PersistenceUnavailableError);
  });

  test("lock timeout (55P03) é LockTimeoutError, não indisponibilidade", () => {
    expect(translatePersistenceError(pgError("55P03"))).toBeInstanceOf(LockTimeoutError);
  });

  test.each([
    ["55000 por outro motivo", pgError("55000", "cannot do X in this state")],
    ["violação de CHECK (23514)", pgError("23514")],
    ["erro de programação qualquer", new TypeError("undefined is not a function")],
  ])("%s continua sendo erro (vira 500 se ninguém tratar)", (_, error) => {
    expect(translatePersistenceError(error)).toBe(error);
  });
});
