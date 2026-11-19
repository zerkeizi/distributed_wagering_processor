import { InvalidRequestError } from "./errors.ts";

/**
 * Cursor opaco e estável do extrato (CHALLENGE §9): codifica a última versão vista e a wallet a que
 * pertence. Estável porque o ledger é append-only e ordenado por `wallet_version` — lançamentos novos
 * entram no topo e nunca deslocam as páginas seguintes.
 */
interface CursorPayload {
  readonly w: string;
  readonly v: number;
}

export function encodeLedgerCursor(walletId: string, beforeVersion: number): string {
  const payload: CursorPayload = { w: walletId, v: beforeVersion };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeLedgerCursor(walletId: string, cursor: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidRequestError("cursor is malformed");
  }
  const p = payload as Partial<CursorPayload> | null;
  if (
    typeof p !== "object" ||
    p === null ||
    p.w !== walletId ||
    typeof p.v !== "number" ||
    !Number.isInteger(p.v) ||
    p.v < 2
  ) {
    throw new InvalidRequestError("cursor is malformed or belongs to another wallet");
  }
  return p.v;
}
