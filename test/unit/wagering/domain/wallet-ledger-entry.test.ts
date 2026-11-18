import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../../src/shared/domain/domain-error.ts";
import { Money } from "../../../../src/shared/domain/money.ts";
import { LedgerDirection } from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from "../../../../src/wagering/domain/wallet-ledger-entry.ts";
import { brl, T0, usd } from "./fixtures.ts";

const valid: CreateLedgerEntryProps = {
  id: "e1",
  walletId: "w1",
  transactionId: "t1",
  direction: LedgerDirection.Debit,
  money: brl("30.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("70.00"),
  walletVersion: 2,
  createdAt: T0,
};

describe("WalletLedgerEntry.create", () => {
  test("aceita lançamento balanceado", () => {
    const entry = WalletLedgerEntry.create(valid);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe("-30.00");
  });

  test.each([
    ["aritmética errada", { balanceAfter: brl("71.00") }],
    ["direção trocada", { direction: LedgerDirection.Credit }],
    ["valor zero", { money: brl("0.00"), balanceAfter: brl("100.00") }],
    [
      "saldo final negativo",
      { balanceBefore: brl("10.00"), balanceAfter: Money.fromMinorUnits(-2000n, "BRL") },
    ],
    ["versão inválida", { walletVersion: 0 }],
  ])("rejeita %s", (_, override) => {
    expect(() => WalletLedgerEntry.create({ ...valid, ...override })).toThrow();
  });

  test("rejeita moedas misturadas", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, money: usd("30.00") })).toThrow();
  });

  test("é estruturalmente imutável", () => {
    const entry = WalletLedgerEntry.create(valid);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: unknown }).money = brl("1.00");
    }).toThrow(TypeError);
    // Nenhum método de transição: a API pública só tem consultas.
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(methods.sort()).toEqual(["isBalanced", "signedAmount"]);
  });

  test("o erro é violação de invariante (bug), não regra de negócio", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, balanceAfter: brl("1.00") })).toThrow(
      InvariantViolationError,
    );
  });
});
