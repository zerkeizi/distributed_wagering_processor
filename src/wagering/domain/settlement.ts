import { InvariantViolationError } from "../../shared/domain/domain-error.ts";
import { CurrencyMismatchError } from "../../shared/domain/money.ts";
import { WalletPlayerMismatchError } from "./errors.ts";
import { FailureCode } from "./failure-code.ts";
import { evaluateReference, type ResolvedReference } from "./reference-policy.ts";
import type { ReferenceResolutionPolicy } from "./reference-resolution-policy.ts";
import type { WagerTransaction } from "./wager-transaction.ts";
import { LedgerDirection, WagerTransactionStatus } from "./wager-transaction-kind.ts";
import type { Wallet } from "./wallet.ts";
import type { WalletLedgerEntry } from "./wallet-ledger-entry.ts";

export interface SettlementInput {
  /** Em PENDING (primeira vez) ou PENDING_REFERENCE (nova tentativa). */
  readonly transaction: WagerTransaction;
  /** Já travada pelo chamador (ADR 0003): a decisão abaixo assume exclusão mútua na wallet. */
  readonly wallet: Wallet;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); `undefined` = não existe. */
  readonly reference: ResolvedReference | undefined;
  readonly resolutionPolicy: ReferenceResolutionPolicy;
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export type SettlementOutcome =
  | {
      readonly status: WagerTransactionStatus.Processed;
      /** Ausente para LOSS, que não move saldo. */
      readonly ledgerEntry: WalletLedgerEntry | undefined;
    }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: FailureCode }
  | { readonly status: WagerTransactionStatus.PendingReference; readonly nextAttemptAt: Date };

/**
 * Aplica as regras de negócio (CHALLENGE §7) de uma wager transaction sobre a wallet, mutando ambas
 * de forma consistente: ou o saldo muda junto com o lançamento e a transação vira PROCESSED, ou
 * nada no saldo muda. Função pura de domínio — sem I/O; persistir o resultado é do use case.
 */
export function settle(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, at } = input;
  assertBelongsToWallet(tx, wallet);

  let reference: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId !== undefined) {
    if (!input.reference) return waitOrGiveUp(input);
    const verdict = evaluateReference(tx, input.reference);
    if (verdict.outcome === "wait") return waitOrGiveUp(input);
    if (verdict.outcome === "reject") return rejectWith(tx, wallet, verdict.code, at);
    reference = input.reference.transaction;
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return rejectWith(tx, wallet, tx.insufficientFundsCode(), at);
  }

  const ledgerEntry = wallet.move(direction, {
    entryId: input.ledgerEntryId,
    transactionId: tx.id,
    money: tx.money,
    at,
  });
  tx.markProcessed(reference?.id, at, wallet.balance);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function waitOrGiveUp(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, at } = input;
  const nextAttemptAt = input.resolutionPolicy.nextAttemptAt(tx.resolutionAttempts, at);
  if (nextAttemptAt === undefined) {
    return rejectWith(tx, wallet, FailureCode.ReferenceNotFound, at);
  }
  tx.markPendingReference(nextAttemptAt, at);
  return { status: WagerTransactionStatus.PendingReference, nextAttemptAt };
}

function rejectWith(
  tx: WagerTransaction,
  wallet: Wallet,
  code: FailureCode,
  at: Date,
): SettlementOutcome {
  tx.reject(code, at, wallet.balance);
  return { status: WagerTransactionStatus.Rejected, failureCode: code };
}

/**
 * O use case recusa wallet inexistente/divergente antes de persistir qualquer coisa (ADR 0007);
 * aqui é a última barreira, para que o domínio nunca aplique a transação na wallet errada.
 */
function assertBelongsToWallet(tx: WagerTransaction, wallet: Wallet): void {
  if (tx.walletId !== wallet.id) {
    throw new InvariantViolationError(`transaction ${tx.id} does not target wallet ${wallet.id}`);
  }
  if (tx.playerId !== wallet.playerId) throw new WalletPlayerMismatchError(wallet.id);
  if (tx.money.currency !== wallet.currency) {
    throw new CurrencyMismatchError(wallet.currency, tx.money.currency);
  }
}
