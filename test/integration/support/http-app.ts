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
export function useTestApp(env: Record<string, string> = {}): () => TestApp {
  let app: INestApplication | undefined;
  let testApp: TestApp | undefined;

  beforeAll(async () => {
    const db = await openTestDatabase();
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
      ROLES: "api",
      DATABASE_URL: TEST_DATABASE_URL,
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      ...env,
    });
    app = await createApp(config);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    testApp = {
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
    };
  });

  afterAll(async () => {
    await app?.close();
    await testApp?.db.orm.close();
  });

  return () => {
    if (!testApp) throw new Error("test app not started (call inside a test)");
    return testApp;
  };
}
