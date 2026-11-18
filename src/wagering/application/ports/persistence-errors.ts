/**
 * Erros de infraestrutura já traduzidos para o vocabulário da aplicação, para que os use cases
 * não dependam de exceções do MikroORM ou do driver.
 */

/** Violação de unicidade; `constraint` é o nome definido na migration. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique constraint violated: ${constraint ?? "unknown"}`, options);
    this.name = "UniqueViolationError";
  }
}

/** Não conseguiu o lock da wallet dentro do `lock_timeout`: transitório, pode reenviar. */
export class LockTimeoutError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("timed out waiting for a row lock", options);
    this.name = "LockTimeoutError";
  }
}

/** Banco indisponível ou conexão perdida: transitório. */
export class PersistenceUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("database unavailable", options);
    this.name = "PersistenceUnavailableError";
  }
}
