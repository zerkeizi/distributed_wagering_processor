import { describe, expect, test } from "bun:test";
import { InvalidConfigError, loadConfig } from "../../../../src/shared/config/app-config.ts";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
  test("applies defaults with only the database url", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.roles).toEqual([
      "api",
      "consumer",
      "outbox-publisher",
      "pending-reference-worker",
    ]);
    expect(config.sqs.wagerQueueName).toBe("wager-transactions.fifo");
    expect(config.aws.credentials).toBeUndefined();
  });

  test("parses a subset of roles", () => {
    expect(loadConfig({ ...base, ROLES: " api , consumer " }).roles).toEqual(["api", "consumer"]);
  });

  test.each([
    ["missing database url", {}],
    ["non-postgres database url", { DATABASE_URL: "mysql://x" }],
    ["unknown role", { ...base, ROLES: "api,cron" }],
    ["empty roles", { ...base, ROLES: " , " }],
    ["non-fifo queue name", { ...base, SQS_WAGER_QUEUE_NAME: "wager-transactions" }],
    ["invalid port", { ...base, PORT: "70000" }],
  ])("rejects %s", (_, env) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError);
  });
});
