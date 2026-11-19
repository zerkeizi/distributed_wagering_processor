import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../../src/shared/domain/domain-error.ts";
import { InvalidMoneyError } from "../../../../src/shared/domain/money.ts";
import { ErrorCode } from "../../../../src/wagering/domain/error-code.ts";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../../src/wagering/domain/errors.ts";
import { FailureCode } from "../../../../src/wagering/domain/failure-code.ts";
import {
  SYSTEM_PROVIDER_ID,
  WagerTransaction,
} from "../../../../src/wagering/domain/wager-transaction.ts";
import {
  WagerTransactionKind as Kind,
  LedgerDirection,
  WagerTransactionStatus as Status,
} from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import { brl, PLAYER_ID, T0, WALLET_ID, wager } from "./fixtures.ts";

const T1 = new Date(T0.getTime() + 1_000);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("WagerTransaction.create — validação por kind", () => {
  test("nasce em PENDING, sem resultado", () => {
    const tx = wager(Kind.Bet);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referenceExternalTransactionId", (kind) => {
    expect(codeOf(() => wager(kind))).toBe(ErrorCode.ReferenceRequired);
  });

  test.each([Kind.Win, Kind.Loss])("%s aceita referência opcional", (kind) => {
    expect(wager(kind).referenceExternalTransactionId).toBeUndefined();
    expect(
      wager(kind, { referenceExternalTransactionId: "bet-1" }).referenceExternalTransactionId,
    ).toBe("bet-1");
  });

  test("BET não pode referenciar outra transação", () => {
    expect(codeOf(() => wager(Kind.Bet, { referenceExternalTransactionId: "x" }))).toBe(
      ErrorCode.InvalidPayload,
    );
  });

  test("OPENING não pode ser submetido por provider", () => {
    expect(codeOf(() => wager(Kind.Opening))).toBe(ErrorCode.UnsupportedKind);
  });

  test("provider com prefixo reservado é recusado", () => {
    expect(codeOf(() => wager(Kind.Bet, { providerId: SYSTEM_PROVIDER_ID }))).toBe(
      ErrorCode.InvalidPayload,
    );
  });

  test("auto-referência é recusada", () => {
    expect(
      codeOf(() =>
        wager(Kind.Rollback, { externalTransactionId: "a", referenceExternalTransactionId: "a" }),
      ),
    ).toBe(ErrorCode.InvalidPayload);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])("%s de valor zero é recusado", (kind) => {
    expect(() =>
      wager(kind, {
        money: brl("0.00"),
        referenceExternalTransactionId: kind === Kind.Refund ? "b" : undefined,
      }),
    ).toThrow(InvalidMoneyError);
  });

  test("LOSS aceita valor zero", () => {
    expect(wager(Kind.Loss, { money: brl("0.00") }).money.isZero()).toBe(true);
  });

  test.each([
    ["providerId vazio", { providerId: "" }],
    ["roundId só com espaços", { roundId: "   " }],
    ["externalTransactionId longo demais", { externalTransactionId: "x".repeat(129) }],
  ])("rejeita %s", (_, override) => {
    expect(() => wager(Kind.Bet, override)).toThrow(InvalidWagerTransactionError);
  });
});

describe("WagerTransaction — consultas de domínio", () => {
  test("affectsBalance é false somente para LOSS", () => {
    expect(wager(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) expect(wager(kind).affectsBalance()).toBe(true);
  });

  test("ledgerDirectionFor: BET debita, WIN/REFUND creditam", () => {
    expect(wager(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(wager(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager(Kind.Refund, { referenceExternalTransactionId: "b" }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test("ledgerDirectionFor: ROLLBACK inverte a direção da referência", () => {
    const rollback = wager(Kind.Rollback, { referenceExternalTransactionId: "r" });
    expect(rollback.ledgerDirectionFor(wager(Kind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(wager(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(wager(Kind.Refund, { referenceExternalTransactionId: "b" })),
    ).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test("LOSS não tem direção de lançamento", () => {
    expect(() => wager(Kind.Loss).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test("insufficientFundsCode distingue aposta de reversão", () => {
    expect(wager(Kind.Bet).insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(
      wager(Kind.Rollback, { referenceExternalTransactionId: "w" }).insufficientFundsCode(),
    ).toBe(FailureCode.ReversalInsufficientFunds);
  });
});

describe("WagerTransaction — transições", () => {
  test("PENDING → PROCESSED guarda referência, instante e saldo observado", () => {
    const tx = wager(Kind.Win, { referenceExternalTransactionId: "bet-1" });
    tx.markProcessed("internal-bet-id", T1, brl("90.00"));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("internal-bet-id");
    expect(tx.processedAt).toBe(T1);
    expect(tx.balanceAfter?.amount).toBe("90.00");
    expect(tx.isTerminal()).toBe(true);
  });

  test("PROCESSED exige a referência resolvida quando foi informada", () => {
    const tx = wager(Kind.Win, { referenceExternalTransactionId: "bet-1" });
    expect(() => tx.markProcessed(undefined, T1, brl("1.00"))).toThrow(InvariantViolationError);
  });

  test("PENDING → PENDING_REFERENCE → PENDING_REFERENCE conta tentativas → PROCESSED", () => {
    const tx = wager(Kind.Rollback, { referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(T1, T0);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.resolutionAttempts).toBe(1);
    tx.markPendingReference(new Date(T1.getTime() + 1_000), T1);
    expect(tx.resolutionAttempts).toBe(2);
    tx.markProcessed("bet-internal", T1, brl("10.00"));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.nextResolutionAt).toBeUndefined();
  });

  test("PENDING_REFERENCE só faz sentido com referência", () => {
    expect(() => wager(Kind.Bet).markPendingReference(T1, T0)).toThrow(InvariantViolationError);
  });

  test("reject só aceita códigos de rejeição de negócio", () => {
    const tx = wager(Kind.Bet);
    // Código de requisição (ex.: LOCK_TIMEOUT) nem compila aqui; o que sobra checar em execução é
    // o código de falha interna, que é persistível mas não é rejeição.
    expect(() => tx.reject(FailureCode.InternalInvariantViolation, T1, brl("1.00"))).toThrow(
      InvariantViolationError,
    );
    tx.reject(FailureCode.InsufficientFunds, T1, brl("1.00"));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.amount).toBe("1.00");
  });

  test("fail só aceita código interno", () => {
    const tx = wager(Kind.Bet);
    expect(() => tx.fail(FailureCode.InsufficientFunds, T1)).toThrow(InvariantViolationError);
    tx.fail(FailureCode.InternalInvariantViolation, T1);
    expect(tx.status).toBe(Status.Failed);
  });

  const toTerminal: Record<string, (tx: WagerTransaction) => void> = {
    PROCESSED: (tx) => tx.markProcessed(undefined, T1, brl("1.00")),
    REJECTED: (tx) => tx.reject(FailureCode.InsufficientFunds, T1, brl("1.00")),
    FAILED: (tx) => tx.fail(FailureCode.InternalInvariantViolation, T1),
  };
  const transitions: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) => tx.markProcessed(undefined, T1, brl("1.00")),
    markPendingReference: (tx) => tx.markPendingReference(T1, T1),
    reject: (tx) => tx.reject(FailureCode.AmountMismatch, T1, brl("1.00")),
    fail: (tx) => tx.fail(FailureCode.InternalInvariantViolation, T1),
  };
  for (const [terminal, reach] of Object.entries(toTerminal)) {
    for (const [name, transition] of Object.entries(transitions)) {
      test(`${terminal} é terminal: ${name} lança InvalidTransactionStateError`, () => {
        const tx = wager(Kind.Win, { referenceExternalTransactionId: undefined });
        reach(tx);
        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
      });
    }
  }
});

describe("WagerTransaction.createOpening", () => {
  test("usa o provider reservado e identidade derivada da wallet (ADR 0015)", () => {
    const tx = WagerTransaction.createOpening({
      id: "op-1",
      walletId: WALLET_ID,
      playerId: PLAYER_ID,
      money: brl("1000.00"),
      correlationId: "c",
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe(SYSTEM_PROVIDER_ID);
    expect(tx.externalTransactionId).toBe(WALLET_ID);
    expect(tx.idempotencyKey).toBe(`opening:${WALLET_ID}`);
    expect(tx.roundId).toBeUndefined();
    expect(tx.gameId).toBeUndefined();
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
