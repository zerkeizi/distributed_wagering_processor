import { expect } from "bun:test";
import type { TestDatabase } from "./database.ts";

export interface LedgerConsistency {
  readonly storedBalance: string;
  readonly rebuiltBalance: string;
  readonly version: number;
  readonly entries: number;
  readonly chainBreaks: number;
}

/**
 * Invariante final de todos os testes (CHALLENGE §13): saldo armazenado == saldo reconstruído pelo
 * ledger, versão == último lançamento, e cada lançamento continua do anterior.
 */
export async function ledgerConsistency(
  db: TestDatabase,
  walletId: string,
): Promise<LedgerConsistency> {
  const [row] = await db.sql<{
    stored: string;
    rebuilt: string;
    version: number;
    entries: string;
    chain_breaks: string;
  }>(
    `
    with entries as (
      select e.*,
             lag(e.balance_after) over (order by e.wallet_version) as prev_after,
             lag(e.wallet_version) over (order by e.wallet_version) as prev_version
        from wallet_ledger_entry e
       where e.wallet_id = ?
    )
    select w.balance::text as stored,
           coalesce(sum(case when x.direction = 'CREDIT' then x.amount else -x.amount end), 0)::numeric(20, 2)::text as rebuilt,
           w.version,
           count(x.id)::text as entries,
           count(*) filter (
             where x.prev_version is not null
               and (x.prev_version <> x.wallet_version - 1 or x.prev_after <> x.balance_before)
           )::text as chain_breaks
      from wallet w
      left join entries x on true
     where w.id = ?
     group by w.id, w.balance, w.version
    `,
    [walletId, walletId],
  );
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return {
    storedBalance: row.stored,
    rebuiltBalance: row.rebuilt,
    version: row.version,
    entries: Number(row.entries),
    chainBreaks: Number(row.chain_breaks),
  };
}

export async function assertLedgerConsistent(db: TestDatabase, walletId: string): Promise<void> {
  const c = await ledgerConsistency(db, walletId);
  expect(c.rebuiltBalance).toBe(c.storedBalance);
  expect(c.chainBreaks).toBe(0);
}
