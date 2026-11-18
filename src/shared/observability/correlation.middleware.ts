import type { NextFunction, Request, Response } from "express";
import { resolveCorrelationId, runWithLogContext } from "./log-context.ts";

export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Registrado com `app.use` antes da inicialização do Nest, para rodar antes do middleware do
 * pino e envolver toda a requisição no contexto de log.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.header(CORRELATION_HEADER));
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithLogContext({ correlationId }, next);
}
