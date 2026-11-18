# MikroORM com mapeamento por EntitySchema

> Referência no CHALLENGE: §4 Stack — ORM; §6.0 Regra de modelagem; §6.1 Money ("o domínio não depende de tipos monetários do ORM nem de decorators do NestJS").

Usamos MikroORM (Unit of Work, `em.transactional()`, `LockMode`) em vez de TypeORM. As classes de domínio ficam puras: o mapeamento é feito por `EntitySchema` na camada de infraestrutura, e os repositórios convertem entre o modelo persistido e os agregados via `rehydrate`. Isso custa um pouco de código de conversão, mas mantém construtores privados, factories e invariantes intactos, sem decorators nem tipos do ORM no domínio.

## Consequences

- **O `EntitySchema` mapeia _records_, não os agregados.** Cada tabela tem uma classe simples (`WalletRecord`, `WagerTransactionRecord`…) em `infrastructure/persistence/records.ts`, e os mappers convertem record ↔ agregado. Mapear direto as classes de domínio obrigaria o ORM a hidratar campos privados (`_balance`) e a contornar construtores privados.
- **`Money` é convertido no mapper, não por um `Type` customizado do ORM.** O valor (`NUMERIC(20,2)`, lido como string) e a moeda ficam em colunas separadas, e um `Type` só enxerga uma coluna por vez. O mapper reusa o parser estrito de `Money.from`, então um valor corrompido no banco faz a leitura falhar com erro claro, em vez de virar um saldo errado.
- **A migration é escrita à mão** (SQL com CHECKs, índices parciais e triggers), registrada por lista explícita (`migrationsList`) e sem snapshot ou diff automático. Os `EntitySchema` descrevem só colunas e tipos para o Unit of Work; a fonte da verdade do schema é a migration.
- **MikroORM 7.** Esta versão não usa mais knex; as APIs usadas (`em.fork().transactional()`, `LockMode.PESSIMISTIC_WRITE`, `Migrator`) foram verificadas contra os tipos instalados.
