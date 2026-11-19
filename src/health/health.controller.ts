import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { HealthService, type ReadinessReport } from "./health.service.ts";

/** Sem guard de autenticação, por exigência do CHALLENGE §2 e §9. */
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: o processo responde. Não toca dependências, para não reiniciar o container por falha alheia. */
  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: Postgres e SQS alcançáveis; 503 tira a instância do balanceamento. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== "ok") res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
