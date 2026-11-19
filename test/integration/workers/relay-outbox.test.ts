import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "../../../src/shared/domain/exponential-backoff.ts";
import type { OutboxMessage } from "../../../src/shared/messaging/outbox-message.ts";
import type { EventPublisher } from "../../../src/wagering/application/ports/outbox-store.ts";
import type { WageringTelemetry } from "../../../src/wagering/application/ports/telemetry.ts";
import { RelayOutbox } from "../../../src/wagering/application/use-cases/relay-outbox.ts";
import { MikroOrmOutboxStore } from "../../../src/wagering/infrastructure/persistence/mikro-orm-outbox-store.ts";
import { openFreshDatabase } from "../support/database.ts";

/**
 * RelayOutbox com o Postgres real, num banco exclusivo e sem nenhuma aplicação rodando: só os relays
 * do teste disputam a outbox, e o relógio é controlado pelo teste (determinístico).
 */
let db: Awaited<ReturnType<typeof openFreshDatabase>>;
beforeAll(async () => {
  db = await openFreshDatabase("relay");
});
afterAll(async () => {
  await db?.drop();
});

const noopTelemetry = new Proxy({}, { get: () => () => {} }) as WageringTelemetry;

/** Publisher que registra cada publicação; pode falhar nas N primeiras chamadas. */
class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  private calls = 0;
  constructor(private readonly failFirst = 0) {}
  async publish(message: OutboxMessage): Promise<void> {
    this.calls++;
    if (this.calls <= this.failFirst) throw new Error("broker unavailable");
    await Bun.sleep(1); // dá chance de intercalar com o outro publisher
    this.published.push(message.id);
  }
}

async function insertEvents(count: number, aggregateId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = Bun.randomUUIDv7();
    ids.push(id);
    await db.sql(
      `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, 'Test', '{}', now(), 0, now())`,
      [id, aggregateId],
    );
  }
  return ids;
}

async function insertEvent(aggregateId: string): Promise<string> {
  const [id] = await insertEvents(1, aggregateId);
  if (!id) throw new Error("event not inserted");
  return id;
}

describe("RelayOutbox", () => {
  test("dois publishers concorrentes: nenhum evento perdido, nenhum publicado duas vezes (CHALLENGE §13.6)", async () => {
    const ids = await insertEvents(60, "concurrent");
    const store = new MikroOrmOutboxStore(db.orm);
    const clock = { now: () => new Date() };
    const options = { batchSize: 5, leaseMs: 60_000, backoff: new ExponentialBackoff(100, 1_000) };
    const a = new RecordingPublisher();
    const b = new RecordingPublisher();
    const relayA = new RelayOutbox(store, a, clock, noopTelemetry, options);
    const relayB = new RelayOutbox(store, b, clock, noopTelemetry, options);
    const drain = async (relay: RelayOutbox) => {
      while ((await relay.tick()).claimed > 0) {}
    };
    await Promise.all([drain(relayA), drain(relayB)]);

    const all = [...a.published, ...b.published];
    expect(new Set(all)).toEqual(new Set(ids)); // todos publicados
    expect(all).toHaveLength(ids.length); // nenhum duas vezes
    expect(a.published.length).toBeGreaterThan(0); // os dois trabalharam de fato
    expect(b.published.length).toBeGreaterThan(0);
    const pending = await db.sql(
      "select 1 from outbox_message where published_at is null and id in (?)",
      [ids],
    );
    expect(pending).toHaveLength(0);
  });

  test("falha ao publicar: nova tentativa com backoff exponencial, e o evento não se perde", async () => {
    const id = await insertEvent("retry");
    const store = new MikroOrmOutboxStore(db.orm);
    let now = new Date(Date.now() + 1_000);
    const clock = { now: () => now };
    const backoff = new ExponentialBackoff(1_000, 8_000);
    const failing = new RelayOutbox(
      store,
      new RecordingPublisher(Number.POSITIVE_INFINITY),
      clock,
      noopTelemetry,
      {
        batchSize: 10,
        leaseMs: 30_000,
        backoff,
      },
    );

    expect(await failing.tick()).toMatchObject({ claimed: 1, failed: 1 });
    const row = async () =>
      (
        await db.sql<{ attempts: number; next: Date; locked: Date | null; published: Date | null }>(
          "select attempts, next_attempt_at as next, locked_until as locked, published_at as published from outbox_message where id = ?",
          [id],
        )
      )[0];
    expect(await row()).toMatchObject({ attempts: 1, locked: null, published: null });
    expect(new Date((await row())?.next ?? 0).getTime()).toBe(now.getTime() + 1_000);

    // Antes do backoff vencer, ninguém pega o evento.
    expect((await failing.tick()).claimed).toBe(0);
    now = new Date(now.getTime() + 1_000);
    expect(await failing.tick()).toMatchObject({ claimed: 1, failed: 1 });
    expect((await row())?.attempts).toBe(2); // segunda espera: 2 s

    now = new Date(now.getTime() + 2_000);
    const healthy = new RecordingPublisher();
    const relay = new RelayOutbox(store, healthy, clock, noopTelemetry, {
      batchSize: 10,
      leaseMs: 30_000,
      backoff,
    });
    expect(await relay.tick()).toMatchObject({ claimed: 1, published: 1 });
    expect(healthy.published).toEqual([id]);
    expect((await row())?.published).not.toBeNull();
  });

  test("publisher morre com o evento reservado: depois do lease, outro publica (CHALLENGE §11)", async () => {
    const id = await insertEvent("lease");
    const store = new MikroOrmOutboxStore(db.orm);
    let now = new Date(Date.now() + 1_000);
    const clock = { now: () => now };
    // "Publisher morto": reserva e nunca marca (simulado reservando direto pelo store).
    expect(await store.claimDue(now, 10, 5_000)).toHaveLength(1);

    const survivor = new RecordingPublisher();
    const relay = new RelayOutbox(store, survivor, clock, noopTelemetry, {
      batchSize: 10,
      leaseMs: 5_000,
      backoff: new ExponentialBackoff(100, 1_000),
    });
    expect((await relay.tick()).claimed).toBe(0); // ainda reservado
    now = new Date(now.getTime() + 5_001);
    expect(await relay.tick()).toMatchObject({ claimed: 1, published: 1 });
    expect(survivor.published).toEqual([id]);
  });
});
