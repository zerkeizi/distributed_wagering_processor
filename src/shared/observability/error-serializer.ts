/**
 * Serializer do campo `err` dos logs (CHALLENGE §12: sem dados sensíveis nem payloads financeiros).
 *
 * Erros do Postgres carregam a linha inteira que violou a constraint, saldo incluído:
 * `detail: "Failing row contains (<id>, <player>, BRL, -987.65, …)"`. O MikroORM ainda repete isso
 * na `message` (" - detail: …") e o pino concatena `message`/`stack` das causas. A `redact` do pino
 * não alcança texto dentro de uma string, então aqui:
 *
 * 1. só campos de diagnóstico de uma allowlist saem no log (`detail`, `where`, `internalQuery`,
 *    `parameters`, `sqlMessage` etc. nunca saem);
 * 2. `message` e `stack` passam por `scrubErrorText`, que corta os trechos com valores de linha.
 *
 * Recebe o objeto que o `pino-std-serializers` já montou (pino-http envolve o serializer custom com
 * o padrão), mas aceita também um `Error` cru.
 */

const MAX_CAUSE_DEPTH = 5;

/** Campos escalares seguros: identificam o erro sem carregar dados da linha. */
const SAFE_SCALAR_FIELDS = ["code", "sqlState", "constraint", "table", "errno", "statusCode"];

const DETAIL_SEGMENT = /\s*-\s*detail:[^\n]*/g;
const ROW_VALUES = /(Failing row contains|Key \([^)\n]*\)=)\s*\([^\n]*/g;

/** Remove valores de linha de mensagens do Postgres/MikroORM. */
export function scrubErrorText(text: string): string {
  return text.replace(DETAIL_SEGMENT, "").replace(ROW_VALUES, "$1 [REDACTED]");
}

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
  readonly [field: string]: unknown;
}

export function serializeError(err: unknown, depth = 0): SerializedError | unknown {
  if (typeof err !== "object" || err === null) return err;
  // O objeto do pino-std-serializers expõe o erro original em `raw` (não enumerável); sem ele o
  // `cause` e o nome da classe se perdem.
  const raw = (err as { raw?: unknown }).raw;
  const source = (typeof raw === "object" && raw !== null ? raw : err) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: typeOf(source),
    message: scrubErrorText(stringOr(source.message, "")),
  };
  // Só a pilha deste erro: a de cada causa vai no próprio `cause`.
  if (typeof source.stack === "string") out.stack = scrubErrorText(source.stack);
  for (const field of SAFE_SCALAR_FIELDS) {
    const value = source[field];
    if (typeof value === "string" || typeof value === "number") out[field] = value;
  }
  const metadata = source.$metadata as { httpStatusCode?: unknown } | undefined;
  if (typeof metadata?.httpStatusCode === "number") out.httpStatusCode = metadata.httpStatusCode;
  if (source.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(source.cause, depth + 1);
  }
  return out as SerializedError;
}

/** Nome da classe (`DatabaseError`, `CheckConstraintViolationException`); `name` se for `Error` genérico. */
function typeOf(source: Record<string, unknown>): string {
  const ctor = (source.constructor as { name?: unknown } | undefined)?.name;
  if (typeof ctor === "string" && ctor !== "Error" && ctor !== "Object") return ctor;
  return stringOr(source.name, stringOr(source.type, "Error"));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
