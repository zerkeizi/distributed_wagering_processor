import { z } from "zod";
import { WagerTransactionKind } from "../domain/wager-transaction-kind.ts";

/**
 * Forma dos contratos de entrada, compartilhada por HTTP e SQS. Valida só a FORMA: o formato estrito
 * do valor monetário e as regras por kind ficam no domínio, para valer igual nas duas entradas.
 */
export const identifier = z.string().min(1).max(128);
export const uuidSchema = z.uuid({ error: "must be a UUID" });

export const moneySchema = z.object({
  amount: z.string({ error: 'amount must be a decimal string, e.g. "25.00"' }),
  currency: z.string(),
});

export const wagerTransactionFields = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier,
  gameId: identifier,
  // OPENING passa na forma de propósito: o domínio recusa com UNSUPPORTED_KIND, mais claro que "enum inválido".
  kind: z.enum(Object.values(WagerTransactionKind) as [string, ...string[]]),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});

export const idempotencyKeySchema = z
  .string({ error: "Idempotency-Key is required" })
  .min(1, "Idempotency-Key is required")
  .max(255, "Idempotency-Key must be at most 255 characters");

/** Mensagem da fila `wager-transactions.fifo` (CHALLENGE §10). */
export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

export const wagerTransactionRequestedMessage = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerTransactionFields.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerTransactionRequestedMessage = z.infer<typeof wagerTransactionRequestedMessage>;
