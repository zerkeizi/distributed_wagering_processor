import { InvariantViolationError } from "../../shared/domain/domain-error.ts";
import { InvalidMoneyError, type Money } from "../../shared/domain/money.ts";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./errors.ts";
import { FailureCode, failureCategory } from "./failure-code.ts";
import { computeWagerPayloadHash } from "./payload-hash.ts";
import {
  LedgerDirection,
  PROVIDER_SUBMITTABLE_KINDS,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction-kind.ts";

/** Provider reservado das transações internas; nenhum provider externo pode usar o prefixo `__`. */
export const SYSTEM_PROVIDER_ID = "__system__";
const RESERVED_PROVIDER_PREFIX = "__";
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly at: Date;
}

export interface CreateOpeningProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly correlationId: string;
  readonly at: Date;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly processedAt: Date | undefined;
  /** Saldo observado ao finalizar (PROCESSED/REJECTED): o replay devolve este valor (README §7.7). */
  readonly balanceAfter: Money | undefined;
  /** Novas tentativas de resolver a reference já agendadas (README §7.1). */
  readonly resolutionAttempts: number;
  readonly nextResolutionAt: Date | undefined;
}

/**
 * Uma operação de aposta sobre uma wallet. Transições válidas:
 *
 *   PENDING ──────────┬─▶ PROCESSED  (terminal)
 *                     ├─▶ REJECTED   (terminal)
 *                     ├─▶ FAILED     (terminal)
 *                     └─▶ PENDING_REFERENCE ─┬─▶ PENDING_REFERENCE (nova tentativa agendada)
 *                                            ├─▶ PROCESSED
 *                                            ├─▶ REJECTED
 *                                            └─▶ FAILED
 *
 * Qualquer transição a partir de um estado terminal lança InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** Id da reference no provider — não o id interno. */
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _updatedAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _resolutionAttempts: number,
    private _nextResolutionAt: Date | undefined,
  ) {}

  /** Operação vinda de um provider. Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!PROVIDER_SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(
        FailureCode.UnsupportedKind,
        `kind ${String(props.kind)} cannot be submitted by a provider`,
      );
    }
    assertIdentifier("providerId", props.providerId);
    if (props.providerId.startsWith(RESERVED_PROVIDER_PREFIX)) {
      throw new InvalidWagerTransactionError(
        FailureCode.InvalidPayload,
        `providerId cannot start with "${RESERVED_PROVIDER_PREFIX}" (reserved)`,
      );
    }
    assertIdentifier("externalTransactionId", props.externalTransactionId);
    assertIdentifier("idempotencyKey", props.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    assertIdentifier("walletId", props.walletId);
    assertIdentifier("playerId", props.playerId);
    assertIdentifier("roundId", props.roundId);
    assertIdentifier("gameId", props.gameId);

    // LOSS registra o resultado sem mover saldo, então aceita 0.00; os demais movem saldo.
    const allowsZero = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!allowsZero && props.money.isZero())) {
      throw new InvalidMoneyError(
        allowsZero ? "amount cannot be negative" : "amount must be greater than zero",
      );
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      assertIdentifier("referenceExternalTransactionId", reference);
      if (reference === props.externalTransactionId) {
        throw new InvalidWagerTransactionError(
          FailureCode.InvalidPayload,
          "a transaction cannot reference itself",
        );
      }
    }
    if (requiresReference(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(
        FailureCode.ReferenceRequired,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError(
        FailureCode.InvalidPayload,
        "BET cannot reference another transaction",
      );
    }

    const payloadHash = computeWagerPayloadHash({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money.toJSON(),
      referenceExternalTransactionId: reference,
    });

    return WagerTransaction.pending({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      correlationId: props.correlationId,
      at: props.at,
    });
  }

  /** Crédito interno de abertura da wallet (ADR 0015). Nasce em PENDING. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("OPENING requires a positive amount");
    }
    const payloadHash = computeWagerPayloadHash({
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: props.walletId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
      referenceExternalTransactionId: undefined,
    });
    return WagerTransaction.pending({
      id: props.id,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: props.walletId,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      correlationId: props.correlationId,
      at: props.at,
    });
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.updatedAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.resolutionAttempts,
      state.nextResolutionAt,
    );
  }

  private static pending(p: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string | undefined;
    gameId: string | undefined;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId: string | undefined;
    correlationId: string;
    at: Date;
  }): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.correlationId,
      p.at,
      p.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get resolutionAttempts(): number {
    return this._resolutionAttempts;
  }

  get nextResolutionAt(): Date | undefined {
    return this._nextResolutionAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal("markProcessed");
    if (this.referenceExternalTransactionId !== undefined && referenceTransactionId === undefined) {
      throw new InvariantViolationError(
        `transaction ${this.id} references another transaction but none was resolved`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextResolutionAt = undefined;
    this._updatedAt = at;
  }

  /** Primeira espera ou nova tentativa agendada: conta mais uma tentativa de resolução. */
  markPendingReference(nextResolutionAt: Date, at: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError(`transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resolutionAttempts += 1;
    this._nextResolutionAt = nextResolutionAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money): void {
    this.assertNotTerminal("reject");
    if (failureCategory(code) !== "business-rejection") {
      throw new InvariantViolationError(`${code} is not a business rejection code`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = observedBalance;
    this._nextResolutionAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    if (failureCategory(code) !== "internal") {
      throw new InvariantViolationError(`${code} is not an internal failure code`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextResolutionAt = undefined;
    this._updatedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** false somente para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento desta transação. ROLLBACK inverte a direção da transação que ele
   * desfaz, por isso precisa da reference.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError("LOSS does not move the balance");
      case WagerTransactionKind.Rollback: {
        if (!reference || reference.kind === WagerTransactionKind.Rollback) {
          throw new InvariantViolationError("ROLLBACK direction requires a non-ROLLBACK reference");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  /** Aposta sem saldo e reversão sem saldo são situações operacionais distintas (README §7.9). */
  insufficientFundsCode(): FailureCode {
    return this.isReversal()
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      balanceAfter: this._balanceAfter,
      resolutionAttempts: this._resolutionAttempts,
      nextResolutionAt: this._nextResolutionAt,
    };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }
}

function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

function assertIdentifier(field: string, value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new InvalidWagerTransactionError(
      FailureCode.InvalidPayload,
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
}
