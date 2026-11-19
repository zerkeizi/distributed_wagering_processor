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

/**
 * SQLSTATEs que significam "o banco não está disponível agora" (vira 503, nunca 500):
 * - 08xxx: falha de conexão;
 * - 53xxx: falta de recursos (sem conexões livres, disco cheio, memória);
 * - 57P01/57P02/57P03: desligamento administrativo, crash, "ainda subindo";
 * - 58xxx: erro de sistema/IO no servidor.
 */
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0[123]|58)/;
/** 55000 é genérico; só conta como indisponível nesta situação (banco existe, mas recusa conexões). */
const NOT_ACCEPTING_CONNECTIONS = /not currently accepting connections/i;
/** Erros de rede do Node/Bun, sem SQLSTATE. */
const UNAVAILABLE_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
/** Mensagens do driver `pg` quando a conexão cai ou não abre (também sem SQLSTATE). */
const UNAVAILABLE_MESSAGE =
  /connection terminated|connection timeout|timeout exceeded when trying to connect|client has encountered a connection error|connection refused/i;

/** Converte exceções do driver em erros da aplicação; erros de domínio passam intactos. */
export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueViolationError((error as { constraint?: string }).constraint, {
      cause: error,
    });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "55P03") return new LockTimeoutError({ cause: error });
  if (isUnavailable(error, code)) return new PersistenceUnavailableError({ cause: error });
  if (error instanceof DriverException) return error;
  return error;
}

function isUnavailable(error: unknown, code: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  const message = error instanceof Error ? error.message : "";
  if (typeof code === "string") {
    if (UNAVAILABLE_SQLSTATE.test(code) || UNAVAILABLE_ERRNO.has(code)) return true;
    if (code === "55000" && NOT_ACCEPTING_CONNECTIONS.test(message)) return true;
    return false;
  }
  // Sem código: só os erros de conexão conhecidos do driver. Qualquer outra coisa é bug → 500.
  return error instanceof Error && UNAVAILABLE_MESSAGE.test(message);
}
