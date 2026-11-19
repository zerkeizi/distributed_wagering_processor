import { describe, expect, test } from "bun:test";
import { idempotencyKeySchema } from "../../../../src/wagering/interface/contracts.ts";

/**
 * Via HTTP, espaços nas pontas do header já são removidos pelo parser (OWS, RFC 9110). Na fila SQS a
 * key vem dentro do JSON e chegaria intacta: o schema é quem garante a mesma regra nas duas entradas.
 */
describe("idempotencyKeySchema", () => {
  test.each(["provider-a:transaction-123", "a", "key with inner spaces"])("aceita %p", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  test.each(["", " ", "\t", " provider-a:tx-1", "provider-a:tx-1 ", "\nkey"])(
    "recusa %p",
    (key) => {
      expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
    },
  );

  test("recusa ausente e acima de 255 caracteres", () => {
    expect(idempotencyKeySchema.safeParse(undefined).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("k".repeat(256)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("k".repeat(255)).success).toBe(true);
  });
});
