import { EntitySchema } from "@mikro-orm/postgresql";

/**
 * Modelo de persistência: classes "burras", uma por tabela, mapeadas por EntitySchema (ADR 0001).
 * O domínio nunca as vê — os mappers convertem para os agregados via `rehydrate`, e de volta.
 * Valores monetários trafegam como string decimal (NUMERIC(20,2)), nunca como number.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  currency!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  balanceAfter!: string | null;
  processedAt!: Date | null;
  resolutionAttempts!: number;
  nextResolutionAt!: Date | null;
  correlationId!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  currency!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  lockedUntil!: Date | null;
  publishedAt!: Date | null;
}

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const nullableMoney = { ...money, nullable: true } as const;

/*
 * O schema real é definido pela migration (fonte da verdade, com CHECKs e triggers). Estes
 * mapeamentos descrevem só colunas e tipos para o Unit of Work: nada aqui gera DDL.
 */

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallet",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: money,
    version: { type: "integer" },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transaction",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    roundId: { type: "string", nullable: true },
    gameId: { type: "string", nullable: true },
    kind: { type: "string" },
    amount: money,
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    balanceAfter: nullableMoney,
    processedAt: { type: "datetime", nullable: true },
    resolutionAttempts: { type: "integer" },
    nextResolutionAt: { type: "datetime", nullable: true },
    correlationId: { type: "string" },
    createdAt: { type: "datetime" },
    updatedAt: { type: "datetime" },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entry",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    direction: { type: "string" },
    amount: money,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: { type: "integer" },
    createdAt: { type: "datetime" },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_message",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "datetime" },
    processedAt: { type: "datetime", nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_message",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: "datetime" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", nullable: true },
    lockedUntil: { type: "datetime", nullable: true },
    publishedAt: { type: "datetime", nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
