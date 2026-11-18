/**
 * Mostra o banco como guardião das invariantes: grava uma wallet com abertura e uma BET pelos
 * repositórios (mesma transação SQL para tudo), lê de volta, e depois tenta sabotar o schema com SQL
 * cru — passando por cima da aplicação — para ver o Postgres recusar.
 * Requer: compose rodando (bun run infra:up). Usa DATABASE_URL ou o banco do compose.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/shared/domain/money.ts";
import { ReferenceResolutionPolicy } from "../../src/wagering/domain/reference-resolution-policy.ts";
import { settle } from "../../src/wagering/domain/settlement.ts";
import { WagerTransaction } from "../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction-kind.ts";
import { Wallet } from "../../src/wagering/domain/wallet.ts";
import { createOrmOptions } from "../../src/wagering/infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering";
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const id = () => Bun.randomUUIDv7();

export async function smokeDb(): Promise<void> {
  const orm = await MikroORM.init(createOrmOptions({ databaseUrl: DATABASE_URL, poolMax: 2 }));
  const uow = new MikroOrmUnitOfWork(orm);
  const sql = (q: string, p: unknown[] = []) => orm.em.fork().getConnection().execute(q, p);

  try {
    const walletId = id();
    const playerId = id();
    const now = new Date();

    // 1) Abertura: wallet + OPENING + lançamento numa única transação.
    await uow.transactional(async (scope) => {
      const opening = WagerTransaction.createOpening({
        id: id(),
        walletId,
        playerId,
        money: brl("100.00"),
        correlationId: "smoke",
        at: now,
      });
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl("100.00"),
        openingTransactionId: opening.id,
        openingEntryId: id(),
        at: now,
      });
      opening.markProcessed(undefined, now, wallet.balance);
      scope.wallets.add(wallet);
      scope.transactions.add(opening);
      if (openingEntry) scope.ledger.append(openingEntry);
    });

    // 2) BET de 30.00: lock na wallet, regras do domínio, grava transação + lançamento + saldo.
    const bet = WagerTransaction.create({
      id: id(),
      providerId: "provider-a",
      externalTransactionId: `bet-${walletId}`,
      idempotencyKey: `provider-a:bet-${walletId}`,
      walletId,
      playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: brl("30.00"),
      referenceExternalTransactionId: undefined,
      correlationId: "smoke",
      at: new Date(),
    });
    await uow.transactional(
      async (scope) => {
        const wallet = await scope.wallets.findByIdForUpdate(walletId);
        if (!wallet) throw new Error("wallet not found");
        const outcome = settle({
          transaction: bet,
          wallet,
          reference: undefined,
          resolutionPolicy: ReferenceResolutionPolicy.default(),
          ledgerEntryId: id(),
          at: new Date(),
        });
        scope.transactions.add(bet);
        if (outcome.status === "PROCESSED" && outcome.ledgerEntry) {
          scope.ledger.append(outcome.ledgerEntry);
          scope.wallets.save(wallet);
        }
      },
      { lockTimeoutMs: 2000 },
    );

    console.log(`Wallet ${walletId}\n`);
    console.log("wallet:");
    console.table(await sql("select balance::text, version from wallet where id = ?", [walletId]));
    console.log("wager_transaction:");
    console.table(
      await sql(
        "select kind, provider_id, amount::text, status, balance_after::text from wager_transaction where wallet_id = ? order by created_at",
        [walletId],
      ),
    );
    console.log("wallet_ledger_entry:");
    console.table(
      await sql(
        "select wallet_version as v, direction, amount::text, balance_before::text as antes, balance_after::text as depois from wallet_ledger_entry where wallet_id = ? order by wallet_version",
        [walletId],
      ),
    );

    // 3) Sabotagem com SQL cru: cada tentativa roda na própria transação e deve ser recusada.
    const attacks: [string, string, unknown[]][] = [
      [
        "reescrever um lançamento",
        "update wallet_ledger_entry set amount = 1.00 where wallet_id = ?",
        [walletId],
      ],
      ["apagar o ledger", "delete from wallet_ledger_entry where wallet_id = ?", [walletId]],
      ["deixar o saldo negativo", "update wallet set balance = -1.00 where id = ?", [walletId]],
      [
        "inventar saldo sem lançamento",
        "update wallet set balance = 1000000.00, version = 3 where id = ?",
        [walletId],
      ],
      [
        "mudar o valor de uma aposta já processada",
        "update wager_transaction set amount = 1.00 where id = ?",
        [bet.id],
      ],
      ["apagar uma transação", "delete from wager_transaction where id = ?", [bet.id]],
      [
        "persistir status PENDING",
        "update wager_transaction set status = 'PENDING' where id = ?",
        [bet.id],
      ],
    ];
    console.log("Tentativas de sabotagem (SQL direto no banco):\n");
    for (const [label, query, params] of attacks) {
      try {
        await orm.em.fork().transactional((em) => em.execute(query, params));
        console.log(`  ❌ ${label}: ACEITO (não deveria!)`);
      } catch (error) {
        const e = error as { constraint?: string; message: string };
        const reason = e.constraint ?? e.message.split("\n")[0]?.replace(/^.* - /, "");
        console.log(`  ✅ ${label}: recusado → ${reason}`);
      }
    }

    // 4) Invariante final.
    const [check] = (await sql(
      `select w.balance::text as stored,
              (select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text
                 from wallet_ledger_entry where wallet_id = w.id) as rebuilt
         from wallet w where w.id = ?`,
      [walletId],
    )) as { stored: string; rebuilt: string }[];
    const ok = check?.stored === check?.rebuilt;
    console.log(
      `\nInvariante: saldo ${check?.stored} == ledger ${check?.rebuilt} → ${ok ? "OK ✅" : "DIVERGENTE ❌"}`,
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await orm.close();
  }
}
