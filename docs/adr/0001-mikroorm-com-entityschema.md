# MikroORM com mapeamento por EntitySchema

> Referência no README: §4 Stack — ORM; §6.0 Regra de modelagem; §6.1 Money ("o domínio não depende de tipos monetários do ORM nem de decorators do NestJS").

Usamos MikroORM (Unit of Work, `em.transactional()`, `LockMode`) em vez de TypeORM. As classes de domínio ficam puras: o mapeamento é feito por `EntitySchema` na camada de infraestrutura, e os repositórios convertem entre o modelo persistido e os agregados via `rehydrate`. Isso custa um pouco de código de conversão, mas mantém construtores privados, factories e invariantes intactos, sem decorators nem tipos do ORM no domínio.
