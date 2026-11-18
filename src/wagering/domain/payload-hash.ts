import type { MoneyProps } from "../../shared/domain/money.ts";
import type { WagerTransactionKind } from "./wager-transaction-kind.ts";

/**
 * Subconjunto de negócio de uma wager transaction que entra no `payloadHash` (ADR 0008).
 * Header `Idempotency-Key`, `messageId`, `occurredAt` e demais metadados de transporte ficam de fora.
 */
export interface WagerPayloadFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  /** Sempre normalizado por `Money.toJSON()`, para que o hash não dependa da formatação recebida. */
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | undefined;
}

/**
 * JSON canônico: chaves de objeto ordenadas recursivamente por code point, sem espaços, chaves com
 * valor `undefined` omitidas. Só aceita tipos JSON com representação única.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** SHA-256 em hexadecimal minúsculo do JSON canônico dos campos de negócio. */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
