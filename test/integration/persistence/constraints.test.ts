import { describe, expect, test } from "bun:test";
import { errorOf, type TestDatabase, useTestDatabase } from "../support/database.ts";
import { openWalletInDb, uuid } from "../support/factories.ts";
import { assertLedgerConsistent } from "../support/ledger-consistency.ts";

/**
 * As garantias do CHALLENGE §5.9 aplicadas pelo próprio banco: cada teste tenta violar uma delas com
 * SQL cru — passando por cima de todo o código de aplicação — e espera o Postgres recusar.
 */
const db = useTestDatabase();

type Row = Record<string, string | number | null>;

function insertSql(table: string, row: Row): { sql: string; params: unknown[] } {
  const columns = Object.keys(row);
  return {
    sql: `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    params: Object.values(row),
  };
}

/** Uma BET PROCESSED válida na wallet dada; cada teste sobrescreve o que quer violar. */
function betRow(wallet: { walletId: string; playerId: string }, overrides: Row = {}): Row {
  const ext = `ext-${uuid()}`;
  return {
    id: uuid(),
    provider_id: "provider-a",
    external_transaction_id: ext,
    idempotency_key: `provider-a:${ext}`,
    payload_hash: "a".repeat(64),
    wallet_id: wallet.walletId,
    player_id: wallet.playerId,
    currency: "BRL",
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PROCESSED",
    failure_code: null,
    balance_after: "90.00",
    processed_at: new Date().toISOString(),
    resolution_attempts: 0,
    next_resolution_at: null,
    correlation_id: "test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function insert(table: string, row: Row): Promise<void> {
  const { sql, params } = insertSql(table, row);
  await db().inTransaction(async (exec) => {
    await exec(sql, params);
  });
}

/** BET processada + lançamento + wallet atualizada, como o use case fará: base para outros testes. */
async function walletWithProcessedBet(database: TestDatabase) {
  const wallet = await openWalletInDb(database, "100.00");
  const bet = betRow(wallet);
  await database.inTransaction(async (exec) => {
    const tx = insertSql("wager_transaction", bet);
    await exec(tx.sql, tx.params);
    const entry = insertSql("wallet_ledger_entry", {
      id: uuid(),
      wallet_id: wallet.walletId,
      transaction_id: bet.id as string,
      currency: "BRL",
      direction: "DEBIT",
      amount: "10.00",
      balance_before: "100.00",
      balance_after: "90.00",
      wallet_version: 2,
      created_at: new Date().toISOString(),
    });
    await exec(entry.sql, entry.params);
    await exec("update wallet set balance = 90.00, version = 2 where id = ?", [wallet.walletId]);
  });
  return { wallet, bet };
}

describe("wallet", () => {
  test("no máximo uma wallet por player + moeda", async () => {
    const wallet = await openWalletInDb(db(), "0.00");
    const err = await errorOf(
      insert("wallet", {
        id: uuid(),
        player_id: wallet.playerId,
        currency: "BRL",
        balance: "0.00",
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );
    expect(err.constraint).toBe("wallet_player_currency_uq");
  });

  test("mesmo player pode ter wallets em moedas diferentes", async () => {
    const wallet = await openWalletInDb(db(), "0.00");
    await insert("wallet", {
      id: uuid(),
      player_id: wallet.playerId,
      currency: "USD",
      balance: "0.00",
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  test("saldo negativo é recusado", async () => {
    const wallet = await openWalletInDb(db(), "10.00");
    const err = await errorOf(
      db().sql("update wallet set balance = -0.01 where id = ?", [wallet.walletId]),
    );
    expect(err.constraint).toBe("wallet_balance_non_negative_ck");
  });

  test("alterar saldo sem lançamento correspondente falha no commit", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      db().sql("update wallet set balance = 1000.00, version = 2 where id = ?", [wallet.walletId]),
    );
    expect(err.constraint).toBe("wallet_matches_ledger_ck");
    await assertLedgerConsistent(db(), wallet.walletId);
  });

  test("wallet com saldo inicial > 0 sem lançamento de abertura é recusada", async () => {
    const err = await errorOf(
      insert("wallet", {
        id: uuid(),
        player_id: uuid(),
        currency: "BRL",
        balance: "50.00",
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );
    expect(err.constraint).toBe("wallet_matches_ledger_ck");
  });
});

describe("wallet_ledger_entry", () => {
  test("UPDATE é bloqueado (append-only)", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      db().sql("update wallet_ledger_entry set amount = 1.00 where wallet_id = ?", [
        wallet.walletId,
      ]),
    );
    expect(err.message).toContain("append-only");
  });

  test("DELETE é bloqueado", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      db().sql("delete from wallet_ledger_entry where wallet_id = ?", [wallet.walletId]),
    );
    expect(err.message).toContain("append-only");
  });

  test("TRUNCATE é bloqueado", async () => {
    const err = await errorOf(db().sql("truncate wallet_ledger_entry cascade"));
    expect(err.message).toContain("append-only");
  });

  test("aritmética errada (antes − valor ≠ depois) é recusada", async () => {
    const { wallet } = await walletWithProcessedBet(db());
    const bet = betRow(wallet, { balance_after: "85.00", amount: "5.00" });
    const err = await errorOf(
      db().inTransaction(async (exec) => {
        const tx = insertSql("wager_transaction", bet);
        await exec(tx.sql, tx.params);
        const entry = insertSql("wallet_ledger_entry", {
          id: uuid(),
          wallet_id: wallet.walletId,
          transaction_id: bet.id as string,
          currency: "BRL",
          direction: "DEBIT",
          amount: "5.00",
          balance_before: "90.00",
          balance_after: "86.00",
          wallet_version: 3,
          created_at: new Date().toISOString(),
        });
        await exec(entry.sql, entry.params);
      }),
    );
    expect(err.constraint).toBe("wallet_ledger_entry_arithmetic_ck");
  });

  test("lançamento que não continua do anterior é recusado", async () => {
    const { wallet } = await walletWithProcessedBet(db());
    const bet = betRow(wallet);
    const err = await errorOf(
      db().inTransaction(async (exec) => {
        const tx = insertSql("wager_transaction", bet);
        await exec(tx.sql, tx.params);
        const entry = insertSql("wallet_ledger_entry", {
          id: uuid(),
          wallet_id: wallet.walletId,
          transaction_id: bet.id as string,
          currency: "BRL",
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "100.00", // o anterior terminou em 90.00
          balance_after: "90.00",
          wallet_version: 3,
          created_at: new Date().toISOString(),
        });
        await exec(entry.sql, entry.params);
      }),
    );
    expect(err.constraint).toBe("wallet_ledger_entry_chain_ck");
  });

  test("dois lançamentos para a mesma transação são recusados", async () => {
    const { wallet, bet } = await walletWithProcessedBet(db());
    const err = await errorOf(
      insert("wallet_ledger_entry", {
        id: uuid(),
        wallet_id: wallet.walletId,
        transaction_id: bet.id as string,
        currency: "BRL",
        direction: "DEBIT",
        amount: "10.00",
        balance_before: "90.00",
        balance_after: "80.00",
        wallet_version: 3,
        created_at: new Date().toISOString(),
      }),
    );
    expect(err.constraint).toBe("wallet_ledger_entry_transaction_uq");
  });

  test("lançamento em moeda diferente da wallet é recusado", async () => {
    const wallet = await openWalletInDb(db(), "0.00");
    const bet = betRow(wallet, { kind: "WIN", balance_after: "10.00" });
    const err = await errorOf(
      db().inTransaction(async (exec) => {
        const tx = insertSql("wager_transaction", bet);
        await exec(tx.sql, tx.params);
        const entry = insertSql("wallet_ledger_entry", {
          id: uuid(),
          wallet_id: wallet.walletId,
          transaction_id: bet.id as string,
          currency: "USD",
          direction: "CREDIT",
          amount: "10.00",
          balance_before: "0.00",
          balance_after: "10.00",
          wallet_version: 2,
          created_at: new Date().toISOString(),
        });
        await exec(entry.sql, entry.params);
        await exec("update wallet set balance = 10.00, version = 2 where id = ?", [
          wallet.walletId,
        ]);
      }),
    );
    expect(err.constraint).toBe("wallet_ledger_entry_wallet_fk");
  });
});

describe("saldo ↔ ledger nas duas direções (CHALLENGE §6.2, §5.9)", () => {
  test("lançamento sem a alteração de saldo correspondente é recusado no commit (o 'vice-versa')", async () => {
    const { wallet } = await walletWithProcessedBet(db()); // 90.00, v2
    const bet = betRow(wallet, { balance_after: "80.00" });
    const err = await errorOf(
      db().inTransaction(async (exec) => {
        const tx = insertSql("wager_transaction", bet);
        await exec(tx.sql, tx.params);
        const entry = insertSql("wallet_ledger_entry", {
          id: uuid(),
          wallet_id: wallet.walletId,
          transaction_id: bet.id as string,
          currency: "BRL",
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "90.00",
          balance_after: "80.00",
          wallet_version: 3,
          created_at: new Date().toISOString(),
        });
        await exec(entry.sql, entry.params);
        // Esquece de atualizar a wallet: o extrato diria 80.00 e o saldo, 90.00.
      }),
    );
    expect(err.constraint).toBe("ledger_matches_wallet_ck");
    await assertLedgerConsistent(db(), wallet.walletId);
  });
});

describe("lost update sem o lock da aplicação (CHALLENGE §5.7)", () => {
  /**
   * Dois escritores leem o mesmo saldo (100.00, v1) sem FOR UPDATE — exatamente o que a §5.7 proíbe.
   * O primeiro grava; o segundo, com o valor velho, tem que ser barrado pelo banco sozinho.
   */
  async function debit(
    wallet: { walletId: string; playerId: string },
    read: { balance: string; version: number },
    amount: string,
    claimedVersion = read.version + 1,
  ) {
    const after = (Number(read.balance) - Number(amount)).toFixed(2); // aritmética do teste, não do sistema
    const bet = betRow(wallet, { amount, balance_after: after });
    await db().inTransaction(async (exec) => {
      const tx = insertSql("wager_transaction", bet);
      await exec(tx.sql, tx.params);
      const entry = insertSql("wallet_ledger_entry", {
        id: uuid(),
        wallet_id: wallet.walletId,
        transaction_id: bet.id as string,
        currency: "BRL",
        direction: "DEBIT",
        amount,
        balance_before: read.balance,
        balance_after: after,
        wallet_version: claimedVersion,
        created_at: new Date().toISOString(),
      });
      await exec(entry.sql, entry.params);
      await exec("update wallet set balance = ?, version = ? where id = ?", [
        after,
        claimedVersion,
        wallet.walletId,
      ]);
    });
  }

  test("o segundo escritor, com o saldo velho, é recusado — mesmo trapaceando a versão", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const staleRead = { balance: "100.00", version: 1 }; // os dois leram isto

    await debit(wallet, staleRead, "30.00"); // escritor 1: 100 → 70, v2

    const sameVersion = await errorOf(debit(wallet, staleRead, "50.00"));
    expect(sameVersion.constraint).toBe("wallet_ledger_entry_version_uq");

    const skippedVersion = await errorOf(debit(wallet, staleRead, "50.00", 3));
    expect(skippedVersion.constraint).toBe("wallet_ledger_entry_chain_ck");

    const [row] = await db().sql<{ balance: string; version: number }>(
      "select balance::text, version from wallet where id = ?",
      [wallet.walletId],
    );
    expect(row).toEqual({ balance: "70.00", version: 2 }); // o débito do escritor 1 não se perdeu
    await assertLedgerConsistent(db(), wallet.walletId);
  });
});

describe("wager_transaction", () => {
  test("mesma idempotency key no mesmo provider é recusada", async () => {
    const { wallet, bet } = await walletWithProcessedBet(db());
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
          idempotency_key: bet.idempotency_key as string,
        }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_idempotency_uq");
  });

  test("mesmo external id no mesmo provider é recusado, mesmo com outra key", async () => {
    const { wallet, bet } = await walletWithProcessedBet(db());
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
          external_transaction_id: bet.external_transaction_id as string,
        }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_external_id_uq");
  });

  test("o mesmo external id em outro provider é permitido", async () => {
    const { wallet, bet } = await walletWithProcessedBet(db());
    await insert(
      "wager_transaction",
      betRow(wallet, {
        provider_id: "provider-b",
        status: "REJECTED",
        failure_code: "INSUFFICIENT_FUNDS",
        processed_at: null,
        external_transaction_id: bet.external_transaction_id as string,
      }),
    );
  });

  test("status PENDING nunca é persistido (ADR 0004)", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, { status: "PENDING", processed_at: null, balance_after: null }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_status_ck");
  });

  test("player ou moeda diferentes da wallet são recusados", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const wrongPlayer = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          player_id: uuid(),
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
        }),
      ),
    );
    expect(wrongPlayer.constraint).toBe("wager_transaction_wallet_fk");
    const wrongCurrency = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          currency: "USD",
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
        }),
      ),
    );
    expect(wrongCurrency.constraint).toBe("wager_transaction_wallet_fk");
  });

  test("OPENING só no provider reservado; provider externo não pode usar OPENING", async () => {
    const wallet = await openWalletInDb(db(), "0.00");
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          kind: "OPENING",
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
        }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_opening_provider_ck");
  });

  test("REFUND sem referência é recusado", async () => {
    const wallet = await openWalletInDb(db(), "0.00");
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          kind: "REFUND",
          status: "REJECTED",
          failure_code: "REFERENCE_NOT_FOUND",
          processed_at: null,
        }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_reference_required_ck");
  });

  test("valor zero só é aceito em LOSS", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      insert(
        "wager_transaction",
        betRow(wallet, {
          amount: "0.00",
          status: "REJECTED",
          failure_code: "INSUFFICIENT_FUNDS",
          processed_at: null,
        }),
      ),
    );
    expect(err.constraint).toBe("wager_transaction_amount_ck");
    await insert(
      "wager_transaction",
      betRow(wallet, { kind: "LOSS", amount: "0.00", balance_after: "100.00" }),
    );
  });

  test("REJECTED sem failure_code é recusado", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const err = await errorOf(
      insert("wager_transaction", betRow(wallet, { status: "REJECTED", processed_at: null })),
    );
    expect(err.constraint).toBe("wager_transaction_failure_code_ck");
  });

  test("transação terminal não muda mais de estado", async () => {
    const { bet } = await walletWithProcessedBet(db());
    const err = await errorOf(
      db().sql(
        "update wager_transaction set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = null where id = ?",
        [bet.id],
      ),
    );
    expect(err.message).toContain("is terminal");
  });

  test("campos de negócio são imutáveis mesmo antes do estado terminal", async () => {
    const wallet = await openWalletInDb(db(), "100.00");
    const pending = betRow(wallet, {
      kind: "ROLLBACK",
      reference_external_transaction_id: "missing",
      status: "PENDING_REFERENCE",
      processed_at: null,
      balance_after: null,
      next_resolution_at: new Date().toISOString(),
      resolution_attempts: 1,
    });
    await insert("wager_transaction", pending);
    const err = await errorOf(
      db().sql("update wager_transaction set amount = 99.00 where id = ?", [pending.id]),
    );
    expect(err.message).toContain("immutable");
    // Campos de agendamento podem mudar enquanto não é terminal.
    await db().sql("update wager_transaction set resolution_attempts = 2 where id = ?", [
      pending.id,
    ]);
  });

  test("DELETE é bloqueado", async () => {
    const { bet } = await walletWithProcessedBet(db());
    const err = await errorOf(db().sql("delete from wager_transaction where id = ?", [bet.id]));
    expect(err.message).toContain("cannot be deleted");
  });

  test("um único reversal PROCESSED por alvo (ADR 0006)", async () => {
    const { wallet, bet } = await walletWithProcessedBet(db());
    const reversal = (kind: string) =>
      betRow(wallet, {
        kind,
        reference_external_transaction_id: bet.external_transaction_id as string,
        reference_transaction_id: bet.id as string,
        balance_after: "100.00",
      });
    await insert("wager_transaction", reversal("REFUND"));
    const err = await errorOf(insert("wager_transaction", reversal("ROLLBACK")));
    expect(err.constraint).toBe("wager_transaction_one_reversal_per_target_uq");
  });
});

describe("inbox_message", () => {
  test("(consumer, messageId) é único", async () => {
    const row = {
      consumer_name: "wager-transactions",
      message_id: `msg-${uuid()}`,
      payload_hash: "b".repeat(64),
      received_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
    };
    await insert("inbox_message", row);
    const err = await errorOf(insert("inbox_message", row));
    expect(err.constraint).toBe("inbox_message_pk");
    // O mesmo messageId em outro consumer é outra mensagem.
    await insert("inbox_message", { ...row, consumer_name: "other-consumer" });
  });
});
