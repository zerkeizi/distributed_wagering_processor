import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../../src/shared/messaging/inbox-message.ts";
import { OutboxMessage } from "../../../src/shared/messaging/outbox-message.ts";
import {
  LockTimeoutError,
  UniqueViolationError,
} from "../../../src/wagering/application/ports/persistence-errors.ts";
import { WagerTransactionProcessed } from "../../../src/wagering/domain/events/wager-transaction-processed.ts";
import { ReferenceResolutionPolicy } from "../../../src/wagering/domain/reference-resolution-policy.ts";
import { settle } from "../../../src/wagering/domain/settlement.ts";
import { WagerTransaction } from "../../../src/wagering/domain/wager-transaction.ts";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { Wallet } from "../../../src/wagering/domain/wallet.ts";
import { errorOf, useTestDatabase } from "../support/database.ts";
import { brl, type OpenedWallet, openWalletInDb, uuid } from "../support/factories.ts";
import { assertLedgerConsistent, ledgerConsistency } from "../support/ledger-consistency.ts";

const db = useTestDatabase();
const policy = ReferenceResolutionPolicy.default();

function wager(wallet: OpenedWallet, kind: Kind, amount: string, ref?: string): WagerTransaction {
  const ext = `ext-${uuid()}`;
  return WagerTransaction.create({
    id: uuid(),
    providerId: "provider-a",
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    referenceExternalTransactionId: ref,
    correlationId: "test",
    at: new Date(),
  });
}

/** O que o use case do passo 5 fará: lock, regras, persistir tudo na mesma transação. */
async function process(wallet: OpenedWallet, tx: WagerTransaction) {
  return db().uow.transactional(async (scope) => {
    const locked = await scope.wallets.findByIdForUpdate(wallet.walletId);
    if (!locked) throw new Error("wallet not found");
    const reference = tx.referenceExternalTransactionId
      ? await scope.transactions.findReference(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const outcome = settle({
      transaction: tx,
      wallet: locked,
      reference,
      resolutionPolicy: policy,
      ledgerEntryId: uuid(),
      at: new Date(),
    });
    scope.transactions.add(tx);
    if (outcome.status === Status.Processed && outcome.ledgerEntry) {
      scope.ledger.append(outcome.ledgerEntry);
      scope.wallets.save(locked);
    }
    return outcome;
  });
}

describe("round-trip domínio ↔ banco", () => {
  test("wallet aberta: Money, version e lançamento de abertura voltam idênticos", async () => {
    const opened = await openWalletInDb(db(), "1000.00");
    const { wallet, entry, opening } = await db().uow.read(async (scope) => ({
      wallet: await scope.wallets.findById(opened.walletId),
      entry: opened.openingTransactionId
        ? await scope.ledger.findByTransactionId(opened.openingTransactionId)
        : undefined,
      opening: opened.openingTransactionId
        ? await scope.transactions.findById(opened.openingTransactionId)
        : undefined,
    }));
    expect(wallet?.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet?.version).toBe(1);
    expect(entry?.balanceAfter.amount).toBe("1000.00");
    expect(entry?.walletVersion).toBe(1);
    expect(entry?.isBalanced()).toBe(true);
    expect(opening?.kind).toBe(Kind.Opening);
    expect(opening?.status).toBe(Status.Processed);
    expect(opening?.roundId).toBeUndefined();
  });

  test("wager transaction completa sobrevive ao round-trip sem perder campos", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    const tx = wager(opened, Kind.Bet, "25.50");
    await process(opened, tx);
    const loaded = await db().uow.read((scope) => scope.transactions.findById(tx.id));
    // Postgres guarda microssegundos e o JS milissegundos: comparar o estado inteiro é exato.
    expect(loaded?.toState()).toEqual(tx.toState());
    expect(loaded?.matchesPayload(tx.payloadHash)).toBe(true);
  });

  test("zero vira wallet sem lançamento, version 1", async () => {
    const opened = await openWalletInDb(db(), "0.00");
    const c = await ledgerConsistency(db(), opened.walletId);
    expect(c).toEqual({
      storedBalance: "0.00",
      rebuiltBalance: "0.00",
      version: 1,
      entries: 0,
      chainBreaks: 0,
    });
  });
});

describe("atomicidade (CHALLENGE §6.5, §11)", () => {
  test("erro dentro do work: wallet, transação, ledger e outbox — nada é gravado", async () => {
    const walletId = uuid();
    const playerId = uuid();
    const now = new Date();
    const opening = WagerTransaction.createOpening({
      id: uuid(),
      walletId,
      playerId,
      money: brl("50.00"),
      correlationId: "t",
      at: now,
    });
    const err = await errorOf(
      db().uow.transactional(async (scope) => {
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance: brl("50.00"),
          openingTransactionId: opening.id,
          openingEntryId: uuid(),
          at: now,
        });
        opening.markProcessed(undefined, now, wallet.balance);
        scope.wallets.add(wallet);
        scope.transactions.add(opening);
        if (openingEntry) scope.ledger.append(openingEntry);
        scope.outbox.add(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(opening, {
              eventId: uuid(),
              correlationId: "t",
              occurredAt: now,
            }),
          ),
        );
        scope.inbox.add(
          InboxMessage.receive({
            messageId: `m-${walletId}`,
            consumerName: "c",
            payloadHash: "x".repeat(64),
            receivedAt: now,
          }),
        );
        throw new Error("boom after registering everything");
      }),
    );
    expect(err.message).toBe("boom after registering everything");
    const counts = await db().sql<{ n: string }>(
      `select (select count(*) from wallet where id = ?)
            + (select count(*) from wager_transaction where wallet_id = ?)
            + (select count(*) from wallet_ledger_entry where wallet_id = ?)
            + (select count(*) from outbox_message where aggregate_id = ?)
            + (select count(*) from inbox_message where message_id = ?) as n`,
      [walletId, walletId, walletId, walletId, `m-${walletId}`],
    );
    expect(Number(counts[0]?.n)).toBe(0);
  });

  test("falha no commit (constraint) também desfaz o resto da transação", async () => {
    const existing = await openWalletInDb(db(), "0.00");
    const eventId = uuid();
    const err = await errorOf(
      db().uow.transactional(async (scope) => {
        // Wallet duplicada para o mesmo player/moeda: só explode no flush, no fim do scope.
        scope.wallets.add(
          Wallet.open({
            id: uuid(),
            playerId: existing.playerId,
            initialBalance: brl("0.00"),
            openingTransactionId: uuid(),
            openingEntryId: uuid(),
            at: new Date(),
          }).wallet,
        );
        scope.outbox.add(
          OutboxMessage.rehydrate({
            id: eventId,
            aggregateId: "x",
            eventType: "Test",
            payload: {},
            occurredAt: new Date(),
            attempts: 0,
            nextAttemptAt: new Date(),
            publishedAt: undefined,
          }),
        );
      }),
    );
    expect(err.name).toBe(UniqueViolationError.name);
    expect(err.constraint).toBe("wallet_player_currency_uq");
    expect(await db().sql("select 1 from outbox_message where id = ?", [eventId])).toHaveLength(0);
  });
});

describe("repositórios", () => {
  test("idempotency key duplicada vira UniqueViolationError com o nome da constraint", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    const first = wager(opened, Kind.Bet, "1.00");
    await process(opened, first);
    const duplicate = WagerTransaction.create({
      id: uuid(),
      providerId: first.providerId,
      externalTransactionId: `other-${uuid()}`,
      idempotencyKey: first.idempotencyKey,
      walletId: opened.walletId,
      playerId: opened.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: Kind.Bet,
      money: brl("1.00"),
      referenceExternalTransactionId: undefined,
      correlationId: "t",
      at: new Date(),
    });
    const err = await errorOf(process(opened, duplicate));
    expect(err.name).toBe("UniqueViolationError");
    expect(err.constraint).toBe("wager_transaction_idempotency_uq");
    await assertLedgerConsistent(db(), opened.walletId);
  });

  test("findByIdempotencyKey e findByExternalId encontram a mesma transação", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    const tx = wager(opened, Kind.Bet, "1.00");
    await process(opened, tx);
    const [byKey, byExt] = await db().uow.read(async (s) => [
      await s.transactions.findByIdempotencyKey(tx.providerId, tx.idempotencyKey),
      await s.transactions.findByExternalId(tx.providerId, tx.externalTransactionId),
    ]);
    expect(byKey?.id).toBe(tx.id);
    expect(byExt?.id).toBe(tx.id);
  });

  test("findReference informa se o alvo já foi revertido", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    const bet = wager(opened, Kind.Bet, "10.00");
    await process(opened, bet);
    const before = await db().uow.read((s) =>
      s.transactions.findReference(bet.providerId, bet.externalTransactionId),
    );
    expect(before?.alreadyReversed).toBe(false);

    const refund = wager(opened, Kind.Refund, "10.00", bet.externalTransactionId);
    expect((await process(opened, refund)).status).toBe(Status.Processed);
    const after = await db().uow.read((s) =>
      s.transactions.findReference(bet.providerId, bet.externalTransactionId),
    );
    expect(after?.alreadyReversed).toBe(true);

    // Com a informação vinda do banco, o segundo reversal é rejeitado pela regra de domínio.
    const rollback = wager(opened, Kind.Rollback, "10.00", bet.externalTransactionId);
    expect(await process(opened, rollback)).toEqual({
      status: Status.Rejected,
      failureCode: "REFERENCE_ALREADY_REVERSED" as never,
    });
    await assertLedgerConsistent(db(), opened.walletId);
    expect((await ledgerConsistency(db(), opened.walletId)).storedBalance).toBe("100.00");
  });

  test("extrato paginado do mais recente para o mais antigo, sem buracos nem repetições", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    for (let i = 0; i < 6; i++) await process(opened, wager(opened, Kind.Bet, "1.00"));
    const versions: number[] = [];
    let before: number | undefined;
    do {
      const page = await db().uow.read((s) =>
        s.ledger.listByWallet(opened.walletId, {
          limit: 3,
          ...(before !== undefined ? { beforeVersion: before } : {}),
        }),
      );
      versions.push(...page.entries.map((e) => e.walletVersion));
      before = page.nextBeforeVersion;
    } while (before !== undefined);
    expect(versions).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  test("findByIdForUpdate segura o lock até o commit; outra transação estoura o lock_timeout", async () => {
    const opened = await openWalletInDb(db(), "100.00");
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holder = db().uow.transactional(async (scope) => {
      await scope.wallets.findByIdForUpdate(opened.walletId);
      locked();
      await holding;
    });
    await isLocked;

    const started = performance.now();
    const err = await errorOf(
      db().uow.transactional((scope) => scope.wallets.findByIdForUpdate(opened.walletId), {
        lockTimeoutMs: 200,
      }),
    );
    const waited = performance.now() - started;
    release();
    await holder;

    expect(err.name).toBe(LockTimeoutError.name);
    expect(waited).toBeGreaterThanOrEqual(150);
  });

  test("lock é por wallet: outra wallet não espera", async () => {
    const a = await openWalletInDb(db(), "100.00");
    const b = await openWalletInDb(db(), "100.00");
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db().uow.transactional(async (scope) => {
      await scope.wallets.findByIdForUpdate(a.walletId);
      locked();
      await holding;
    });
    await isLocked;
    const other = await db().uow.transactional(
      (scope) => scope.wallets.findByIdForUpdate(b.walletId),
      { lockTimeoutMs: 200 },
    );
    release();
    await holder;
    expect(other?.id).toBe(b.walletId);
  });
});
