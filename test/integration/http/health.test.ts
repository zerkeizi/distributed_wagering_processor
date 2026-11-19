import { afterAll, describe, expect, test } from "bun:test";
import { startTestApp, useTestApp } from "../support/http-app.ts";

/**
 * CHALLENGE §9 Health checks: live = processo vivo; ready = PostgreSQL e SQS alcançáveis; nenhum
 * dos dois exige autenticação (as requisições abaixo não mandam credencial alguma). A queda do
 * Postgres é coberta em `sqs/database-outage.test.ts`, onde o banco cai de verdade.
 */
const app = useTestApp();

describe("GET /health/live", () => {
  test("200 sem autenticação", async () => {
    const res = await app().request("GET", "/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /health/ready", () => {
  test("200 com Postgres e SQS up, sem autenticação", async () => {
    const res = await app().request("GET", "/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.postgres.status).toBe("up");
    expect(res.body.checks.sqs.status).toBe("up");
  });

  describe("fila SQS inalcançável", () => {
    let broken: Awaited<ReturnType<typeof startTestApp>> | undefined;
    afterAll(async () => {
      await broken?.close();
    });

    test("503 com sqs down e postgres up; live continua 200", async () => {
      broken = await startTestApp({ SQS_WAGER_QUEUE_NAME: `missing-${Bun.randomUUIDv7()}.fifo` });
      const res = await broken.request("GET", "/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unavailable");
      expect(res.body.checks.postgres.status).toBe("up");
      expect(res.body.checks.sqs.status).toBe("down");
      expect(typeof res.body.checks.sqs.error).toBe("string");
      expect((await broken.request("GET", "/health/live")).status).toBe(200);
    });
  });
});
