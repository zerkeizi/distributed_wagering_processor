import { InvariantViolationError } from "../../shared/domain/domain-error.ts";
import type { Money } from "../../shared/domain/money.ts";
import { LedgerDirection } from "./wager-transaction-kind.ts";

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Versão da wallet após este lançamento: sequência sem buracos por wallet (ADR 0009). */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Registro imutável de uma alteração de saldo. Imutabilidade estrutural: campos `readonly`,
 * instância congelada e nenhum método de transição. O schema repete as mesmas garantias
 * (CHECK da aritmética, trigger contra UPDATE/DELETE).
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética e as moedas do lançamento antes de existir. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const currencies = new Set([
      props.money.currency,
      props.balanceBefore.currency,
      props.balanceAfter.currency,
    ]);
    if (currencies.size !== 1) {
      throw new InvariantViolationError("ledger entry mixes currencies");
    }
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("ledger entry amount must be positive");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError("ledger entry would leave a negative balance");
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError("ledger entry wallet version must be >= 1");
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError("ledger entry is not balanced");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: +money para crédito, −money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
