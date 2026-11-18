import { FailureCode } from "./failure-code.ts";
import type { WagerTransaction } from "./wager-transaction.ts";
import { WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction-kind.ts";

/** Quais kinds cada operação pode referenciar (CHALLENGE §7.3, ADR 0006). */
const ALLOWED_REFERENCE_KINDS: Readonly<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface ResolvedReference {
  readonly transaction: WagerTransaction;
  /** A reference já é alvo de um reversal PROCESSED (ADR 0006). */
  readonly alreadyReversed: boolean;
}

export type ReferenceVerdict =
  | { readonly outcome: "accept" }
  /** A reference existe mas ainda aguarda a própria reference: continuar esperando. */
  | { readonly outcome: "wait" }
  | { readonly outcome: "reject"; readonly code: FailureCode };

/**
 * Valida uma reference encontrada, na ordem: pertencimento (provider, player, wallet, moeda,
 * round) → kind permitido → estado → valor (reversals) → já revertida.
 */
export function evaluateReference(
  transaction: WagerTransaction,
  reference: ResolvedReference,
): ReferenceVerdict {
  const ref = reference.transaction;

  const sameOwnership =
    ref.providerId === transaction.providerId &&
    ref.playerId === transaction.playerId &&
    ref.walletId === transaction.walletId &&
    ref.money.currency === transaction.money.currency &&
    ref.roundId === transaction.roundId;
  if (!sameOwnership) return reject(FailureCode.ReferenceMismatch);

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(ref.kind)) {
    return reject(FailureCode.ReferenceKindNotAllowed);
  }

  if (ref.status === WagerTransactionStatus.PendingReference) return { outcome: "wait" };
  if (ref.status !== WagerTransactionStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }

  // Reversão parcial está fora de escopo (CHALLENGE §7.5).
  if (transaction.isReversal() && !ref.money.equals(transaction.money)) {
    return reject(FailureCode.AmountMismatch);
  }

  // Reversal sobre alvo já revertido credita/debita duas vezes; WIN/LOSS sobre BET revertida
  // liquidaria uma aposta que não existe mais.
  if (reference.alreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);

  return { outcome: "accept" };
}

function reject(code: FailureCode): ReferenceVerdict {
  return { outcome: "reject", code };
}
