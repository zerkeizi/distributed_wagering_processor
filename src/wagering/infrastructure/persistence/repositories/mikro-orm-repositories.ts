import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import { InvariantViolationError } from "../../../../shared/domain/domain-error.ts";
import type { InboxMessage } from "../../../../shared/messaging/inbox-message.ts";
import type { OutboxMessage } from "../../../../shared/messaging/outbox-message.ts";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from "../../../application/ports/repositories.ts";
import type { TransactionScope } from "../../../application/ports/unit-of-work.ts";
import type { ResolvedReference } from "../../../domain/reference-policy.ts";
import type { WagerTransaction } from "../../../domain/wager-transaction.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction-kind.ts";
import type { Wallet } from "../../../domain/wallet.ts";
import type { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry.ts";
import {
  inboxToDomain,
  inboxToRecord,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from "../mappers.ts";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../records.ts";

/**
 * Cada repositório guarda os records que carregou: `save` escreve o estado do agregado de volta
 * no record gerenciado pelo Unit of Work, que calcula o UPDATE no flush (commit do scope).
 */
class Tracked<R> {
  private readonly records = new Map<string, R>();

  remember(id: string, record: R): R {
    this.records.set(id, record);
    return record;
  }

  require(id: string, what: string): R {
    const record = this.records.get(id);
    if (!record) {
      throw new InvariantViolationError(`${what} ${id} was not loaded in this transaction scope`);
    }
    return record;
  }
}

export class MikroOrmWalletRepository implements WalletRepository {
  private readonly tracked = new Tracked<WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? walletToDomain(this.tracked.remember(id, record)) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // refresh: mesmo que a wallet já esteja no identity map, a query com FOR UPDATE precisa ir ao
    // banco — é ela que adquire o lock e garante que lemos o saldo mais recente.
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletToDomain(this.tracked.remember(id, record)) : undefined;
  }

  add(wallet: Wallet): void {
    this.em.persist(this.tracked.remember(wallet.id, walletToRecord(wallet)));
  }

  save(wallet: Wallet): void {
    const record = this.tracked.require(wallet.id, "wallet");
    if (wallet.version < record.version) {
      throw new InvariantViolationError(`wallet ${wallet.id} would move version backwards`);
    }
    walletToRecord(wallet, record);
  }
}

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly tracked = new Tracked<WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.load(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.load(await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }));
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.load(
      await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }),
    );
  }

  async findReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<ResolvedReference | undefined> {
    const transaction = await this.findByExternalId(providerId, externalTransactionId);
    if (!transaction) return undefined;
    const reversals = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transaction.id,
      kind: { $in: REVERSAL_KINDS },
      status: WagerTransactionStatus.Processed,
    });
    return { transaction, alreadyReversed: reversals > 0 };
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(this.tracked.remember(transaction.id, transactionToRecord(transaction)));
  }

  save(transaction: WagerTransaction): void {
    transactionToRecord(transaction, this.tracked.require(transaction.id, "wager transaction"));
  }

  private load(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    return record ? transactionToDomain(this.tracked.remember(record.id, record)) : undefined;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.persist(ledgerEntryToRecord(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(LedgerEntryRecord, { transactionId });
    return record ? ledgerEntryToDomain(record) : undefined;
  }

  async listByWallet(
    walletId: string,
    options: { limit: number; beforeVersion?: number },
  ): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      {
        walletId,
        ...(options.beforeVersion !== undefined
          ? { walletVersion: { $lt: options.beforeVersion } }
          : {}),
      },
      { orderBy: { walletVersion: "desc" }, limit: options.limit + 1 },
    );
    const page = records.slice(0, options.limit);
    const hasMore = records.length > options.limit;
    return {
      entries: page.map(ledgerEntryToDomain),
      nextBeforeVersion: hasMore ? page.at(-1)?.walletVersion : undefined,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? inboxToDomain(record) : undefined;
  }

  add(message: InboxMessage): void {
    this.em.persist(inboxToRecord(message));
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(outboxToRecord(message));
  }
}

export function createTransactionScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
