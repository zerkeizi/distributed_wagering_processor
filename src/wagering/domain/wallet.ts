import { InvariantViolationError } from "../../shared/domain/domain-error.ts";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "../../shared/domain/money.ts";
import { InsufficientFundsError } from "./errors.ts";
import { LedgerDirection } from "./wager-transaction-kind.ts";
import { WalletLedgerEntry } from "./wallet-ledger-entry.ts";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  /** Transação OPENING que justifica o crédito inicial (só usada se o saldo for > 0). */
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
  readonly at: Date;
}

export interface WalletOpening {
  readonly wallet: Wallet;
  /** Ausente quando o saldo inicial é zero: sem movimento, sem lançamento. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

/**
 * Aggregate root do saldo. Toda alteração de saldo passa por `debit`/`credit`, que devolvem o
 * lançamento correspondente: não existe forma de mudar o saldo sem produzir um ledger entry.
 *
 * `version` começa em 1 após a abertura e incrementa somente quando o saldo muda (README §6.2).
 * A abertura com saldo inicial > 0 é o próprio movimento que leva a versão de 0 a 1.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError("initial balance cannot be negative");
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      Money.zero(initialBalance.currency),
      0,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) {
      wallet._version = 1;
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = wallet.credit({
      entryId: props.openingEntryId,
      transactionId: props.openingTransactionId,
      money: initialBalance,
      at: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError se o saldo não cobre o valor. */
  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  move(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(movement) : this.credit(movement);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    if (!movement.money.isPositive()) {
      throw new InvariantViolationError("balance movement must be a positive amount");
    }
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(movement.money)
        : this._balance.subtract(movement.money);
    // O lançamento é criado (e validado) antes de qualquer mutação: se falhar, a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
