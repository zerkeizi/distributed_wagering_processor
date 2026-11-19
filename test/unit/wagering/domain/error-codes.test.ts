import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../../src/shared/domain/money.ts";
import { ErrorCode } from "../../../../src/wagering/domain/error-code.ts";
import { FailureCode, isBusinessRejection } from "../../../../src/wagering/domain/failure-code.ts";

describe("códigos de erro", () => {
  test("FailureCode (persistido) e ErrorCode (requisição) não se sobrepõem", () => {
    const failure = new Set<string>(Object.values(FailureCode));
    const overlap = Object.values(ErrorCode).filter((c) => failure.has(c));
    expect(overlap).toEqual([]);
  });

  test("só INTERNAL_INVARIANT_VIOLATION não é rejeição de negócio", () => {
    const notRejection = Object.values(FailureCode).filter((c) => !isBusinessRejection(c));
    expect(notRejection).toEqual([FailureCode.InternalInvariantViolation]);
  });

  test("os erros de Money (camada shared, sem acesso ao enum) usam valores de ErrorCode", () => {
    // `shared` não importa `wagering`: os códigos são strings literais e precisam bater com o enum.
    expect(new InvalidMoneyError("x").code).toBe(ErrorCode.InvalidPayload);
    expect(new CurrencyMismatchError("BRL", "USD").code).toBe(ErrorCode.CurrencyMismatch);
  });
});
