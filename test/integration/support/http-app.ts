import { afterAll, beforeAll } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../../src/bootstrap.ts";
import { loadConfig } from "../../../src/shared/config/app-config.ts";
import { openTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "./database.ts";

export interface TestApp {
  readonly baseUrl: string;
  readonly db: TestDatabase;
  request(
    method: string,
    path: string,
    init?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<TestResponse>;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: corpo JSON arbitrário, inspecionado pelos testes
  readonly body: any;
}

/**
 * Sobe a aplicação Nest completa (mesmo bootstrap do main.ts) numa porta aleatória, contra o
 * Postgres e o LocalStack do compose. Os testes falam HTTP de verdade com ela.
 */
/** Sobe uma instância da aplicação; quem chama é responsável por `close()`. */
export async function startTestApp(
  env: Record<string, string> = {},
): Promise<TestApp & { close(): Promise<void> }> {
  const databaseUrl = env.DATABASE_URL ?? TEST_DATABASE_URL;
  const db = await openTestDatabase(databaseUrl);
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    ROLES: "api",
    DATABASE_URL: databaseUrl,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ...env,
  });
  const app: INestApplication = await createApp(config);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    db,
    async request(method, path, init = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined
          ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
          : {}),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // corpo não-JSON (ex.: /metrics)
      }
      return { status: res.status, headers: res.headers, body };
    },
    async close() {
      await app.close();
      await db.orm.close();
    },
  };
}

/**
 * Sobe a aplicação no beforeAll do arquivo e fecha no afterAll. `env` pode ser uma função, avaliada
 * só na hora de subir — útil quando depende de algo criado num beforeAll anterior (ex.: filas).
 */
export function useTestApp(
  env: Record<string, string> | (() => Record<string, string>) = {},
): () => TestApp {
  let testApp: (TestApp & { close(): Promise<void> }) | undefined;
  beforeAll(async () => {
    testApp = await startTestApp(typeof env === "function" ? env() : env);
  });
  afterAll(async () => {
    await testApp?.close();
  });
  return () => {
    if (!testApp) throw new Error("test app not started (call inside a test)");
    return testApp;
  };
}
