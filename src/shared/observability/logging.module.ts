import type { IncomingMessage, ServerResponse } from "node:http";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { AppConfig } from "../config/app-config.ts";
import { APP_CONFIG } from "../config/config.module.ts";
import { serializeError } from "./error-serializer.ts";
import { currentLogContext } from "./log-context.ts";

/**
 * Chaves que nunca devem aparecer em log (CHALLENGE §12: sem dados sensíveis nem payloads
 * financeiros completos). Os serializers já não registram corpo de requisição; a redaction é
 * a segunda barreira para logs estruturados escritos pela aplicação.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.money",
  "*.balance",
  "*.amount",
  "*.initialBalance",
  "*.payload",
  "*.body",
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          base: { service: "wagering", instanceId: config.instanceId },
          messageKey: "message",
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          formatters: { level: (label: string) => ({ level: label }) },
          mixin: () => ({ ...currentLogContext() }),
          redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
          genReqId: () => currentLogContext()?.correlationId ?? Bun.randomUUIDv7(),
          serializers: {
            req: (req: IncomingMessage) => ({ method: req.method, url: req.url }),
            res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
            err: serializeError,
          },
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              req.url === "/metrics" || (req.url ?? "").startsWith("/health"),
          },
          ...(config.env === "development"
            ? { transport: { target: "pino-pretty", options: { messageKey: "message" } } }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
