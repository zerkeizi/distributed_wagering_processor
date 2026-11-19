import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "../../../../src/wagering/application/errors.ts";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../../../src/wagering/application/ledger-cursor.ts";

const W = "0192f291-27dd-7d3f-8071-5f8685deef37";

describe("cursor do extrato", () => {
  test("ida e volta preserva a versão", () => {
    expect(decodeLedgerCursor(W, encodeLedgerCursor(W, 42))).toBe(42);
  });

  test("é opaco: não expõe a estrutura em texto puro e é seguro em URL", () => {
    const cursor = encodeLedgerCursor(W, 7);
    expect(cursor).not.toContain(W);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test.each([
    ["lixo", "%%%"],
    ["base64 de algo que não é JSON", Buffer.from("hello").toString("base64url")],
    ["versão não inteira", Buffer.from(JSON.stringify({ w: W, v: 1.5 })).toString("base64url")],
    ["versão abaixo de 2", Buffer.from(JSON.stringify({ w: W, v: 1 })).toString("base64url")],
    ["de outra wallet", encodeLedgerCursor("other-wallet", 10)],
  ])("rejeita %s", (_, cursor) => {
    expect(() => decodeLedgerCursor(W, cursor)).toThrow(InvalidRequestError);
  });
});
