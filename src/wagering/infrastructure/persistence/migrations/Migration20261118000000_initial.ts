import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade vivem aqui, no banco,
 * e não só no código (CHALLENGE §5.9). Cada bloco cita a regra que protege.
 *
 * Todas as FKs são DEFERRABLE INITIALLY DEFERRED: wallet, transação OPENING e lançamento nascem no
 * mesmo commit, e a ordem dos INSERTs do Unit of Work não precisa respeitar as dependências.
 */
export class Migration20261118000000_initial extends Migration {
  override name = "Migration20261118000000_initial";

  override up(): void {
    // ---------------------------------------------------------------- wallet
    this.addSql(`
      create table wallet (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null,
        balance     numeric(20, 2) not null,
        version     integer        not null,
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,

        -- CHALLENGE §6.2: no máximo uma wallet por player + moeda.
        constraint wallet_player_currency_uq unique (player_id, currency),
        -- Alvo das FKs compostas: transações e lançamentos não podem divergir da moeda/player da wallet.
        constraint wallet_identity_uq unique (id, player_id, currency),
        constraint wallet_currency_uq unique (id, currency),
        -- CHALLENGE §3/§6.2: saldo nunca negativo.
        constraint wallet_balance_non_negative_ck check (balance >= 0),
        constraint wallet_version_positive_ck check (version >= 1),
        constraint wallet_currency_format_ck check (currency ~ '^[A-Z]{3}$')
      )
    `);

    // ------------------------------------------------------ wager_transaction
    this.addSql(`
      create table wager_transaction (
        id                                uuid           primary key,
        provider_id                       varchar(128)   not null,
        external_transaction_id           varchar(128)   not null,
        idempotency_key                   varchar(255)   not null,
        payload_hash                      char(64)       not null,
        wallet_id                         uuid           not null,
        player_id                         uuid           not null,
        currency                          char(3)        not null,
        round_id                          varchar(128),
        game_id                           varchar(128),
        kind                              varchar(16)    not null,
        amount                            numeric(20, 2) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid,
        status                            varchar(20)    not null,
        failure_code                      varchar(40),
        balance_after                     numeric(20, 2),
        processed_at                      timestamptz,
        resolution_attempts               integer        not null default 0,
        next_resolution_at                timestamptz,
        correlation_id                    varchar(128)   not null,
        created_at                        timestamptz    not null,
        updated_at                        timestamptz    not null,

        -- ADR 0008: idempotência persistente, por provider.
        constraint wager_transaction_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_transaction_external_id_uq unique (provider_id, external_transaction_id),
        -- Alvo da FK do ledger: o lançamento pertence à mesma wallet da transação.
        constraint wager_transaction_wallet_uq unique (id, wallet_id),

        -- ADR 0007 + CHALLENGE §6.2: transação sempre na wallet, player e moeda corretos.
        constraint wager_transaction_wallet_fk foreign key (wallet_id, player_id, currency)
          references wallet (id, player_id, currency) deferrable initially deferred,
        constraint wager_transaction_reference_fk foreign key (reference_transaction_id)
          references wager_transaction (id) deferrable initially deferred,

        constraint wager_transaction_kind_ck
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        -- ADR 0004: PENDING existe só em memória e nunca é commitado.
        constraint wager_transaction_status_ck
          check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transaction_payload_hash_ck check (payload_hash ~ '^[0-9a-f]{64}$'),
        -- LOSS aceita 0.00; os demais movem saldo e exigem valor positivo.
        constraint wager_transaction_amount_ck
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        -- ADR 0015: OPENING é exclusivo do provider reservado, e só ele dispensa round/game.
        constraint wager_transaction_opening_provider_ck
          check ((kind = 'OPENING') = (provider_id = '__system__')),
        constraint wager_transaction_round_game_ck
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        -- CHALLENGE §7.1: REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter.
        constraint wager_transaction_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transaction_reference_forbidden_ck
          check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null),
        constraint wager_transaction_no_self_reference_ck
          check (reference_transaction_id is null or reference_transaction_id <> id),
        -- Coerência entre status e campos de resultado.
        constraint wager_transaction_processed_ck check (
          (status = 'PROCESSED') = (processed_at is not null)
          and (status <> 'PROCESSED' or reference_external_transaction_id is null
               or reference_transaction_id is not null)
        ),
        constraint wager_transaction_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transaction_balance_after_ck check (
          (status in ('PROCESSED', 'REJECTED')) = (balance_after is not null)
          and (balance_after is null or balance_after >= 0)
        ),
        constraint wager_transaction_pending_reference_ck
          check ((status = 'PENDING_REFERENCE') = (next_resolution_at is not null)),
        constraint wager_transaction_resolution_attempts_ck check (resolution_attempts >= 0)
      )
    `);

    // ADR 0006: no máximo um reversal PROCESSED por alvo — impede crédito/débito duplo.
    this.addSql(`
      create unique index wager_transaction_one_reversal_per_target_uq
        on wager_transaction (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);
    // Fila do worker de referências fora de ordem (CHALLENGE §7.1).
    this.addSql(`
      create index wager_transaction_pending_reference_due_idx
        on wager_transaction (next_resolution_at)
        where status = 'PENDING_REFERENCE'
    `);
    // Quem está esperando esta referência? Usado para reagendar dependentes quando ela chega.
    this.addSql(`
      create index wager_transaction_waiting_on_reference_idx
        on wager_transaction (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(
      `create index wager_transaction_wallet_idx on wager_transaction (wallet_id, created_at)`,
    );

    // Campos de negócio são imutáveis e estados terminais não mudam (CHALLENGE §6.3).
    this.addSql(`
      create function wager_transaction_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transaction rows cannot be deleted' using errcode = 'P0001';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager_transaction % is terminal (%)', old.id, old.status
            using errcode = 'P0001';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.currency, new.round_id,
            new.game_id, new.kind, new.amount, new.reference_external_transaction_id,
            new.correlation_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.currency, old.round_id,
            old.game_id, old.kind, old.amount, old.reference_external_transaction_id,
            old.correlation_id, old.created_at) then
          raise exception 'wager_transaction % business fields are immutable', old.id
            using errcode = 'P0001';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wager_transaction_guard_trg
        before update or delete on wager_transaction
        for each row execute function wager_transaction_guard()
    `);

    // ---------------------------------------------------- wallet_ledger_entry
    this.addSql(`
      create table wallet_ledger_entry (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        currency        char(3)        not null,
        direction       varchar(6)     not null,
        amount          numeric(20, 2) not null,
        balance_before  numeric(20, 2) not null,
        balance_after   numeric(20, 2) not null,
        wallet_version  integer        not null,
        created_at      timestamptz    not null,

        -- CHALLENGE §6.4: no máximo um lançamento por transação.
        constraint wallet_ledger_entry_transaction_uq unique (transaction_id),
        -- ADR 0009: sequência sem buracos por wallet; também é o cursor do extrato.
        constraint wallet_ledger_entry_version_uq unique (wallet_id, wallet_version),
        constraint wallet_ledger_entry_wallet_fk foreign key (wallet_id, currency)
          references wallet (id, currency) deferrable initially deferred,
        constraint wallet_ledger_entry_transaction_fk foreign key (transaction_id, wallet_id)
          references wager_transaction (id, wallet_id) deferrable initially deferred,

        constraint wallet_ledger_entry_direction_ck check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entry_amount_ck check (amount > 0),
        constraint wallet_ledger_entry_non_negative_ck
          check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entry_version_ck check (wallet_version >= 1),
        -- CHALLENGE §6.4: balanceBefore ± money === balanceAfter.
        constraint wallet_ledger_entry_arithmetic_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )
    `);

    // CHALLENGE §5.5: lançamentos nunca são sobrescritos nem excluídos.
    this.addSql(`
      create function wallet_ledger_entry_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entry is append-only (% blocked)', tg_op
          using errcode = 'P0001';
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entry_immutable_trg
        before update or delete on wallet_ledger_entry
        for each row execute function wallet_ledger_entry_immutable()
    `);
    this.addSql(`
      create trigger wallet_ledger_entry_no_truncate_trg
        before truncate on wallet_ledger_entry
        for each statement execute function wallet_ledger_entry_immutable()
    `);

    // ADR 0009: cada lançamento continua exatamente de onde o anterior parou.
    this.addSql(`
      create function wallet_ledger_entry_chain() returns trigger language plpgsql as $$
      declare
        prev record;
      begin
        if exists (select 1 from wallet_ledger_entry
                   where wallet_id = new.wallet_id and wallet_version > new.wallet_version) then
          raise exception 'ledger entry version % is behind the wallet history', new.wallet_version
            using errcode = '23514', constraint = 'wallet_ledger_entry_chain_ck';
        end if;
        select wallet_version, balance_after into prev
          from wallet_ledger_entry
         where wallet_id = new.wallet_id and wallet_version < new.wallet_version
         order by wallet_version desc
         limit 1;
        if not found then
          if new.balance_before <> 0 then
            raise exception 'first ledger entry must start from a zero balance'
              using errcode = '23514', constraint = 'wallet_ledger_entry_chain_ck';
          end if;
        elsif prev.wallet_version <> new.wallet_version - 1
              or prev.balance_after <> new.balance_before then
          raise exception 'ledger entry does not continue the previous one (version %)',
            new.wallet_version using errcode = '23514', constraint = 'wallet_ledger_entry_chain_ck';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entry_chain_trg
        before insert on wallet_ledger_entry
        for each row execute function wallet_ledger_entry_chain()
    `);

    // CHALLENGE §6.2: toda alteração de saldo tem lançamento correspondente. Verificado no commit
    // (trigger de constraint adiado), quando wallet e lançamento já foram gravados juntos.
    this.addSql(`
      create function wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        current_balance numeric(20, 2);
        current_version integer;
      begin
        select balance, version into current_balance, current_version
          from wallet where id = new.id;
        if not found then
          return null;
        end if;
        if exists (select 1 from wallet_ledger_entry e
                    where e.wallet_id = new.id
                      and e.wallet_version = current_version
                      and e.balance_after = current_balance) then
          return null;
        end if;
        -- Wallet aberta com saldo zero ainda não tem lançamento.
        if current_version = 1 and current_balance = 0
           and not exists (select 1 from wallet_ledger_entry e where e.wallet_id = new.id) then
          return null;
        end if;
        raise exception 'wallet % balance/version (%, v%) has no matching ledger entry',
          new.id, current_balance, current_version
          using errcode = '23514', constraint = 'wallet_matches_ledger_ck';
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_matches_ledger_trg
        after insert or update on wallet
        deferrable initially deferred
        for each row execute function wallet_matches_ledger()
    `);

    // ---------------------------------------------------------- inbox_message
    this.addSql(`
      create table inbox_message (
        consumer_name  varchar(128) not null,
        message_id     varchar(256) not null,
        payload_hash   char(64)     not null,
        received_at    timestamptz  not null,
        processed_at   timestamptz,
        -- CHALLENGE §10: dedup persistente por (consumerName, messageId).
        constraint inbox_message_pk primary key (consumer_name, message_id)
      )
    `);

    // --------------------------------------------------------- outbox_message
    this.addSql(`
      create table outbox_message (
        id               uuid         primary key,
        aggregate_id     varchar(128) not null,
        event_type       varchar(100) not null,
        payload          jsonb        not null,
        occurred_at      timestamptz  not null,
        attempts         integer      not null default 0,
        next_attempt_at  timestamptz,
        locked_until     timestamptz,
        published_at     timestamptz,
        constraint outbox_message_attempts_ck check (attempts >= 0)
      )
    `);
    // Claim dos publishers (ADR 0013): só pendentes, em ordem de vencimento.
    this.addSql(`
      create index outbox_message_pending_idx
        on outbox_message (next_attempt_at, occurred_at)
        where published_at is null
    `);
  }

  override down(): void {
    this.addSql("drop table if exists outbox_message");
    this.addSql("drop table if exists inbox_message");
    this.addSql("drop table if exists wallet_ledger_entry");
    this.addSql("drop table if exists wager_transaction");
    this.addSql("drop table if exists wallet");
    this.addSql("drop function if exists wallet_matches_ledger()");
    this.addSql("drop function if exists wallet_ledger_entry_chain()");
    this.addSql("drop function if exists wallet_ledger_entry_immutable()");
    this.addSql("drop function if exists wager_transaction_guard()");
  }
}
