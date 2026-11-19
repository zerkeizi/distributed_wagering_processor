/**
 * "Hello world" de cada parte do sistema, rodando contra o ambiente do docker compose.
 * Uso: bun run smoke <parte>   (ex.: bun run smoke infra)
 * Cada passo da implementação acrescenta uma parte aqui.
 */
import { smokeDb } from "./db.ts";
import { smokeDomain } from "./domain.ts";
import { smokeEvents } from "./events.ts";
import { smokeInfra } from "./infra.ts";
import { smokeRace } from "./race.ts";
import { smokeSqs } from "./sqs.ts";

const parts: Record<string, () => Promise<void>> = {
  infra: smokeInfra,
  domain: smokeDomain,
  db: smokeDb,
  race: smokeRace,
  sqs: smokeSqs,
  events: smokeEvents,
};

const name = process.argv[2] ?? "infra";
const run = parts[name];
if (!run) {
  console.error(`Parte desconhecida "${name}". Disponíveis: ${Object.keys(parts).join(", ")}`);
  process.exit(1);
}
await run();
