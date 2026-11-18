import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.ts";
import type { AppConfig } from "./shared/config/app-config.ts";
import { correlationMiddleware } from "./shared/observability/correlation.middleware.ts";

/** Monta a aplicação sem escutar porta: compartilhado entre `main.ts` e os testes de integração. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Antes de qualquer middleware de módulo, para que o log da requisição já tenha o correlationId.
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
