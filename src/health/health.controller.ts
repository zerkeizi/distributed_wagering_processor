import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { HealthService, type ReadinessReport } from "./health.service.ts";

/** Sem guard de autenticação, por exigência do README §2 e §9. */
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
  async ready(): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== "ok") {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
