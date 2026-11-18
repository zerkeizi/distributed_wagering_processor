import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../../src/shared/domain/domain-error.ts";
import { OutboxMessage } from "../../../../src/shared/messaging/outbox-message.ts";
import { WagerTransactionPendingReference } from "../../../../src/wagering/domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../../../../src/wagering/domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../../../../src/wagering/domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../../../../src/wagering/domain/events/wallet-balance-changed.ts";
import { FailureCode } from "../../../../src/wagering/domain/failure-code.ts";
import {
  WagerTransactionKind as Kind,
  LedgerDirection,
} from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import { brl, openWallet, T0, WALLET_ID, wager } from "./fixtures.ts";

const ctx = { eventId: "evt-1", correlationId: "corr-1", causationId: "tx-1", occurredAt: T0 };

describe("eventos de integração", () => {
  test("WalletBalanceChanged: envelope com tipo/versão do tipo e Money como string", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit({
      entryId: "e1",
      transactionId: "tx-1",
      money: brl("25.00"),
      at: T0,
    });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: WALLET_ID,
      correlationId: "corr-1",
      causationId: "tx-1",
      occurredAt: "2026-07-29T15:00:00.000Z",
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: "tx-1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("o payload é JSON estável: serializar e reler não perde nada", () => {
    const tx = wager(Kind.Loss, { money: brl("0.00") });
    tx.markProcessed(undefined, T0, brl("10.00"));
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.data.kind).toBe(Kind.Loss);
    expect(json.data.roundId).toBe(tx.roundId ?? null);
  });

  test("causationId é omitido do envelope quando ausente", () => {
    const tx = wager(Kind.Bet);
    tx.reject(FailureCode.InsufficientFunds, T0, brl("0.00"));
    const json = WagerTransactionRejected.from(tx, {
      eventId: "e",
      correlationId: "c",
      occurredAt: T0,
    }).toJSON();
    expect("causationId" in json).toBe(false);
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("cada evento exige o estado correspondente da transação", () => {
    const tx = wager(Kind.Bet);
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow(InvariantViolationError);
  });

  test("PendingReference carrega a referência aguardada e a próxima tentativa", () => {
    const tx = wager(Kind.Rollback, { referenceExternalTransactionId: "bet-x" });
    tx.markPendingReference(new Date(T0.getTime() + 2_000), T0);
    const json = WagerTransactionPendingReference.from(tx, ctx).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe("bet-x");
    expect(json.data.nextAttemptAt).toBe("2026-07-29T15:00:02.000Z");
  });

  test("OutboxMessage.enqueue usa o eventId como id e grava o envelope serializado", () => {
    const tx = wager(Kind.Bet);
    tx.markProcessed(undefined, T0, brl("90.00"));
    const event = WagerTransactionProcessed.from(tx, ctx);
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe("evt-1");
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.aggregateId).toBe(tx.walletId);
    expect(message.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(message.isDue(T0)).toBe(true);
  });
});
