import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computeWagerPayloadHash,
  type WagerPayloadFields,
} from "../../../../src/wagering/domain/payload-hash.ts";
import { WagerTransactionKind } from "../../../../src/wagering/domain/wager-transaction-kind.ts";
import { brl, wager } from "./fixtures.ts";

const fields: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: { amount: "25.00", currency: "BRL" },
  referenceExternalTransactionId: undefined,
};

describe("canonicalJson", () => {
  test("ordena chaves recursivamente e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: true, y: null }] } })).toBe(
      '{"a":{"c":[2,{"y":null,"z":true}]},"b":1}',
    );
  });

  test("rejeita tipos sem representação JSON única", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
});

describe("computeWagerPayloadHash", () => {
  test("é SHA-256 hex do JSON canônico — vetor fixo documentado", () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expected = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
    expect(computeWagerPayloadHash(fields)).toBe(expected);
  });

  test("independe da ordem das chaves de entrada", () => {
    const reordered = Object.fromEntries(
      Object.entries(fields).reverse(),
    ) as unknown as WagerPayloadFields;
    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(fields));
  });

  test.each([
    ["valor", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["rodada", { roundId: "round-988" }],
    ["referência", { referenceExternalTransactionId: "x" }],
    ["wallet", { walletId: "other" }],
  ])("payload divergente (%s) produz hash diferente", (_, override) => {
    expect(computeWagerPayloadHash({ ...fields, ...override })).not.toBe(
      computeWagerPayloadHash(fields),
    );
  });
});

describe("idempotency key com payload divergente", () => {
  test("mesma key, mesmo conteúdo → matchesPayload (replay)", () => {
    const original = wager(WagerTransactionKind.Bet, { externalTransactionId: "t-1" });
    const again = wager(WagerTransactionKind.Bet, { externalTransactionId: "t-1" });
    expect(again.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(again.payloadHash)).toBe(true);
  });

  test("mesma key, valor diferente → não é replay (conflito)", () => {
    const original = wager(WagerTransactionKind.Bet, { externalTransactionId: "t-2" });
    const tampered = wager(WagerTransactionKind.Bet, {
      externalTransactionId: "t-2",
      money: brl("99.00"),
    });
    expect(tampered.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(tampered.payloadHash)).toBe(false);
  });

  test("metadados fora do payload de negócio não mudam o hash", () => {
    const a = wager(WagerTransactionKind.Bet, { externalTransactionId: "t-3", correlationId: "x" });
    const b = wager(WagerTransactionKind.Bet, {
      externalTransactionId: "t-3",
      correlationId: "y",
      idempotencyKey: "custom-key",
    });
    expect(a.matchesPayload(b.payloadHash)).toBe(true);
  });
});
