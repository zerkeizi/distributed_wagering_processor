/**
 * Roda uma rodada completa só no domínio (sem banco, sem HTTP), mostrando como cada operação
 * mexe — ou não — no saldo e no ledger. As "buscas" são um Map em memória só para a demonstração:
 * no sistema real, idempotência e referências vêm do Postgres.
 */
import { Money } from "../../src/shared/domain/money.ts";
import { ReferenceResolutionPolicy } from "../../src/wagering/domain/reference-resolution-policy.ts";
import { settle } from "../../src/wagering/domain/settlement.ts";
import { WagerTransaction } from "../../src/wagering/domain/wager-transaction.ts";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/wagering/domain/wager-transaction-kind.ts";
import { Wallet } from "../../src/wagering/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../src/wagering/domain/wallet-ledger-entry.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = () => new Date();
const id = () => Bun.randomUUIDv7();

const playerId = id();
const walletId = id();
const openingTx = WagerTransaction.createOpening({
  id: id(),
  walletId,
  playerId,
  money: brl("100.00"),
  correlationId: "smoke",
  at: now(),
});
const { wallet, openingEntry } = Wallet.open({
  id: walletId,
  playerId,
  initialBalance: brl("100.00"),
  openingTransactionId: openingTx.id,
  openingEntryId: id(),
  at: now(),
});
openingTx.markProcessed(undefined, now(), wallet.balance);

const ledger: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
const byExternalId = new Map<string, WagerTransaction>();
const reversedTargets = new Set<string>();
const policy = ReferenceResolutionPolicy.default();

const rows: Record<string, string | number>[] = [
  {
    op: "OPENING",
    ext: "-",
    ref: "-",
    valor: "100.00",
    status: openingTx.status,
    falha: "",
    saldo: wallet.balance.amount,
    versão: wallet.version,
    ledger: "CREDIT",
  },
];

function submit(kind: Kind, ext: string, amount: string, ref?: string): WagerTransaction {
  const tx =
    byExternalId.get(ext) ??
    WagerTransaction.create({
      id: id(),
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      walletId,
      playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind,
      money: brl(amount),
      referenceExternalTransactionId: ref,
      correlationId: "smoke",
      at: now(),
    });
  const reference = ref ? byExternalId.get(ref) : undefined;
  const outcome = settle({
    transaction: tx,
    wallet,
    reference: reference
      ? { transaction: reference, alreadyReversed: reversedTargets.has(reference.id) }
      : undefined,
    resolutionPolicy: policy,
    ledgerEntryId: id(),
    at: now(),
  });
  byExternalId.set(ext, tx);
  let entry = "";
  if (outcome.status === Status.Processed && outcome.ledgerEntry) {
    ledger.push(outcome.ledgerEntry);
    entry = outcome.ledgerEntry.direction;
  }
  if (outcome.status === Status.Processed && tx.isReversal() && tx.referenceTransactionId) {
    reversedTargets.add(tx.referenceTransactionId);
  }
  rows.push({
    op: kind,
    ext,
    ref: ref ?? "-",
    valor: amount,
    status: tx.status,
    falha: tx.failureCode ?? "",
    saldo: wallet.balance.amount,
    versão: wallet.version,
    ledger: entry || "—",
  });
  return tx;
}

export async function smokeDomain(): Promise<void> {
  submit(Kind.Bet, "bet-1", "30.00");
  submit(Kind.Win, "win-1", "50.00", "bet-1");
  submit(Kind.Rollback, "rb-win-1", "50.00", "win-1");
  submit(Kind.Loss, "loss-1", "0.00", "bet-1");
  submit(Kind.Refund, "refund-1", "30.00", "bet-1");
  submit(Kind.Refund, "refund-2", "30.00", "bet-1"); // segunda reversão da mesma BET
  submit(Kind.Bet, "bet-2", "200.00"); // sem saldo
  submit(Kind.Rollback, "rb-bet-3", "15.00", "bet-3"); // chega antes da BET
  submit(Kind.Bet, "bet-3", "15.00");
  submit(Kind.Rollback, "rb-bet-3", "15.00", "bet-3"); // worker tenta de novo: agora resolve

  console.log("Rodada no domínio (wallet aberta com 100.00 BRL):\n");
  console.table(rows);

  console.log("\nLedger (só operações que mudaram o saldo):\n");
  console.table(
    ledger.map((e) => ({
      versão: e.walletVersion,
      direção: e.direction,
      valor: e.money.amount,
      antes: e.balanceBefore.amount,
      depois: e.balanceAfter.amount,
    })),
  );

  const rebuilt = ledger.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
  const ok = rebuilt.equals(wallet.balance);
  console.log(
    `\nInvariante: saldo ${wallet.balance} == ledger ${rebuilt} → ${ok ? "OK ✅" : "DIVERGENTE ❌"}`,
  );
  if (!ok) process.exit(1);
}
