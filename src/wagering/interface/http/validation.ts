import type { z } from "zod";
import { InvalidRequestError } from "../../application/errors.ts";

export { moneySchema, uuidSchema } from "../contracts.ts";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown, label = "request"): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || label,
    message: issue.message,
  }));
  throw new InvalidRequestError(`invalid ${label}`, details);
}
