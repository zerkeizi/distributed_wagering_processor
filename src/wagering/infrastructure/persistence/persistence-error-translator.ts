import {
  ConnectionException,
  DriverException,
  UniqueConstraintViolationException,
} from "@mikro-orm/postgresql";
import {
  LockTimeoutError,
  PersistenceUnavailableError,
  UniqueViolationError,
} from "../../application/ports/persistence-errors.ts";

/** SQLSTATEs de indisponibilidade: conexão (classe 08), servidor desligando (57P0x), sem recursos (53). */
const UNAVAILABLE_SQLSTATE = /^(08|57P0|53)/;
const UNAVAILABLE_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
]);

/** Converte exceções do driver em erros da aplicação; erros de domínio passam intactos. */
export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as { constraint?: string }).constraint, {
      cause: error,
    });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "55P03") return new LockTimeoutError({ cause: error });
  if (
    error instanceof ConnectionException ||
    (typeof code === "string" && (UNAVAILABLE_SQLSTATE.test(code) || UNAVAILABLE_ERRNO.has(code)))
  ) {
    return new PersistenceUnavailableError({ cause: error });
  }
  if (error instanceof DriverException) return error;
  return error;
}
