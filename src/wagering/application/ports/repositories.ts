import type { InboxMessage } from "../../../shared/messaging/inbox-message.ts";
import type { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import type { ResolvedReference } from "../../domain/reference-policy.ts";
import type { WagerTransaction } from "../../domain/wager-transaction.ts";
import type { Wallet } from "../../domain/wallet.ts";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry.ts";

/**
 * Portas de persistência usadas pelos use cases. Toda instância vive dentro de um
 * `TransactionScope` (ver unit-of-work.ts): escritas só chegam ao banco no commit do scope.
 *
 * `add` registra um agregado novo; `save` grava as mudanças de um agregado carregado neste mesmo
 * scope. Gravar um agregado que o scope não carregou é erro de programação.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: serializa todas as operações da wallet até o fim do scope (ADR 0003). */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * Resolve a reference por (providerId, referenceExternalTransactionId) e informa se ela já é alvo
   * de um reversal PROCESSED (ADR 0006).
   */
  findReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<ResolvedReference | undefined>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  /** Versão a partir da qual buscar a próxima página (exclusiva), ou `undefined` se acabou. */
  readonly nextBeforeVersion: number | undefined;
}

export interface LedgerRepository {
  /** Append-only: não existe update nem delete (CHALLENGE §5.5). */
  append(entry: WalletLedgerEntry): void;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  /** Do mais recente para o mais antigo. `beforeVersion` é exclusivo. */
  listByWallet(
    walletId: string,
    options: { limit: number; beforeVersion?: number },
  ): Promise<LedgerPage>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}
