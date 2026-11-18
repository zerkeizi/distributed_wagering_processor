import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../../src/shared/domain/domain-error.ts";
import { ExponentialBackoff } from "../../../../src/shared/domain/exponential-backoff.ts";
import { InboxMessage } from "../../../../src/shared/messaging/inbox-message.ts";
import { OutboxMessage } from "../../../../src/shared/messaging/outbox-message.ts";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("InboxMessage", () => {
  test("recebida, processada uma única vez", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-transactions",
      payloadHash: "abc",
      receivedAt: T0,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at(5));
    expect(msg.processedAt).toEqual(at(5));
    expect(() => msg.markProcessed(at(6))).toThrow(InvariantViolationError);
  });

  test("mesmo messageId com corpo diferente não é redelivery", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "c",
      payloadHash: "abc",
      receivedAt: T0,
    });
    expect(msg.matchesPayload("abc")).toBe(true);
    expect(msg.matchesPayload("xyz")).toBe(false);
  });
});

describe("OutboxMessage", () => {
  const state = {
    id: "evt-1",
    aggregateId: "w",
    eventType: "X",
    payload: {},
    occurredAt: T0,
    attempts: 0,
    nextAttemptAt: T0,
    publishedAt: undefined,
  };
  const backoff = new ExponentialBackoff(1_000, 8_000);

  test("retry incrementa attempts e agenda com backoff; não fica due antes da hora", () => {
    const msg = OutboxMessage.rehydrate(state);
    msg.scheduleRetry(T0, backoff);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(at(1_000));
    expect(msg.isDue(at(999))).toBe(false);
    expect(msg.isDue(at(1_000))).toBe(true);
    msg.scheduleRetry(at(1_000), backoff);
    expect(msg.nextAttemptAt).toEqual(at(3_000));
  });

  test("sem limite de tentativas: continua agendando no teto", () => {
    const msg = OutboxMessage.rehydrate(state);
    for (let i = 0; i < 50; i++) msg.scheduleRetry(T0, backoff);
    expect(msg.attempts).toBe(50);
    expect(msg.nextAttemptAt).toEqual(at(8_000));
    expect(msg.isPending()).toBe(true);
  });

  test("publicada deixa de ser pendente e não aceita nova transição", () => {
    const msg = OutboxMessage.rehydrate(state);
    msg.markPublished(at(10));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at(10_000))).toBe(false);
    expect(() => msg.markPublished(at(11))).toThrow(InvariantViolationError);
    expect(() => msg.scheduleRetry(at(11), backoff)).toThrow(InvariantViolationError);
  });
});
