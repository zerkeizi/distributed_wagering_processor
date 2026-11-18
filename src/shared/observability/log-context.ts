import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Campos de correlação exigidos nos logs (README §12). Ficam num AsyncLocalStorage para que
 * qualquer log emitido durante uma requisição HTTP ou uma mensagem SQS os carregue sem
 * precisar repassar um logger filho manualmente.
 */
export interface LogContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return storage.getStore();
}

/** Acrescenta identificadores ao contexto corrente à medida que o fluxo os descobre. */
export function enrichLogContext(fields: Partial<Omit<LogContext, "correlationId">>): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (store as unknown as Record<string, string>)[key] = value;
    }
  }
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Aceita o id vindo de fora só se for curto e seguro para log; senão gera um novo. */
export function resolveCorrelationId(incoming: string | undefined): string {
  if (incoming && CORRELATION_ID_PATTERN.test(incoming)) return incoming;
  return Bun.randomUUIDv7();
}
