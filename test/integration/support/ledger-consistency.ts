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

/**
 * Wallets corrompidas DE PROPÓSITO por um teste (ex.: reconciliação que precisa achar divergência).
 * Ficam fora da verificação automática de fim de suíte; o próprio teste afirma o estado esperado.
 */
const intentionallyCorrupted = new Set<string>();

export function markIntentionallyCorrupted(walletId: string): void {
  intentionallyCorrupted.add(walletId);
}

export interface InconsistentWallet {
  readonly walletId: string;
  readonly storedBalance: string;
  readonly rebuiltBalance: string;
  readonly chainBreaks: number;
}

/** Todas as wallets criadas desde `since` cujo saldo não bate com o ledger (uma única query). */
export async function inconsistentWalletsSince(
  db: TestDatabase,
  since: Date,
): Promise<InconsistentWallet[]> {
  const rows = await db.sql<{
    wallet_id: string;
    stored: string;
    rebuilt: string;
    chain_breaks: string;
  }>(
    `
    with entries as (
      select e.wallet_id, e.direction, e.amount, e.wallet_version, e.balance_before,
             lag(e.balance_after) over (partition by e.wallet_id order by e.wallet_version) as prev_after,
             lag(e.wallet_version) over (partition by e.wallet_id order by e.wallet_version) as prev_version
        from wallet_ledger_entry e
        join wallet w on w.id = e.wallet_id
       where w.created_at >= ?
    ),
    totals as (
      select w.id as wallet_id,
             w.balance as stored,
             coalesce(sum(case when x.direction = 'CREDIT' then x.amount else -x.amount end), 0)::numeric(20, 2) as rebuilt,
             count(*) filter (
               where x.prev_version is not null
                 and (x.prev_version <> x.wallet_version - 1 or x.prev_after <> x.balance_before)
             ) as chain_breaks
        from wallet w
        left join entries x on x.wallet_id = w.id
       where w.created_at >= ?
       group by w.id, w.balance
    )
    select wallet_id, stored::text, rebuilt::text, chain_breaks::text
      from totals
     where stored <> rebuilt or chain_breaks > 0
    `,
    [since, since],
  );
  return rows.map((r) => ({
    walletId: r.wallet_id,
    storedBalance: r.stored,
    rebuiltBalance: r.rebuilt,
    chainBreaks: Number(r.chain_breaks),
  }));
}

/**
 * Invariante final de TODOS os testes (CHALLENGE §13), aplicada automaticamente no fim de cada
 * suíte por `useTestDatabase` e pelo `close()` das apps de teste: toda wallet criada durante a suíte
 * precisa fechar com o ledger, exceto as marcadas com `markIntentionallyCorrupted`.
 */
export async function assertWalletsConsistentSince(db: TestDatabase, since: Date): Promise<void> {
  const broken = (await inconsistentWalletsSince(db, since)).filter(
    (w) => !intentionallyCorrupted.has(w.walletId),
  );
  if (broken.length > 0) {
    throw new Error(
      `CHALLENGE §13 invariant violated (wallet.balance != ledger) for ${broken.length} wallet(s): ${JSON.stringify(broken.slice(0, 5))}`,
    );
  }
}
