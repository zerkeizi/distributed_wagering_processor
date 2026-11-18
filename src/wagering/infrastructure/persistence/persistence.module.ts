import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../../../shared/config/app-config.ts";
import { APP_CONFIG } from "../../../shared/config/config.module.ts";
import { CLOCK, SystemClock } from "../../application/ports/clock.ts";
import { ID_GENERATOR, UuidV7Generator } from "../../application/ports/id-generator.ts";
import { createOrmOptions } from "./mikro-orm.config.ts";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work.ts";

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

/**
 * O ORM conecta no boot. O schema NÃO é migrado aqui: as migrations rodam num passo separado
 * (serviço `migrate` do compose), para que N réplicas subindo juntas não disputem o DDL.
 */
@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        MikroORM.init(createOrmOptions({ databaseUrl: config.database.url })),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [MikroORM, UNIT_OF_WORK, CLOCK, ID_GENERATOR],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
