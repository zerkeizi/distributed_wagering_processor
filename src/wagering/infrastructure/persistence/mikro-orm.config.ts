import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migration20261118000000_initial } from "./migrations/Migration20261118000000_initial.ts";
import { ENTITY_SCHEMAS } from "./records.ts";

/** Lista explícita (sem glob): ordem determinística e nada é descoberto por acidente. */
export const MIGRATIONS = [
  { name: "Migration20261118000000_initial", class: Migration20261118000000_initial },
];

export interface OrmOptionsInput {
  readonly databaseUrl: string;
  readonly poolMax?: number;
  readonly debug?: boolean;
}

export function createOrmOptions(input: OrmOptionsInput): Options {
  return defineConfig({
    clientUrl: input.databaseUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: "schema_migrations",
      // A migration é escrita à mão (SQL com CHECKs e triggers): sem snapshot nem diff automático.
      snapshot: false,
      transactional: true,
      allOrNothing: true,
      silent: true,
    },
    pool: { min: 0, max: input.poolMax ?? 10 },
    forceUtcTimezone: true,
    // Toda operação usa um EntityManager próprio (fork): nunca o global compartilhado.
    allowGlobalContext: false,
    debug: input.debug ?? false,
  });
}
