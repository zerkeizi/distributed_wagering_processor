import { z } from "zod";
import { InvalidRequestError } from "../../application/errors.ts";

/**
 * Valida só a FORMA do contrato HTTP. O formato estrito do valor monetário (escala, sinal, notação)
 * é responsabilidade de `Money.from`, para que HTTP e SQS apliquem exatamente a mesma regra.
 */
export const moneySchema = z.object({
  amount: z.string({ error: 'amount must be a decimal string, e.g. "25.00"' }),
  currency: z.string(),
});

export const uuidSchema = z.uuid({ error: "must be a UUID" });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, label = "request"): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || label,
    message: issue.message,
  }));
  throw new InvalidRequestError(`invalid ${label}`, details);
}
