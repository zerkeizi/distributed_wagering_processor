/**
 * "Hello world" de cada parte do sistema, rodando contra o ambiente do docker compose.
 * Uso: bun run smoke <parte>   (ex.: bun run smoke infra)
 * Cada passo da implementação acrescenta uma parte aqui.
 */
import { smokeDomain } from "./domain.ts";
import { smokeInfra } from "./infra.ts";

const parts: Record<string, () => Promise<void>> = {
  infra: smokeInfra,
  domain: smokeDomain,
};

const name = process.argv[2] ?? "infra";
const run = parts[name];
if (!run) {
  console.error(`Parte desconhecida "${name}". Disponíveis: ${Object.keys(parts).join(", ")}`);
  process.exit(1);
}
await run();
