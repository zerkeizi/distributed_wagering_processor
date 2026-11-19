import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { WageringCoreModule } from "../../wagering-core.module.ts";
import { ApiExceptionFilter } from "./api-exception.filter.ts";
import { WageringController } from "./wagering.controller.ts";
import { WalletsController } from "./wallets.controller.ts";

/** Entrada HTTP: controllers e o mapeamento de erros (ADR 0010). */
@Module({
  imports: [WageringCoreModule],
  controllers: [WalletsController, WageringController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class WageringHttpModule {}
