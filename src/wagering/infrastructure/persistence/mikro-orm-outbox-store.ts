import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../../shared/messaging/outbox-message.ts";
import type { OutboxStore } from "../../application/ports/outbox-store.ts";
import { translatePersistenceError } from "./persistence-error-translator.ts";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/**
 * Cada operação é um único statement em autocommit (ADR 0013): o claim reserva e devolve as linhas
 * no mesmo comando, sem transação longa; o publish acontece fora do banco.
 */
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.execute<OutboxRow>(
      `
      update outbox_message o
         set locked_until = ?
       where o.id in (
               select id from outbox_message
                where published_at is null
                  and coalesce(next_attempt_at, occurred_at) <= ?
                  and (locked_until is null or locked_until < ?)
                order by occurred_at, id
                limit ?
                  for update skip locked
             )
      returning o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts,
                o.next_attempt_at, o.published_at
      `,
      [new Date(now.getTime() + leaseMs), now, now, limit],
    );
    // RETURNING não preserva a ordem da subquery: reordena por ocorrência.
    return rows
      .map((r) =>
        OutboxMessage.rehydrate({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
          occurredAt: new Date(r.occurred_at),
          attempts: r.attempts,
          nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
          publishedAt: r.published_at ? new Date(r.published_at) : undefined,
        }),
      )
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.execute(
      "update outbox_message set published_at = ?, locked_until = null, next_attempt_at = null where id = ? and published_at is null",
      [message.publishedAt, message.id],
    );
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.execute(
      "update outbox_message set attempts = ?, next_attempt_at = ?, locked_until = null where id = ? and published_at is null",
      [message.attempts, message.nextAttemptAt ?? null, message.id],
    );
  }

  async stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }> {
    const [row] = await this.execute<{ pending: number; oldest: Date | null }>(
      "select count(*)::int as pending, min(occurred_at) as oldest from outbox_message where published_at is null",
    );
    const oldest = row?.oldest ? new Date(row.oldest) : undefined;
    return {
      pending: row?.pending ?? 0,
      oldestPendingAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }

  private async execute<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return (await this.orm.em.fork().getConnection().execute(sql, params)) as T[];
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
