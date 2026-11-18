import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { AppConfig } from "../shared/config/app-config.ts";
import { APP_CONFIG } from "../shared/config/config.module.ts";
import { HEALTH_PG_POOL, SQS_CLIENT } from "../shared/infrastructure/infrastructure.module.ts";

export interface DependencyStatus {
  readonly status: "up" | "down";
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ReadinessReport {
  readonly status: "ok" | "unavailable";
  readonly checks: { readonly postgres: DependencyStatus; readonly sqs: DependencyStatus };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HEALTH_PG_POOL) private readonly pool: Pool,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe(async () => {
        await this.pool.query("SELECT 1");
      }),
      this.probe(async (signal) => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName }), {
          abortSignal: signal,
        });
      }),
    ]);
    const ok = postgres.status === "up" && sqs.status === "up";
    return { status: ok ? "ok" : "unavailable", checks: { postgres, sqs } };
  }

  private async probe(check: (signal: AbortSignal) => Promise<void>): Promise<DependencyStatus> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeoutMs = this.config.healthCheckTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      return { status: "up", latencyMs: elapsed(startedAt) };
    } catch (error) {
      // Só o nome/mensagem curta: a resposta de health é pública (README §9).
      const message = error instanceof Error ? error.message : "unknown error";
      return { status: "down", latencyMs: elapsed(startedAt), error: message.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
