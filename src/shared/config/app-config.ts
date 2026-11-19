import { hostname } from "node:os";
import { z } from "zod";

export const ROLES = ["api", "consumer", "outbox-publisher", "pending-reference-worker"] as const;
export type Role = (typeof ROLES)[number];

const rolesSchema = z
  .string()
  .default(ROLES.join(","))
  .transform((raw) =>
    raw
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0),
  )
  .pipe(z.array(z.enum(ROLES)).min(1));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  INSTANCE_ID: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ROLES: rolesSchema,
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// connection string"),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  SQS_WAGER_QUEUE_NAME: z.string().endsWith(".fifo").default("wager-transactions.fifo"),
  SQS_WAGER_DLQ_NAME: z.string().endsWith(".fifo").default("wager-transactions-dlq.fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith(".fifo").default("wagering-events.fifo"),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  WALLET_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  REFERENCE_RETRY_MAX: z.coerce.number().int().min(0).default(10),
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(2000),
  REFERENCE_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
});

export interface AppConfig {
  readonly env: "development" | "test" | "production";
  readonly port: number;
  readonly instanceId: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly roles: readonly Role[];
  readonly database: { readonly url: string };
  readonly aws: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly credentials:
      | { readonly accessKeyId: string; readonly secretAccessKey: string }
      | undefined;
  };
  readonly sqs: {
    readonly wagerQueueName: string;
    readonly wagerDlqName: string;
    readonly eventsQueueName: string;
  };
  readonly healthCheckTimeoutMs: number;
  readonly wagering: {
    /** Espera máxima pelo lock da wallet antes de responder 503 LOCK_TIMEOUT (ADR 0003). */
    readonly walletLockTimeoutMs: number;
    /** Política de espera por reference fora de ordem (CHALLENGE §7.1). */
    readonly referenceRetry: {
      readonly maxRetries: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
    };
  };
}

export class InvalidConfigError extends Error {
  constructor(issues: string) {
    super(`Invalid environment configuration:\n${issues}`);
    this.name = "InvalidConfigError";
  }
}

/** Lê e valida o ambiente uma única vez no boot; configuração inválida derruba o processo. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new InvalidConfigError(z.prettifyError(parsed.error));
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    instanceId: e.INSTANCE_ID ?? hostname(),
    logLevel: e.LOG_LEVEL,
    roles: e.ROLES,
    database: { url: e.DATABASE_URL },
    aws: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      credentials:
        e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY }
          : undefined,
    },
    sqs: {
      wagerQueueName: e.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: e.SQS_WAGER_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
    },
    healthCheckTimeoutMs: e.HEALTH_CHECK_TIMEOUT_MS,
    wagering: {
      walletLockTimeoutMs: e.WALLET_LOCK_TIMEOUT_MS,
      referenceRetry: {
        maxRetries: e.REFERENCE_RETRY_MAX,
        baseDelayMs: e.REFERENCE_RETRY_BASE_MS,
        maxDelayMs: e.REFERENCE_RETRY_MAX_DELAY_MS,
      },
    },
  };
}
