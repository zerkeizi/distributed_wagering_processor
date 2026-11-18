import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../../../src/shared/domain/money.ts";
import { WalletPlayerMismatchError } from "../../../../src/wagering/domain/errors.ts";
import { FailureCode } from "../../../../src/wagering/domain/failure-code.ts";
import type { ResolvedReference } from "../../../../src/wagering/domain/reference-policy.ts";
import { type SettlementOutcome, settle } from "../../../../src/wagering/domain/settlement.ts";
import type { WagerTransaction } from "../../../../src/wagering/domain/wager-transaction.ts";
import {
  WagerTransactionKind as Kind,
  LedgerDirection,
  WagerTransactionStatus as Status,
} from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import type { Wallet } from "../../../../src/wagering/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../../../src/wagering/domain/wallet-ledger-entry.ts";
import {
  brl,
  nextId,
  openWallet,
  processedBet,
  ROUND_ID,
  shortPolicy,
  T0,
  usd,
  wager,
} from "./fixtures.ts";

function run(
  tx: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  alreadyReversed = false,
): SettlementOutcome {
  const resolved: ResolvedReference | undefined = reference
    ? { transaction: reference, alreadyReversed }
    : undefined;
  return settle({
    transaction: tx,
    wallet,
    reference: resolved,
    resolutionPolicy: shortPolicy,
    ledgerEntryId: nextId("entry"),
    at: T0,
  });
}

function processedWin(wallet: Wallet, bet: WagerTransaction, amount: string): WagerTransaction {
  const win = wager(Kind.Win, {
    money: brl(amount),
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  run(win, wallet, bet);
  return win;
}

describe("BET", () => {
  test("debita, gera 1 lançamento DEBIT e fica PROCESSED", () => {
    const wallet = openWallet("100.00");
    const bet = wager(Kind.Bet, { money: brl("25.00") });
    const outcome = run(bet, wallet);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("75.00");
    expect(bet.balanceAfter?.amount).toBe("75.00");
  });

  test("saldo insuficiente → REJECTED INSUFFICIENT_FUNDS, saldo intacto, sem lançamento", () => {
    const wallet = openWallet("100.00");
    const bet = wager(Kind.Bet, { money: brl("100.01") });
    expect(run(bet, wallet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(bet.status).toBe(Status.Rejected);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(bet.balanceAfter?.amount).toBe("100.00");
  });

  test("cenário da seção 8 em sequência: 100 − 80 ok, segundo 80 rejeitado, saldo 20", () => {
    const wallet = openWallet("100.00");
    const first = wager(Kind.Bet, { money: brl("80.00") });
    const second = wager(Kind.Bet, { money: brl("80.00") });
    expect(run(first, wallet).status).toBe(Status.Processed);
    expect(run(second, wallet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(wallet.balance.amount).toBe("20.00");
  });
});

describe("WIN", () => {
  test("sem referência: credita direto", () => {
    const wallet = openWallet("10.00");
    const outcome = run(wager(Kind.Win, { money: brl("50.00") }), wallet);
    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("com referência a uma BET processada da mesma rodada: credita e vincula o id interno", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const win = wager(Kind.Win, {
      money: brl("35.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(win, wallet, bet).status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("125.00");
  });

  test("valor do WIN não precisa ser igual ao da BET", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    expect(processedWin(wallet, bet, "1000.00").status).toBe(Status.Processed);
  });

  test("referência a BET já revertida → REFERENCE_ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const win = wager(Kind.Win, { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run(win, wallet, bet, true)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

describe("LOSS", () => {
  test("PROCESSED sem mover saldo e sem lançamento; registra o saldo observado", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const loss = wager(Kind.Loss, {
      money: brl("0.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = run(loss, wallet, bet);
    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(wallet.balance.amount).toBe("90.00");
    expect(wallet.version).toBe(2);
    expect(loss.balanceAfter?.amount).toBe("90.00");
  });

  test("referência de kind errado é rejeitada mesmo sem mover saldo", () => {
    const wallet = openWallet("100.00");
    const win = wager(Kind.Win);
    run(win, wallet);
    const loss = wager(Kind.Loss, { referenceExternalTransactionId: win.externalTransactionId });
    expect(run(loss, wallet, win)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });
});

describe("REFUND", () => {
  test("devolve a BET: crédito do mesmo valor", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "30.00");
    const refund = wager(Kind.Refund, {
      money: brl("30.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = run(refund, wallet, bet);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("valor diferente da BET → AMOUNT_MISMATCH (reversão parcial fora de escopo)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "30.00");
    const refund = wager(Kind.Refund, {
      money: brl("29.99"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(refund, wallet, bet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.AmountMismatch,
    });
    expect(wallet.balance.amount).toBe("70.00");
  });

  test("só referencia BET: REFUND de WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const win = processedWin(wallet, bet, "10.00");
    const refund = wager(Kind.Refund, {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(run(refund, wallet, win)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("uma única vez: segundo reversal da mesma BET → REFERENCE_ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet);
    const refund = wager(Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(refund, wallet, bet, true)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.amount).toBe("90.00");
  });

  test("referência a BET rejeitada → REFERENCE_NOT_PROCESSED", () => {
    const wallet = openWallet("5.00");
    const bet = wager(Kind.Bet, { money: brl("10.00") });
    run(bet, wallet); // rejeitada por saldo
    const refund = wager(Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(refund, wallet, bet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.amount).toBe("5.00");
  });
});

describe("ROLLBACK", () => {
  test("de BET: crédito (inverso do débito)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "40.00");
    const rollback = wager(Kind.Rollback, {
      money: brl("40.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(rollback, wallet, bet).status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de WIN: débito (inverso do crédito)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const win = processedWin(wallet, bet, "50.00");
    const rollback = wager(Kind.Rollback, {
      money: brl("50.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const outcome = run(rollback, wallet, win);
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("90.00");
  });

  test("de REFUND: débito; reverter a reversão é permitido (outro alvo, ADR 0006)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "20.00");
    const refund = wager(Kind.Refund, {
      money: brl("20.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    run(refund, wallet, bet);
    expect(wallet.balance.amount).toBe("100.00");
    const rollback = wager(Kind.Rollback, {
      money: brl("20.00"),
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect(run(rollback, wallet, refund).status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe("80.00");
  });

  test("de ROLLBACK → REFERENCE_KIND_NOT_ALLOWED", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const first = wager(Kind.Rollback, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    run(first, wallet, bet);
    const second = wager(Kind.Rollback, {
      referenceExternalTransactionId: first.externalTransactionId,
    });
    expect(run(second, wallet, first)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("REFUND e ROLLBACK da mesma BET: só o primeiro aplica (sem crédito duplo, ADR 0006)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00");
    const refund = wager(Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    run(refund, wallet, bet, false);
    const rollback = wager(Kind.Rollback, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run(rollback, wallet, bet, true)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("reversão sem saldo → REVERSAL_INSUFFICIENT_FUNDS (distinto de aposta sem saldo)", () => {
    const wallet = openWallet("10.00");
    const bet = processedBet(wallet, "10.00");
    const win = processedWin(wallet, bet, "50.00");
    // Jogador gasta o prêmio antes do rollback chegar.
    processedBet(wallet, "45.00");
    expect(wallet.balance.amount).toBe("5.00");
    const rollback = wager(Kind.Rollback, {
      money: brl("50.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(run(rollback, wallet, win)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
    });
    expect(wallet.balance.amount).toBe("5.00");
    expect(rollback.status).toBe(Status.Rejected);
  });
});

describe("pertencimento da referência (README §7.2)", () => {
  const cases: [string, Partial<Parameters<typeof wager>[1]>][] = [
    ["outra rodada", { roundId: "round-000" }],
    ["outro provider", { providerId: "provider-b" }],
    ["outro player", { playerId: "someone-else" }],
    ["outra wallet", { walletId: "other-wallet" }],
  ];
  for (const [label, betOverride] of cases) {
    test(`${label} → REFERENCE_MISMATCH`, () => {
      const wallet = openWallet("100.00");
      const foreignBet = wager(Kind.Bet, betOverride);
      foreignBet.markProcessed(undefined, T0, brl("90.00"));
      const refund = wager(Kind.Refund, {
        roundId: ROUND_ID,
        referenceExternalTransactionId: foreignBet.externalTransactionId,
      });
      expect(run(refund, wallet, foreignBet)).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  }

  test("outra moeda → REFERENCE_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const usdBet = wager(Kind.Bet, { money: usd("10.00") });
    usdBet.markProcessed(undefined, T0, usd("90.00"));
    const refund = wager(Kind.Refund, {
      referenceExternalTransactionId: usdBet.externalTransactionId,
    });
    expect(run(refund, wallet, usdBet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
  });
});

describe("referência fora de ordem (README §7.1)", () => {
  test("referência ausente → PENDING_REFERENCE, nada muda no saldo", () => {
    const wallet = openWallet("100.00");
    const rollback = wager(Kind.Rollback, { referenceExternalTransactionId: "not-yet" });
    const outcome = run(rollback, wallet);
    expect(outcome).toEqual({
      status: Status.PendingReference,
      nextAttemptAt: new Date(T0.getTime() + 1_000),
    });
    expect(rollback.resolutionAttempts).toBe(1);
    expect(wallet.version).toBe(1);
  });

  test("backoff exponencial entre tentativas e REJECTED REFERENCE_NOT_FOUND ao esgotar", () => {
    const wallet = openWallet("100.00");
    const refund = wager(Kind.Refund, { referenceExternalTransactionId: "never" });
    const first = run(refund, wallet);
    const second = run(refund, wallet);
    expect(first.status === Status.PendingReference && first.nextAttemptAt.getTime()).toBe(
      T0.getTime() + 1_000,
    );
    expect(second.status === Status.PendingReference && second.nextAttemptAt.getTime()).toBe(
      T0.getTime() + 2_000,
    );
    // shortPolicy permite 2 novas tentativas: a terceira busca sem sucesso desiste.
    expect(run(refund, wallet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("referência chega depois: a nova tentativa processa normalmente", () => {
    const wallet = openWallet("100.00");
    const rollback = wager(Kind.Rollback, { referenceExternalTransactionId: "late-bet" });
    run(rollback, wallet);
    const bet = processedBet(wallet, "10.00");
    const lateBet = wager(Kind.Bet, { externalTransactionId: "late-bet" });
    lateBet.markProcessed(undefined, T0, wallet.balance);
    // A BET "atrasada" é a referência: mesmo valor do rollback (10.00).
    expect(run(rollback, wallet, lateBet).status).toBe(Status.Processed);
    expect(rollback.referenceTransactionId).toBe(lateBet.id);
    expect(bet.status).toBe(Status.Processed);
  });

  test("referência que também aguarda a própria referência → continua esperando", () => {
    const wallet = openWallet("100.00");
    const pendingRefund = wager(Kind.Refund, { referenceExternalTransactionId: "missing-bet" });
    run(pendingRefund, wallet);
    const rollback = wager(Kind.Rollback, {
      referenceExternalTransactionId: pendingRefund.externalTransactionId,
    });
    expect(run(rollback, wallet, pendingRefund).status).toBe(Status.PendingReference);
  });
});

describe("guarda de pertencimento à wallet (ADR 0007)", () => {
  test("player diferente da wallet lança, sem persistir resultado", () => {
    const wallet = openWallet("100.00");
    const bet = wager(Kind.Bet, { playerId: "intruder" });
    expect(() => run(bet, wallet)).toThrow(WalletPlayerMismatchError);
    expect(bet.status).toBe(Status.Pending);
  });

  test("moeda diferente da wallet lança CurrencyMismatchError", () => {
    const wallet = openWallet("100.00");
    const bet = wager(Kind.Bet, { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(() => run(bet, wallet)).toThrow(CurrencyMismatchError);
  });
});

describe("invariante: saldo == saldo reconstruído pelo ledger", () => {
  test("rodada completa", () => {
    const wallet = openWallet("0.00");
    const entries: WalletLedgerEntry[] = [];
    const pushIfEntry = (o: SettlementOutcome) => {
      if (o.status === Status.Processed && o.ledgerEntry) entries.push(o.ledgerEntry);
    };
    pushIfEntry(run(wager(Kind.Win, { money: brl("100.00") }), wallet));
    const bet = wager(Kind.Bet, { money: brl("30.00") });
    pushIfEntry(run(bet, wallet));
    pushIfEntry(run(wager(Kind.Bet, { money: brl("500.00") }), wallet)); // rejeitada
    const win = wager(Kind.Win, {
      money: brl("12.34"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    pushIfEntry(run(win, wallet, bet));
    pushIfEntry(
      run(
        wager(Kind.Rollback, {
          money: brl("12.34"),
          referenceExternalTransactionId: win.externalTransactionId,
        }),
        wallet,
        win,
      ),
    );
    const fromLedger = entries.reduce((acc, e) => acc.add(e.signedAmount()), brl("0.00"));
    expect(entries).toHaveLength(4);
    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("70.00");
  });
});
