import { Controller, Get, Inject } from "@nestjs/common";
import type { AppConfig, Role } from "./shared/config/app-config.ts";
import { APP_CONFIG } from "./shared/config/config.module.ts";

export interface InstanceInfo {
  readonly service: "wagering";
  readonly instanceId: string;
  readonly roles: readonly Role[];
}

/** Identifica a réplica que atendeu: útil para ver o nginx balanceando entre as instâncias. */
@Controller()
export class AppController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  info(): InstanceInfo {
    return { service: "wagering", instanceId: this.config.instanceId, roles: this.config.roles };
  }
}
