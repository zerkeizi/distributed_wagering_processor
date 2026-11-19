import { InvalidRequestError, WalletNotFoundError } from "../errors.ts";
import { decodeLedgerCursor, encodeLedgerCursor } from "../ledger-cursor.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { type LedgerEntryView, toLedgerEntryView } from "../views.ts";

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export interface ListLedgerQuery {
  readonly walletId: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface LedgerPageView {
  readonly items: readonly LedgerEntryView[];
  /** `null` na última página. */
  readonly nextCursor: string | null;
}

/** Extrato do mais recente para o mais antigo, paginado por cursor (CHALLENGE §9). */
export class ListLedger {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPageView> {
    const limit = query.limit ?? LEDGER_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw new InvalidRequestError(`limit must be an integer between 1 and ${LEDGER_MAX_LIMIT}`);
    }
    const beforeVersion =
      query.cursor !== undefined ? decodeLedgerCursor(query.walletId, query.cursor) : undefined;

    return this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(query.walletId);
      if (!wallet) throw new WalletNotFoundError(query.walletId);
      const page = await scope.ledger.listByWallet(query.walletId, {
        limit,
        ...(beforeVersion !== undefined ? { beforeVersion } : {}),
      });
      return {
        items: page.entries.map(toLedgerEntryView),
        nextCursor:
          page.nextBeforeVersion !== undefined
            ? encodeLedgerCursor(query.walletId, page.nextBeforeVersion)
            : null,
      };
    });
  }
}
