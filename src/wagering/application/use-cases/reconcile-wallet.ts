import { Money, type MoneyProps } from "../../../shared/domain/money.ts";
import { WalletNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.ts";
import type { LedgerChainBreak } from "../ports/repositories.ts";
import type { WageringTelemetry } from "../ports/telemetry.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

const MAX_REPORTED_CHAIN_BREAKS = 20;

export type ReconciliationAnomaly =
  | { readonly type: "BALANCE_MISMATCH" }
  | { readonly type: "LAST_ENTRY_MISMATCH" }
  | { readonly type: "VERSION_MISMATCH"; readonly walletVersion: number }
  | { readonly type: LedgerChainBreak["kind"]; readonly walletVersion: number };

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  /** stored − calculated */
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly walletVersion: number;
  readonly lastEntryVersion: number | null;
  readonly anomalies: readonly ReconciliationAnomaly[];
  readonly checkedAt: string;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger (CHALLENGE §9). Lê wallet e
 * ledger no mesmo snapshot (REPEATABLE READ, sem lock), então não trava a wallet e não sofre com
 * lançamentos entrando no meio da conta. Divergências NÃO são corrigidas: são logadas, contadas em
 * métrica e devolvidas na resposta.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const { wallet, summary } = await this.uow.transactional(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        const summary = await scope.ledger.summarize(walletId, {
          maxChainBreaks: MAX_REPORTED_CHAIN_BREAKS,
        });
        return { wallet, summary };
      },
      { isolation: "snapshot" },
    );

    const stored = wallet.balance;
    const calculated = signedMoney(summary.signedTotal, wallet.currency);
    const anomalies: ReconciliationAnomaly[] = [];

    if (!stored.equals(calculated)) anomalies.push({ type: "BALANCE_MISMATCH" });
    if (summary.entries > 0) {
      if (summary.lastBalanceAfter !== stored.amount)
        anomalies.push({ type: "LAST_ENTRY_MISMATCH" });
      if (summary.lastVersion !== wallet.version) {
        anomalies.push({ type: "VERSION_MISMATCH", walletVersion: wallet.version });
      }
    } else if (wallet.version !== 1) {
      anomalies.push({ type: "VERSION_MISMATCH", walletVersion: wallet.version });
    }
    for (const brk of summary.chainBreaks) {
      anomalies.push({ type: brk.kind, walletVersion: brk.walletVersion });
    }

    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: anomalies.length === 0,
      checkedEntries: summary.entries,
      walletVersion: wallet.version,
      lastEntryVersion: summary.lastVersion ?? null,
      anomalies,
      checkedAt: this.clock.now().toISOString(),
    };
    if (!report.consistent) {
      this.telemetry.reconciliationDivergence({
        walletId,
        difference: report.difference,
        anomalies,
      });
    }
    return report;
  }
}

/** A soma do ledger pode ser negativa se o histórico estiver corrompido: aceita sinal aqui. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith("-")
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
