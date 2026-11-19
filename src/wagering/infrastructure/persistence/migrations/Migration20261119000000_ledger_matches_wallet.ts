import { Migration } from "@mikro-orm/migrations";

/**
 * CHALLENGE §6.2: "toda alteração de saldo tem um lançamento correspondente no ledger (e vice-versa)".
 *
 * A migration inicial garante a primeira metade: a trigger adiada `wallet_matches_ledger_trg` dispara
 * quando a WALLET muda e exige um lançamento que explique o novo saldo. Faltava o "vice-versa":
 * um lançamento inserido sem alterar a wallet passava no commit, deixando o extrato dizer uma coisa e
 * o saldo outra (CHALLENGE §5.9: a garantia tem que estar no schema).
 *
 * Esta migration adiciona o lado do ledger: no commit de qualquer transação que inseriu lançamentos,
 * a wallet precisa terminar com o saldo e a versão do seu último lançamento.
 */
export class Migration20261119000000_ledger_matches_wallet extends Migration {
  override name = "Migration20261119000000_ledger_matches_wallet";

  override up(): void {
    this.addSql(`
      create function ledger_entry_matches_wallet() returns trigger language plpgsql as $$
      declare
        current_balance numeric(20, 2);
        current_version integer;
        last_version integer;
        last_balance numeric(20, 2);
      begin
        -- Estado no momento do commit (trigger adiada), não no momento do INSERT.
        select balance, version into current_balance, current_version
          from wallet where id = new.wallet_id;
        if not found then
          return null; -- a FK adiada para wallet já recusa este caso
        end if;
        select wallet_version, balance_after into last_version, last_balance
          from wallet_ledger_entry
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;
        if last_version is distinct from current_version or last_balance is distinct from current_balance then
          raise exception 'ledger entry v% for wallet % has no matching balance change (wallet: %, v%)',
            new.wallet_version, new.wallet_id, current_balance, current_version
            using errcode = '23514', constraint = 'ledger_matches_wallet_ck';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger ledger_entry_matches_wallet_trg
        after insert on wallet_ledger_entry
        deferrable initially deferred
        for each row execute function ledger_entry_matches_wallet()
    `);
  }

  override down(): void {
    this.addSql("drop trigger if exists ledger_entry_matches_wallet_trg on wallet_ledger_entry");
    this.addSql("drop function if exists ledger_entry_matches_wallet()");
  }
}
