import type { MikroORM } from "@mikro-orm/postgresql";
import type {
  TransactionOptions,
  TransactionScope,
  UnitOfWork,
} from "../../application/ports/unit-of-work.ts";
import { translatePersistenceError } from "./persistence-error-translator.ts";
import { createTransactionScope } from "./repositories/mikro-orm-repositories.ts";

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async transactional<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    try {
      // fork(): EntityManager e identity map exclusivos desta operação; o flush acontece no commit.
      return await this.orm.em.fork().transactional(async (em) => {
        if (options.lockTimeoutMs !== undefined) {
          const ms = Math.max(1, Math.trunc(options.lockTimeoutMs));
          await em.execute(`set local lock_timeout = ${ms}`);
        }
        return work(createTransactionScope(em));
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await work(createTransactionScope(this.orm.em.fork()));
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
