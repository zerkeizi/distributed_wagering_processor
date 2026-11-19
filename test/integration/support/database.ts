import { afterAll, beforeAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../../src/wagering/infrastructure/persistence/mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "../../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work.ts";
import { assertWalletsConsistentSince } from "./ledger-consistency.ts";

/**
 * Testes de integração rodam contra o Postgres real do docker compose, num banco próprio
 * (`wagering_test`, criado e migrado automaticamente). Não há truncate entre testes: cada teste cria
 * suas wallets com ids aleatórios, então os testes não se enxergam e podem rodar em qualquer ordem.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

export interface TestDatabase {
  readonly orm: MikroORM;
  readonly uow: MikroOrmUnitOfWork;
  /** SQL cru fora de transação explícita (autocommit). */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Várias instruções numa única transação; erros de constraints adiadas aparecem no commit. */
  inTransaction(statements: (sql: TestDatabase["sql"]) => Promise<void>): Promise<void>;
}

export async function openTestDatabase(url = TEST_DATABASE_URL): Promise<TestDatabase> {
  const orm = await MikroORM.init(createOrmOptions({ databaseUrl: url, poolMax: 20 }));
  await orm.migrator.up();
  const sql: TestDatabase["sql"] = async (query, params = []) =>
    (await orm.em.fork().getConnection().execute(query, params)) as never;
  return {
    orm,
    uow: new MikroOrmUnitOfWork(orm),
    sql,
    async inTransaction(statements) {
      await orm.em.fork().transactional(async (em) => {
        await statements(async (query, params = []) => (await em.execute(query, params)) as never);
      });
    },
  };
}

/**
 * Banco novo e vazio (criado e migrado na hora), para suítes que não podem enxergar o que outras
 * deixaram no banco compartilhado — por exemplo, a outbox, onde eventos pendentes de outras suítes
 * entrariam na disputa do publisher.
 */
export async function openFreshDatabase(
  label: string,
): Promise<TestDatabase & { url: string; drop(): Promise<void> }> {
  const name = `wagering_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = await openTestDatabase(url.toString());
  return {
    ...db,
    url: url.toString(),
    async drop() {
      await db.orm.close();
      const admin = await MikroORM.init(
        createOrmOptions({ databaseUrl: TEST_DATABASE_URL, poolMax: 1 }),
      );
      await admin.em
        .fork()
        .getConnection()
        .execute(`drop database if exists "${name}" with (force)`);
      await admin.close();
    },
  };
}

/**
 * Abre o banco antes dos testes do arquivo e fecha no fim — depois de verificar a invariante de
 * saldo × ledger em todas as wallets criadas pela suíte (CHALLENGE §13).
 */
export function useTestDatabase(): () => TestDatabase {
  let db: TestDatabase | undefined;
  let startedAt = new Date();
  beforeAll(async () => {
    startedAt = new Date();
    db = await openTestDatabase();
  });
  afterAll(async () => {
    try {
      if (db) await assertWalletsConsistentSince(db, startedAt);
    } finally {
      await db?.orm.close();
    }
  });
  return () => {
    if (!db) throw new Error("test database not initialized (call inside a test)");
    return db;
  };
}

/** Captura o erro de uma promise para inspecionar código/constraint. */
export interface CapturedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | undefined;
  readonly constraint?: string | undefined;
}

export async function errorOf(promise: Promise<unknown>): Promise<CapturedError> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message: string; name: string };
    const cause = (error as { cause?: { constraint?: string; code?: string } }).cause;
    return {
      name: e.name,
      message: e.message,
      ...((e.code ?? cause?.code) ? { code: e.code ?? cause?.code } : {}),
      ...((e.constraint ?? cause?.constraint)
        ? { constraint: e.constraint ?? cause?.constraint }
        : {}),
    };
  }
  throw new Error("expected promise to reject");
}
