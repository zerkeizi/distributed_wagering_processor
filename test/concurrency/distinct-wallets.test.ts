import { describe, expect, test } from "bun:test";
import { useTestApp } from "../integration/support/http-app.ts";
import { assertLedgerConsistent } from "../integration/support/ledger-consistency.ts";
import { balanceOf, createWallet, submitWager } from "../integration/support/wagering-client.ts";

const app = useTestApp({ WALLET_LOCK_TIMEOUT_MS: "15000" });

describe("concorrência entre wallets distintas (CHALLENGE §13, cenário 3)", () => {
  test("20 wallets × 10 BETs, todas ao mesmo tempo: cada wallet termina exata e consistente", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(app(), "100.00")),
    );
    const responses = await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 10 }, () => submitWager(app(), w, { kind: "BET", amount: "1.50" })),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const w of wallets) {
      expect(await balanceOf(app(), w.walletId)).toBe("85.00");
      await assertLedgerConsistent(app().db, w.walletId);
    }
  });

  test("lock é por wallet: uma hot wallet ocupada não atrasa as outras", async () => {
    const hot = await createWallet(app(), "1000.00");
    const cold = await createWallet(app(), "1000.00");
    // Prende o lock da hot wallet numa transação longa, direto no banco.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = app().db.inTransaction(async (exec) => {
      await exec("select id from wallet where id = ? for update", [hot.walletId]);
      locked();
      await held;
    });
    await isLocked;

    const started = performance.now();
    const coldBet = await submitWager(app(), cold, { kind: "BET", amount: "1.00" });
    const coldMs = performance.now() - started;
    const hotBet = submitWager(app(), hot, { kind: "BET", amount: "1.00" });
    await Bun.sleep(300);
    release();
    await holder;
    expect(coldBet.status).toBe(201);
    expect(coldMs).toBeLessThan(1000);
    expect((await hotBet).status).toBe(201); // esperou o lock e seguiu
  });
});
