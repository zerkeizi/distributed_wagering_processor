import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../../src/shared/domain/domain-error.ts";
import { CurrencyMismatchError } from "../../../../src/shared/domain/money.ts";
import { InsufficientFundsError } from "../../../../src/wagering/domain/errors.ts";
import { LedgerDirection } from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import { Wallet } from "../../../../src/wagering/domain/wallet.ts";
import { brl, nextId, openWallet, PLAYER_ID, T0, usd, WALLET_ID } from "./fixtures.ts";

const T1 = new Date(T0.getTime() + 1_000);

describe("Wallet.open", () => {
  test("saldo inicial > 0 gera o lançamento de abertura e version 1", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("1000.00"),
      openingTransactionId: "opening-tx",
      openingEntryId: "entry-0",
      at: T0,
    });
    expect(wallet.balance.equals(brl("1000.00"))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("opening-tx");
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("saldo inicial zero: version 1, nenhum lançamento", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl("0.00"),
      openingTransactionId: "unused",
      openingEntryId: "unused",
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });
});

describe("Wallet.debit / credit", () => {
  test("débito reduz o saldo, incrementa version e devolve o lançamento correspondente", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("80.00"), at: T1 });
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(T1);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test("débito que deixaria saldo negativo lança e não altera nada", () => {
    const wallet = openWallet("100.00");
    expect(() =>
      wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at: T1 }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(T0);
  });

  test("débito do saldo exato zera a wallet (zero não é negativo)", () => {
    const wallet = openWallet("100.00");
    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.00"), at: T1 });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("duas apostas de 80 sobre 100: a segunda é recusada", () => {
    const wallet = openWallet("100.00");
    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("80.00"), at: T1 });
    expect(wallet.canDebit(brl("80.00"))).toBe(false);
    expect(() =>
      wallet.debit({ entryId: "e2", transactionId: "t2", money: brl("80.00"), at: T1 }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("20.00");
  });

  test("crédito aumenta saldo e version", () => {
    const wallet = openWallet("0.00");
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("5.50"), at: T1 });
    expect(wallet.balance.amount).toBe("5.50");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("moeda diferente da wallet é rejeitada sem alterar nada", () => {
    const wallet = openWallet("100.00");
    expect(() =>
      wallet.credit({ entryId: "e1", transactionId: "t1", money: usd("1.00"), at: T1 }),
    ).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimento de valor zero não é um movimento", () => {
    const wallet = openWallet("100.00");
    expect(() =>
      wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("0.00"), at: T1 }),
    ).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test("saldo e ledger permanecem consistentes ao longo de uma sequência", () => {
    const wallet = openWallet("50.00");
    const entries = [
      wallet.debit({ entryId: nextId(), transactionId: "a", money: brl("20.00"), at: T1 }),
      wallet.credit({ entryId: nextId(), transactionId: "b", money: brl("35.25"), at: T1 }),
      wallet.debit({ entryId: nextId(), transactionId: "c", money: brl("0.25"), at: T1 }),
    ];
    const replayed = entries.reduce((acc, e) => acc.add(e.signedAmount()), brl("50.00"));
    expect(replayed.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([2, 3, 4]);
    // Encadeamento: o "antes" de cada lançamento é o "depois" do anterior.
    expect(entries[1]?.balanceBefore.equals(entries[0]?.balanceAfter ?? brl("0.00"))).toBe(true);
  });

  test("rehydrate não revalida nada: só reconstrói o estado", () => {
    const state = openWallet("10.00").toState();
    const wallet = Wallet.rehydrate({ ...state, version: 42 });
    expect(wallet.version).toBe(42);
    expect(wallet.balance.amount).toBe("10.00");
  });
});
