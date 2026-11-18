import { Money } from "../../../shared/domain/money.ts";
import { InboxMessage } from "../../../shared/messaging/inbox-message.ts";
import { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import type { FailureCode } from "../../domain/failure-code.ts";
import { WagerTransaction } from "../../domain/wager-transaction.ts";
import type {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction-kind.ts";
import { Wallet } from "../../domain/wallet.ts";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.ts";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records.ts";

/**
 * Converte NUMERIC(20,2) lido do Postgres (sempre "975.00", com 2 casas) em Money. Reusa o parser
 * estrito de entrada: um valor fora do formato no banco indica corrupção e deve explodir alto.
 */
function moneyFromColumn(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

const toNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);
const toUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

// ------------------------------------------------------------------ Wallet

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: moneyFromColumn(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** Escreve o estado do agregado num record (novo ou já gerenciado pelo Unit of Work). */
export function walletToRecord(wallet: Wallet, target = new WalletRecord()): WalletRecord {
  const s = wallet.toState();
  target.id = s.id;
  target.playerId = s.playerId;
  target.currency = s.currency;
  target.balance = s.balance.amount;
  target.version = s.version;
  target.createdAt = s.createdAt;
  target.updatedAt = s.updatedAt;
  return target;
}

// -------------------------------------------------------- WagerTransaction

export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: toUndefined(r.roundId),
    gameId: toUndefined(r.gameId),
    kind: r.kind as WagerTransactionKind,
    money: moneyFromColumn(r.amount, r.currency),
    referenceExternalTransactionId: toUndefined(r.referenceExternalTransactionId),
    correlationId: r.correlationId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: toUndefined(r.referenceTransactionId),
    failureCode: toUndefined(r.failureCode) as FailureCode | undefined,
    processedAt: toUndefined(r.processedAt),
    balanceAfter: r.balanceAfter === null ? undefined : moneyFromColumn(r.balanceAfter, r.currency),
    resolutionAttempts: r.resolutionAttempts,
    nextResolutionAt: toUndefined(r.nextResolutionAt),
  });
}

export function transactionToRecord(
  tx: WagerTransaction,
  target = new WagerTransactionRecord(),
): WagerTransactionRecord {
  const s = tx.toState();
  target.id = s.id;
  target.providerId = s.providerId;
  target.externalTransactionId = s.externalTransactionId;
  target.idempotencyKey = s.idempotencyKey;
  target.payloadHash = s.payloadHash;
  target.walletId = s.walletId;
  target.playerId = s.playerId;
  target.currency = s.money.currency;
  target.roundId = toNull(s.roundId);
  target.gameId = toNull(s.gameId);
  target.kind = s.kind;
  target.amount = s.money.amount;
  target.referenceExternalTransactionId = toNull(s.referenceExternalTransactionId);
  target.referenceTransactionId = toNull(s.referenceTransactionId);
  target.status = s.status;
  target.failureCode = toNull(s.failureCode);
  target.balanceAfter = s.balanceAfter ? s.balanceAfter.amount : null;
  target.processedAt = toNull(s.processedAt);
  target.resolutionAttempts = s.resolutionAttempts;
  target.nextResolutionAt = toNull(s.nextResolutionAt);
  target.correlationId = s.correlationId;
  target.createdAt = s.createdAt;
  target.updatedAt = s.updatedAt;
  return target;
}

// ------------------------------------------------------------- LedgerEntry

export function ledgerEntryToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: moneyFromColumn(r.amount, r.currency),
    balanceBefore: moneyFromColumn(r.balanceBefore, r.currency),
    balanceAfter: moneyFromColumn(r.balanceAfter, r.currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  const r = new LedgerEntryRecord();
  r.id = entry.id;
  r.walletId = entry.walletId;
  r.transactionId = entry.transactionId;
  r.currency = entry.money.currency;
  r.direction = entry.direction;
  r.amount = entry.money.amount;
  r.balanceBefore = entry.balanceBefore.amount;
  r.balanceAfter = entry.balanceAfter.amount;
  r.walletVersion = entry.walletVersion;
  r.createdAt = entry.createdAt;
  return r;
}

// ------------------------------------------------------------ Inbox/Outbox

export function inboxToDomain(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: r.consumerName,
    messageId: r.messageId,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: toUndefined(r.processedAt),
  });
}

export function inboxToRecord(msg: InboxMessage, target = new InboxMessageRecord()) {
  const s = msg.toState();
  target.consumerName = s.consumerName;
  target.messageId = s.messageId;
  target.payloadHash = s.payloadHash;
  target.receivedAt = s.receivedAt;
  target.processedAt = toNull(s.processedAt);
  return target;
}

export function outboxToDomain(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: toUndefined(r.nextAttemptAt),
    publishedAt: toUndefined(r.publishedAt),
  });
}

export function outboxToRecord(msg: OutboxMessage, target = new OutboxMessageRecord()) {
  const s = msg.toState();
  target.id = s.id;
  target.aggregateId = s.aggregateId;
  target.eventType = s.eventType;
  target.payload = { ...s.payload };
  target.occurredAt = s.occurredAt;
  target.attempts = s.attempts;
  target.nextAttemptAt = toNull(s.nextAttemptAt);
  target.publishedAt = toNull(s.publishedAt);
  target.lockedUntil ??= null;
  return target;
}
