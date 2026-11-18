/**
 * Erro de regra de negócio com um código estável e legível por máquina (CHALLENGE §7.2).
 * Erros de programação (estado impossível, invariante quebrada) NÃO estendem esta classe:
 * eles não são caminho de negócio e devem chegar ao cliente como falha interna.
 */
export abstract class DomainError extends Error {
  protected constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Violação de invariante que o código deveria ter impedido: bug, não regra de negócio. */
export class InvariantViolationError extends Error {
  readonly code = "INTERNAL_INVARIANT_VIOLATION";

  constructor(message: string) {
    super(message);
    this.name = "InvariantViolationError";
  }
}
