import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from "../../../../src/shared/domain/money.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — validação de entrada", () => {
  test.each(["0.00", "25.00", "0.01", "1000.50", "999999999999999999.99"])(
    "aceita %s",
    (amount) => {
      expect(brl(amount).amount).toBe(amount);
    },
  );

  test.each([
    ["string vazia", ""],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["notação científica", "1e3"],
    ["notação científica com casas", "1.00e2"],
    ["negativo", "-1.00"],
    ["mais de 2 casas", "1.001"],
    ["1 casa (escala fixa)", "1.5"],
    ["sem casas (escala fixa)", "25"],
    ["zero à esquerda", "01.00"],
    ["espaços", " 1.00"],
    ["sinal de +", "+1.00"],
    ["vírgula decimal", "1,00"],
    ["hexadecimal", "0x10"],
    ["acima de NUMERIC(20,2)", "1000000000000000000.00"],
  ])("rejeita %s", (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string (number nunca é aceito)", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(["", "brl", "BR", "BRLL", "R$"])("rejeita moeda %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("o erro é de payload inválido, com código estável", () => {
    try {
      brl("1.001");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as InvalidMoneyError).code).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("Money — aritmética exata", () => {
  test("0.10 + 0.20 é exatamente 0.30 (sem erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("subtract pode produzir negativo internamente, serializado com sinal", () => {
    const result = brl("20.00").subtract(brl("80.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.amount).toBe("-60.00");
  });

  test("negate e escala fixa na serialização", () => {
    expect(brl("5.00").negate().toJSON()).toEqual({ amount: "-5.00", currency: "BRL" });
    expect(Money.fromMinorUnits(7n, "BRL").amount).toBe("0.07");
    expect(Money.zero("USD").toString()).toBe("0.00 USD");
  });

  test("operações retornam novas instâncias e não mutam a original", () => {
    const a = brl("10.00");
    const b = a.add(brl("1.00"));
    expect(a.amount).toBe("10.00");
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test("predicados", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.01"))).toBe(false);
  });

  test("overflow da faixa suportada é rejeitado", () => {
    const max = brl("999999999999999999.99");
    expect(() => max.add(brl("0.01"))).toThrow(InvalidMoneyError);
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança CurrencyMismatchError", (_, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  test("equals entre moedas diferentes é false, não erro", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});
