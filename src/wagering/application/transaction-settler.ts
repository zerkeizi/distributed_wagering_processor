import { OutboxMessage } from "../../shared/messaging/outbox-message.ts";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference.ts";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed.ts";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected.ts";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed.ts";
import type { ResolvedReference } from "../domain/reference-policy.ts";
import type { ReferenceResolutionPolicy } from "../domain/reference-resolution-policy.ts";
import { type SettlementOutcome, settle } from "../domain/settlement.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import { WagerTransactionStatus } from "../domain/wager-transaction-kind.ts";
import type { Wallet } from "../domain/wallet.ts";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry.ts";
import { eventContext } from "./event-context.ts";
import type { IdGenerator } from "./ports/id-generator.ts";
import type { TransactionScope } from "./ports/unit-of-work.ts";

/**
 * Aplica as regras de uma wager transaction sobre a wallet JÁ TRAVADA e registra no scope tudo o que
 * o resultado exige: transação, lançamento, saldo, eventos e o reagendamento de quem esperava por
 * ela. Compartilhado pela submissão (HTTP/SQS) e pelo worker de referências pendentes, para que as
 * duas entradas produzam exatamente os mesmos efeitos.
 */
export class TransactionSettler {
  constructor(
    private readonly ids: IdGenerator,
    private readonly resolutionPolicy: ReferenceResolutionPolicy,
  ) {}

  findReference(
    scope: TransactionScope,
    tx: WagerTransaction,
  ): Promise<ResolvedReference | undefined> {
    return tx.referenceExternalTransactionId === undefined
      ? Promise.resolve(undefined)
      : scope.transactions.findReference(tx.providerId, tx.referenceExternalTransactionId);
  }

  /**
   * @param mode `add` para transação nova (ainda não persistida); `save` para uma já carregada no scope.
   * @param reference já buscada pelo chamador; se omitida, é buscada aqui.
   */
  async settleAndStage(
    scope: TransactionScope,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    mode: "add" | "save",
    reference?: ResolvedReference,
  ): Promise<SettlementOutcome> {
    const previousStatus = tx.status;
    const resolved = reference ?? (await this.findReference(scope, tx));
    const outcome = settle({
      transaction: tx,
      wallet,
      reference: resolved,
      resolutionPolicy: this.resolutionPolicy,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    if (mode === "add") scope.transactions.add(tx);
    else scope.transactions.save(tx);

    const ledgerEntry =
      outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
    if (ledgerEntry) {
      scope.ledger.append(ledgerEntry);
      scope.wallets.save(wallet);
    }
    this.stageEvents(scope, tx, wallet, ledgerEntry, previousStatus, now);

    if (tx.isTerminal()) {
      await scope.transactions.rescheduleWaitingOn(tx.providerId, tx.externalTransactionId, now);
    }
    return outcome;
  }

  private stageEvents(
    scope: TransactionScope,
    tx: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    previousStatus: WagerTransactionStatus,
    now: Date,
  ): void {
    const ctx = () => eventContext(this.ids, tx.correlationId, tx.id, now);
    const enqueue = (event: Parameters<typeof OutboxMessage.enqueue>[0]) =>
      scope.outbox.add(OutboxMessage.enqueue(event));
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        enqueue(WagerTransactionProcessed.from(tx, ctx()));
        if (ledgerEntry) enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        enqueue(WagerTransactionRejected.from(tx, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        // Só na ENTRADA em espera; novas tentativas agendadas não geram evento (ruído).
        if (previousStatus !== WagerTransactionStatus.PendingReference) {
          enqueue(WagerTransactionPendingReference.from(tx, ctx()));
        }
        break;
    }
  }
}
