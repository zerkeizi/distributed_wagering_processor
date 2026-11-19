import { describe, expect, test } from "bun:test";
import { useTestApp } from "../integration/support/http-app.ts";
import {
  assertLedgerConsistent,
  ledgerConsistency,
} from "../integration/support/ledger-consistency.ts";
import { createWallet, submitWager } from "../integration/support/wagering-client.ts";

/**
 * Hot wallet com os valores PADRÃO de produção (CHALLENGE §8 "wallets diferentes processadas em
 * paralelo"; §14 "hot wallet"). Sem overrides de timeout: é a configuração que roda no compose.
 *
 * O problema que este teste pega: se cada requisição de uma wallet quente segurasse uma conexão do
 * pool enquanto espera o lock, uma única wallet esgotaria o pool da instância e as OUTRAS wallets
 * passariam a levar segundos e a falhar com 503.
 */
const app = useTestApp();

describe("isolamento entre wallets sob uma hot wallet", () => {
  test("rajada de 200 apostas numa wallet não atrasa nem derruba as outras", async () => {
    const hot = await createWallet(app(), "1000000.00");
    const cold = await Promise.all(Array.from({ length: 5 }, () => createWallet(app(), "100.00")));

    const burst = Promise.all(
      Array.from({ length: 200 }, () => submitWager(app(), hot, { kind: "BET", amount: "1.00" })),
    );
    await Bun.sleep(100); // a rajada já está disputando a wallet quente
    const coldResults = await Promise.all(
      cold.map(async (w) => {
        const started = performance.now();
        const res = await submitWager(app(), w, { kind: "BET", amount: "1.00" });
        return { status: res.status, ms: performance.now() - started };
      }),
    );
    const hotResults = await burst;

    // As wallets frias não esperam pela quente.
    for (const r of coldResults) {
      expect(r.status).toBe(201);
      expect(r.ms).toBeLessThan(1_000);
    }
    // Na quente, só dois desfechos possíveis: aplicada, ou "wallet ocupada" (nunca "banco fora").
    const outcomes = new Set(
      hotResults.map((r) => (r.status === 201 ? "201" : `${r.status} ${r.body.error?.code}`)),
    );
    for (const o of outcomes) expect(["201", "503 LOCK_TIMEOUT"]).toContain(o);

    const applied = hotResults.filter((r) => r.status === 201).length;
    const c = await ledgerConsistency(app().db, hot.walletId);
    expect(c.entries).toBe(applied + 1); // + abertura
    await assertLedgerConsistent(app().db, hot.walletId);
  }, 60_000);
});
