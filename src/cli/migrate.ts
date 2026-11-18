/**
 * Migrations versionadas e reversíveis (CHALLENGE §4).
 *   bun src/cli/migrate.ts up       aplica as pendentes
 *   bun src/cli/migrate.ts down     desfaz a última aplicada
 *   bun src/cli/migrate.ts status   lista aplicadas e pendentes
 * Usa DATABASE_URL (o .env é carregado automaticamente pelo Bun).
 */
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../wagering/infrastructure/persistence/mikro-orm.config.ts";

const command = process.argv[2] ?? "status";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const orm = await MikroORM.init(createOrmOptions({ databaseUrl, poolMax: 1 }));
try {
  const migrator = orm.migrator;
  switch (command) {
    case "up": {
      const applied = await migrator.up();
      console.log(
        applied.length ? `applied: ${applied.map((m) => m.name).join(", ")}` : "up to date",
      );
      break;
    }
    case "down": {
      const reverted = await migrator.down();
      console.log(
        reverted.length
          ? `reverted: ${reverted.map((m) => m.name).join(", ")}`
          : "nothing to revert",
      );
      break;
    }
    case "status": {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      for (const m of executed) console.log(`[x] ${m.name}`);
      for (const m of pending) console.log(`[ ] ${m.name}`);
      break;
    }
    default:
      console.error(`unknown command "${command}" (expected up | down | status)`);
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}
