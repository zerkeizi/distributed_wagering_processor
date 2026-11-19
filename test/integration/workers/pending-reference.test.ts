import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "../../../src/shared/concurrency/keyed-mutex.ts";
import { ExponentialBackoff } from "../../../src/shared/domain/exponential-backoff.ts";
import type { WageringTelemetry } from "../../../src/wagering/application/ports/telemetry.ts";
import { ResolvePendingReferences } from "../../../src/wagering/application/use-cases/resolve-pending-references.ts";
import { ReferenceResolutionPolicy } from "../../../src/wagering/domain/reference-resolution-policy.ts";
import { useTestApp } from "../support/http-app.ts";
import { assertLedgerConsistent } from "../support/ledger-consistency.ts";
import { eventually } from "../support/sqs.ts";
import { balanceOf, createWallet, submitWager, uuid } from "../support/wagering-client.ts";

/** Worker de referências fora de ordem (CHALLENGE §7.1, §13 cenário 7). */
const app = useTestApp({
  ROLES: "api,pending-reference-worker",
  PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
  REFERENCE_RETRY_MAX: "3",
  REFERENCE_RETRY_BASE_MS: "200",
  REFERENCE_RETRY_MAX_DELAY_MS: "400",
});

const tx = async (id: string) => (await app().request("GET", `/wagering/transactions/${id}`)).body;
const events = async (walletId: string, type: string) =>
  (
    await app().db.sql("select 1 from outbox_message where aggregate_id = ? and event_type = ?", [
      walletId,
      type,
    ])
  ).length;

describe("worker de PENDING_REFERENCE", () => {
  test("ROLLBACK chega antes da BET; a BET chega depois; o worker resolve sozinho, sem reenvio", async () => {
    const w = await createWallet(app(), "100.00");
    const betExt = `bet-${uuid()}`;
    const rollback = await submitWager(app(), w, {
      kind: "ROLLBACK",
      amount: "25.00",
      referenceExternalTransactionId: betExt,
    });
    expect(rollback.status).toBe(202);

    const bet = await submitWager(app(), w, {
      kind: "BET",
      amount: "25.00",
      externalTransactionId: betExt,
    });
    expect(bet.status).toBe(201);

    const resolved = await eventually(
      () => tx(rollback.body.transactionId),
      (t) => t.status === "PROCESSED",
    );
    expect(resolved.referenceTransactionId).toBe(bet.body.transactionId);
    expect(await balanceOf(app(), w.walletId)).toBe("100.00");
    expect(await events(w.walletId, "WagerTransactionPendingReference")).toBe(1);
    await assertLedgerConsistent(app().db, w.walletId);
  });

  test("referência nunca chega: backoff, depois REJECTED REFERENCE_NOT_FOUND com evento", async () => {
    const w = await createWallet(app(), "100.00");
    const refund = await submitWager(app(), w, {
      kind: "REFUND",
      amount: "5.00",
      referenceExternalTransactionId: `ghost-${uuid()}`,
    });
    const rejected = await eventually(
      () => tx(refund.body.transactionId),
      (t) => t.status === "REJECTED",
      {
        timeoutMs: 15_000,
      },
    );
    expect(rejected.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(rejected.resolutionAttempts).toBe(3);
    // Um único evento de pendência (na entrada), um de rejeição (no fim): retries não geram ruído.
    expect(await events(w.walletId, "WagerTransactionPendingReference")).toBe(1);
    expect(await events(w.walletId, "WagerTransactionRejected")).toBe(1);
    expect(await balanceOf(app(), w.walletId)).toBe("100.00");
  });

  test("estado corrompido no banco → FAILED (ADR 0011), terminal e auditável", async () => {
    // Worker isolado e determinístico: ResolvePendingReferences chamado direto, com o banco real.
    const w = await createWallet(app(), "100.00");
    const winExt = `win-${uuid()}`;
    const rollback = await submitWager(app(), w, {
      kind: "ROLLBACK",
      amount: "10.00",
      referenceExternalTransactionId: winExt,
    });
    // Tira a pendente do alcance do worker da app enquanto preparamos o cenário.
    await app().db.sql(
      "update wager_transaction set next_resolution_at = now() + interval '1 hour' where id = ?",
      [rollback.body.transactionId],
    );
    const bet = await submitWager(app(), w, { kind: "BET", amount: "10.00" });
    await submitWager(app(), w, {
      kind: "WIN",
      amount: "10.00",
      externalTransactionId: winExt,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await app().db.inTransaction(async (exec) => {
      // Corrompe o saldo por fora das triggers e devolve a pendente para "vencida".
      await exec("set local session_replication_role = replica");
      await exec("update wallet set balance = 55.55 where id = ?", [w.walletId]);
      await exec(
        "update wager_transaction set next_resolution_at = now() - interval '1 second' where id = ?",
        [rollback.body.transactionId],
      );
    });

    const failures: string[] = [];
    const resolver = new ResolvePendingReferences({
      uow: app().db.uow,
      clock: { now: () => new Date() },
      ids: { next: () => Bun.randomUUIDv7() },
      telemetry: new Proxy({}, { get: () => () => {} }) as WageringTelemetry,
      resolutionPolicy: new ReferenceResolutionPolicy(3, new ExponentialBackoff(100, 200)),
      walletLockTimeoutMs: 2_000,
      walletMutex: new KeyedMutex(),
      batchSize: 500,
      onFailure: (id) => failures.push(id),
    });
    await eventually(
      async () => {
        await resolver.tick();
        return tx(rollback.body.transactionId);
      },
      (t) => t.status === "FAILED",
    );
    const failed = await tx(rollback.body.transactionId);
    expect(failed.failureCode).toBe("INTERNAL_INVARIANT_VIOLATION");
    // O lançamento recusado pelo encadeamento do ledger não entrou; o saldo corrompido não foi "consertado".
    expect(await balanceOf(app(), w.walletId)).toBe("55.55");
  });
});
