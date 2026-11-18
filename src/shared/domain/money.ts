import { DomainError } from "./domain-error.ts";

/** Formato de contrato e de payload de evento: valor sempre como string decimal (README §6.1). */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Exatamente 2 casas decimais, sem sinal, sem zeros à esquerda, no máximo 18 dígitos inteiros
 * (cabe em NUMERIC(20,2)). Rejeita por construção: "", "NaN", "Infinity", "1e3", "-1.00",
 * "1.001", "1.5", "01.00", " 1.00".
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MINOR_UNITS_PER_UNIT = 100n;
/** Maior valor representável em NUMERIC(20,2), em centavos. */
const MAX_MINOR_UNITS = 10n ** 20n - 1n;

export class InvalidMoneyError extends DomainError {
  constructor(reason: string) {
    super("INVALID_PAYLOAD", `Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super("CURRENCY_MISMATCH", `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Quantia exata em uma moeda (ADR 0002). Internamente é um `bigint` de centavos, então não há
 * ponto flutuante em nenhuma etapa. Imutável: toda operação devolve uma nova instância.
 *
 * Valores negativos só existem como resultado intermediário de aritmética (`negate`, `subtract`);
 * a entrada pública (`from`) aceita apenas valores não negativos.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Entrada de contrato (HTTP, SQS): valida formato, escala e sinal. */
  static from(props: MoneyProps): Money {
    if (typeof props !== "object" || props === null) {
      throw new InvalidMoneyError("expected an object with amount and currency");
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places (e.g. "25.00")',
      );
    }
    const [units = "0", cents = "00"] = amount.split(".");
    return new Money(BigInt(units) * MINOR_UNITS_PER_UNIT + BigInt(cents), currency);
  }

  /** Reconstrução a partir de centavos (persistência, aritmética interna). Aceita negativos. */
  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    Money.assertCurrency(currency);
    Money.assertWithinBounds(minorUnits);
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return Money.fromMinorUnits(0n, currency);
  }

  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const units = abs / MINOR_UNITS_PER_UNIT;
    const cents = (abs % MINOR_UNITS_PER_UNIT).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${units}.${cents}`;
  }

  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Igualdade de valor: moedas diferentes simplesmente não são iguais (não é aritmética). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter ISO-4217 code (e.g. "BRL")');
    }
  }

  private static assertWithinBounds(minorUnits: bigint): void {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError("amount exceeds the supported range");
    }
  }
}
