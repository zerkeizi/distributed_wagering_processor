import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../../src/wagering/infrastructure/persistence/mikro-orm.config.ts";
import { TEST_DATABASE_URL } from "../support/database.ts";

/**
 * up → down → up num banco descartável: o teste derruba o schema inteiro, então não pode rodar no
 * banco compartilhado pelos outros testes.
 */
const databaseName = `wagering_migrations_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const url = new URL(TEST_DATABASE_URL);
url.pathname = `/${databaseName}`;

let orm: MikroORM;

async function tables(): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .getConnection()
    .execute<{ table_name: string }[]>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
  return rows.map((r) => r.table_name);
}

const DOMAIN_TABLES = [
  "inbox_message",
  "outbox_message",
  "wager_transaction",
  "wallet",
  "wallet_ledger_entry",
];

beforeAll(async () => {
  // ensureDatabase (default do MikroORM) cria o banco se ele não existir.
  orm = await MikroORM.init(createOrmOptions({ databaseUrl: url.toString(), poolMax: 2 }));
});

afterAll(async () => {
  await orm.close();
  const admin = await MikroORM.init(
    createOrmOptions({ databaseUrl: TEST_DATABASE_URL, poolMax: 1 }),
  );
  await admin.em.fork().getConnection().execute(`drop database if exists "${databaseName}"`);
  await admin.close();
});

describe("migrations", () => {
  test("up cria todas as tabelas e registra a migration", async () => {
    const applied = await orm.migrator.up();
    expect(applied.map((m) => m.name)).toEqual(["Migration20261118000000_initial"]);
    expect(await tables()).toEqual(expect.arrayContaining(DOMAIN_TABLES));
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });

  test("up é idempotente", async () => {
    expect(await orm.migrator.up()).toHaveLength(0);
  });

  test("down reverte tudo (tabelas e funções)", async () => {
    const reverted = await orm.migrator.down();
    expect(reverted).toHaveLength(1);
    const remaining = await tables();
    for (const table of DOMAIN_TABLES) expect(remaining).not.toContain(table);
    const functions = await orm.em
      .fork()
      .getConnection()
      .execute<{ proname: string }[]>(
        "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
      );
    expect(functions).toHaveLength(0);
  });

  test("up de novo depois do down recria o schema", async () => {
    await orm.migrator.up();
    expect(await tables()).toEqual(expect.arrayContaining(DOMAIN_TABLES));
  });
});
