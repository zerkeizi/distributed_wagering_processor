export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol("ID_GENERATOR");

/** UUIDv7: ordenável no tempo, gerado na aplicação sem ida ao banco (ARCHITECTURE.md). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
