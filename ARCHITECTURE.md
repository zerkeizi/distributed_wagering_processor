# Arquitetura — Distributed Wagering Processor

> Enunciado do desafio: [`CHALLENGE.md`](CHALLENGE.md). Documento vivo. As decisões que custam caro para reverter estão em [`docs/adr/`](docs/adr/). O vocabulário de domínio está em [`GLOSSARY.md`](GLOSSARY.md).

## Índice de decisões (ADRs)

| ADR | Decisão | CHALLENGE |
|---|---|---|
| [0001](docs/adr/0001-mikroorm-com-entityschema.md) | MikroORM com `EntitySchema`, domínio puro | §4, §6.0 |
| [0002](docs/adr/0002-money-em-bigint-de-centavos.md) | `Money` como `bigint` de centavos; `NUMERIC(20,2)` no banco | §5.1, §6.1 |
| [0003](docs/adr/0003-lock-pessimista-por-wallet.md) | Lock pessimista por linha de wallet | §5, §8 |
| [0004](docs/adr/0004-processamento-http-sincrono.md) | HTTP síncrono, mesmo use case do SQS | §9, §10 |
| [0005](docs/adr/0005-autenticacao-adiada.md) | Autenticação adiada, ponto de extensão no-op | §2 |
| [0006](docs/adr/0006-um-reversal-por-alvo.md) | No máximo um reversal aplicado por alvo | §3, §7 |
| [0007](docs/adr/0007-wallet-invalida-nao-persiste.md) | Wallet inexistente ou divergente não persiste | §7, §10 |
| [0008](docs/adr/0008-escopo-de-idempotencia.md) | Unicidade por provider; algoritmo do `payloadHash` | §9 |
| [0009](docs/adr/0009-ledger-de-partida-simples-encadeado.md) | Ledger de partida simples, encadeado por versão | §6.4, §5.9 |
| [0010](docs/adr/0010-mapeamento-de-status-http.md) | Mapeamento de status HTTP | §9 |
| [0011](docs/adr/0011-failed-somente-para-transacoes-persistidas.md) | `FAILED` só para transações persistidas | §6.3 |
| [0012](docs/adr/0012-replay-de-estado-nao-terminal.md) | Reenvio de pendente tenta resolver a referência | §9, §7.1 |
| [0013](docs/adr/0013-outbox-com-claim-e-lease.md) | Outbox com claim `SKIP LOCKED` e lease | §11 |
| [0014](docs/adr/0014-classificacao-de-erros-no-consumer.md) | Classificação de erros no consumer SQS | §10 |
| [0015](docs/adr/0015-identidade-do-opening.md) | `OPENING` com provider reservado `__system__` | §6.3, §9 |
| [0016](docs/adr/0016-crash-points-para-testes.md) | Crash points nomeados para testes de falha | §13 |

## Layout do código

> CHALLENGE §14 (boundaries, portas, simplicidade)

```
src/
  wagering/
    domain/                 # Money, Wallet, WagerTransaction, WalletLedgerEntry, settle(), eventos — sem ORM/Nest
    application/            # use cases, TransactionSettler, portas (UnitOfWork, repositórios,
                            #   OutboxStore, EventPublisher, Clock, IdGenerator, WageringTelemetry)
    infrastructure/
      persistence/          # records + EntitySchema, mappers, migration, UnitOfWork, outbox store
      messaging/            # publisher SQS dos eventos
      observability/        # adapter da telemetria (prom-client + pino)
    interface/
      contracts.ts          # forma das entradas (zod), compartilhada por HTTP e SQS
      http/                 # controllers, filtro de erros (ADR 0010)
      sqs/                  # handler (decisão) + consumer (I/O com o SQS)
      workers/              # outbox publisher, worker de PENDING_REFERENCE
    wagering-core.module.ts # monta os use cases (sem decorators) para HTTP, SQS e workers
  shared/
    config/  observability/  auth/  domain/  messaging/  infrastructure/
    workers/                # laço de polling com parada limpa
    testing/                # crash points (ADR 0016)
  health/
  cli/migrate.ts
```

A dependência é sempre para dentro: `interface` → `application` → `domain`. `infrastructure` implementa as portas de `application`. O domínio não importa Nest, MikroORM nem SDKs.

## Identificadores e correlação

> CHALLENGE §6, §11, §12

- Os IDs internos (wallet, transaction, ledger entry, event) são UUIDv7 gerados na aplicação com `Bun.randomUUIDv7()`. `playerId` e `walletId` são validados como UUID. `providerId`, `externalTransactionId`, `roundId` e `gameId` são strings opacas com limite de tamanho.
- `correlationId`:
  - **HTTP:** vem do header `X-Correlation-Id`, ou é gerado se ausente;
  - **SQS:** vem do atributo de mensagem `correlationId`, ou usa o `messageId`;
  - fica persistido na wager transaction, e os eventos emitidos depois pelo worker de `PENDING_REFERENCE` o reutilizam.
- `causationId` dos eventos é o `transactionId` que os originou.

## Testes

> CHALLENGE §13

- `bun run test:unit` não usa containers. `test:integration` e `test:concurrency` exigem `docker compose up` (Postgres e LocalStack reais).
- Para o isolamento, cada teste cria as próprias wallets e providers com IDs aleatórios, sem truncar tabelas, e cada suíte usa um prefixo de fila próprio.
- A invariante `wallet.balance == saldo reconstruído pelo ledger` é verificada **automaticamente no fim de toda suíte** que toca o banco: `useTestDatabase` e o `close()` das apps de teste conferem, numa única query, todas as wallets criadas desde o início da suíte (saldo e encadeamento do ledger), e a suíte falha se alguma divergir. As duas wallets corrompidas de propósito (reconciliação com divergência, `FAILED` no worker) são marcadas com `markIntentionallyCorrupted`. Testes que precisam do estado no meio do caminho ainda chamam `assertLedgerConsistent` por conta própria.
- Os cenários de crash usam crash points (ADR 0016).
- Suítes que não podem enxergar o que outras deixaram para trás (outbox, multi-instância) usam um **banco próprio**, criado e migrado na hora e apagado no fim.

Onde está cada cenário de concorrência exigido (CHALLENGE §13):

| # | Cenário | Teste |
|---|---|---|
| 1 | mesma aposta 50× em paralelo | `test/concurrency/same-wallet.test.ts` (3 instâncias; o lock é disputado no Postgres) |
| 2 | disputa de saldo na mesma wallet (§8) | `test/concurrency/same-wallet.test.ts` (cada BET de 80 numa instância diferente) |
| 3 | wallets distintas em paralelo | `test/concurrency/distinct-wallets.test.ts` |
| 4 | ≥ 3 processos simultâneos | `test/concurrency/multi-instance.test.ts` (processos `bun src/main.ts` reais) |
| 5 | worker morto depois do commit e antes do ack | `multi-instance.test.ts` (crash point) |
| 6 | dois publishers sobre a mesma outbox | `test/integration/workers/relay-outbox.test.ts` + `multi-instance.test.ts` (crash do publisher) |
| 7 | ROLLBACK/REFUND antes da referência | `test/integration/workers/pending-reference.test.ts` + `multi-instance.test.ts` |
| 8 | reinício com consistência final | `multi-instance.test.ts` (SIGKILL + SIGTERM no meio da carga) |

Os testes de mesma wallet espalham as requisições entre **três instâncias** da app. A fila por wallet (`KeyedMutex`) serializa os pedidos dentro de uma instância, então com uma instância só o `FOR UPDATE` nunca seria disputado e os testes passariam mesmo sem ele. Com três, a disputa acontece no Postgres. Isso foi verificado por mutação: sem o `FOR UPDATE`, 5 dos 6 testes falham, enquanto a versão antiga, com uma instância, passava inteira.

Premissas da CHALLENGE §3 que também têm teste próprio:

| Premissa | Teste |
|---|---|
| processo morre **antes** do commit | `multi-instance.test.ts` (crash point `submit:before-commit`) |
| Postgres temporariamente indisponível | `test/integration/sqs/database-outage.test.ts` (queda real: 503 rápido no HTTP, consumer pausado, nada na DLQ, tudo aplicado na volta) |
| SQS temporariamente indisponível | verificado no compose: o HTTP segue aceitando, a outbox acumula e publica tudo na volta, e o consumer recua com backoff |

**Indisponibilidade no HTTP.** O pool de conexões tem timeout de conexão (`DATABASE_CONNECT_TIMEOUT_MS`, padrão 2 s), então um banco inalcançável vira `503 TEMPORARILY_UNAVAILABLE` rápido, em vez de deixar a requisição pendurada. O tradutor de erros reconhece como indisponibilidade:
- as classes SQLSTATE `08`, `53`, `57P01`–`57P03` e `58`;
- o `55000` "not currently accepting connections";
- os erros de rede;
- as mensagens de conexão derrubada do driver `pg`, que vêm sem código.

Tudo isso tem teste unitário. O nginx só tenta outra réplica quando a réplica não respondeu (`error`, `timeout`, `502`); um `503` da aplicação é resposta deliberada e vai direto ao cliente.

## Persistência e estratégia transacional

> CHALLENGE §4 ("a escolha, o mapeamento do `Money` e a estratégia transacional adotada devem ser justificados em `ARCHITECTURE.md`"); ADRs 0001, 0002, 0003

### Por que MikroORM

MikroORM 7, a opção preferencial do enunciado, pelos três recursos que este sistema usa de fato:

- **Unit of Work:** as mudanças registradas durante a operação viram SQL num único flush, no commit.
- **Identity Map:** dentro de uma operação, cada linha é carregada uma vez e as alterações são calculadas por diferença.
- **`em.transactional()` + `LockMode`:** dão a transação e o `SELECT … FOR UPDATE` da wallet sem SQL escrito à mão.

O domínio não depende do ORM (ADR 0001). As tabelas são mapeadas por `EntitySchema` para classes "record" simples (`records.ts`), e mappers convertem record ↔ agregado, usando `rehydrate` na leitura. Mapear os agregados diretamente obrigaria o ORM a preencher campos privados e a contornar construtores privados. O schema real vem de uma migration escrita à mão (CHECKs, índices parciais, triggers); os `EntitySchema` descrevem só colunas e tipos.

### Mapeamento do `Money`

| Camada | Representação |
|---|---|
| Domínio | `bigint` de centavos + código da moeda; nenhum `number` (ADR 0002) |
| Contrato (HTTP, SQS, eventos) | `{ "amount": "25.00", "currency": "BRL" }`, sempre com 2 casas |
| Banco | valor em `NUMERIC(20,2)`, moeda em `CHAR(3)`, **em colunas separadas** |
| ORM | o `NUMERIC` é lido e gravado como **string** (`"975.00"`), nunca como `number` |

A conversão fica nos mappers, e não num `Type` customizado do ORM, porque o valor e a moeda estão em colunas diferentes e um `Type` enxerga uma coluna só. Na leitura, o mapper reusa o parser estrito de `Money.from`: um valor fora do formato no banco faz a leitura falhar com erro claro, em vez de virar um saldo errado.

### Estratégia transacional

| Situação | Como |
|---|---|
| **Operação que altera saldo de wallet existente** (submissão, worker de pendentes) | `em.fork().transactional()` em `READ COMMITTED`. O **primeiro** comando é `SELECT … FOR UPDATE` na wallet (`LockMode.PESSIMISTIC_WRITE`, com `refresh` para ir ao banco mesmo se a linha já estiver no identity map), com `SET LOCAL lock_timeout` (`WALLET_LOCK_TIMEOUT_MS`). Transação, lançamento, saldo, outbox e inbox são registrados no Unit of Work e confirmados num único commit (ADR 0003). |
| **Abertura de wallet** | Uma transação com wallet, `OPENING`, lançamento e eventos. Não há linha para travar: duas criações simultâneas para o mesmo player e moeda são resolvidas pela constraint `UNIQUE (player_id, currency)`, e a perdedora recebe `409` (teste com 10 criações simultâneas). |
| **Ordem de locks** | Sempre wallet → transações. Submissão e worker de pendentes seguem a mesma ordem, então não há deadlock entre eles. |
| **Reconciliação** | `REPEATABLE READ` **read-only**: wallet e ledger lidos no mesmo snapshot, sem lock, sem travar a hot wallet. |
| **Consultas** (`GET`) | `EntityManager` próprio, sem transação explícita (cada query em autocommit). |
| **Isolamento entre operações** | Cada operação usa um `EntityManager` próprio (`fork()`); o global é proibido (`allowGlobalContext: false`). Identity maps nunca vazam entre requisições. |
| **Ordem dos `INSERT`s** | Os records não declaram relações, então o Unit of Work não ordena os `INSERT`s por dependência. Todas as FKs são `DEFERRABLE INITIALLY DEFERRED` e verificadas no commit, junto com a trigger que amarra o saldo ao último lançamento. |
| **Erros** | Exceções do driver são traduzidas na borda do Unit of Work para erros da aplicação (`UniqueViolationError` com o nome da constraint, `LockTimeoutError`, `PersistenceUnavailableError`). Os use cases não conhecem o MikroORM. |
| **Pool** | Até 10 conexões por instância, timeout de conexão de 2 s (`DATABASE_CONNECT_TIMEOUT_MS`), datas em UTC. |

**Onde o Unit of Work é contornado, de propósito:**

1. **Reagendar as pendentes que esperavam por uma transação** (`rescheduleWaitingOn`): é um `UPDATE` direto (`nativeUpdate`) dentro da mesma transação, porque essas linhas não foram carregadas no scope e carregá-las só para mudar um campo seria desperdício.
2. **Publisher da outbox:** cada passo (reservar, marcar publicado, agendar retry) é um único statement em autocommit. O claim é `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`. Nenhuma transação fica aberta enquanto o SQS responde (ADR 0013).
3. **Agregações da reconciliação:** a soma e a checagem de encadeamento são SQL com funções de janela, calculadas pelo Postgres num único passe, sem carregar o ledger inteiro na memória.

## Concorrência por wallet

> CHALLENGE §8 ("a estratégia… deve ser justificada em `ARCHITECTURE.md`"), §5.6–§5.8, §14 (lost updates, hot wallet, múltiplas instâncias, locks); ADR 0003

A unidade de concorrência é a `walletId`: operações da mesma wallet acontecem uma de cada vez; wallets diferentes nunca se esperam. São três camadas, cada uma com um papel:

| Camada | O que faz | Por que existe |
|---|---|---|
| **1. Fila por wallet na instância** (`KeyedMutex`) | antes de pedir conexão ao pool, a operação entra na fila em memória da sua wallet; só uma por wallet, por instância, segue para o banco | **isolamento**: sem ela, cada requisição de uma hot wallet segura uma conexão enquanto espera o lock, e uma única wallet esgota o pool e trava as outras. Não garante nada entre instâncias: é otimização |
| **2. Lock da linha da wallet** (`SELECT … FOR UPDATE` + `lock_timeout`) | serializa a mesma wallet **entre instâncias**; o saldo é lido já travado | **correção**: impede o read → calculate → update concorrente (§5.7) |
| **3. Schema** | `UNIQUE (wallet_id, wallet_version)`, encadeamento do ledger, `CHECK (balance >= 0)`, saldo ↔ ledger nos dois sentidos | **rede de segurança**: se um bug pular a camada 2, o banco ainda recusa o lost update (teste dedicado) |

**Alternativas consideradas** (detalhes no ADR 0003):

- **Lock otimista por `version` com retry.** Descartado. Numa hot wallet, cada commit invalida todas as tentativas concorrentes, e 50 apostas paralelas viram uma tempestade de retries com latência imprevisível. O lock pessimista transforma a disputa numa fila ordenada.
- **`UPDATE … SET balance = balance - x WHERE balance >= x`, atômico.** Correto para o débito isolado, mas o lançamento precisa de `balance_before`/`balance_after`, e as regras de reference (já revertida, mesma rodada…) precisam ser avaliadas com a wallet estável. Isso vira um lock de qualquer jeito, só que espalhado em SQL.
- **Ordenação do SQS FIFO por wallet como garantia.** Descartada: a §8 diz que recursos do broker são otimização, e o HTTP nem passa pela fila. O `MessageGroupId = walletId` é usado só para ordenar.
- **Lock global ou de tabela.** Proibido pela §5.6, e desnecessário: o lock é por linha.

**Esperas e erros:**

- A fila da instância e o lock no banco respeitam, cada um, `WALLET_LOCK_TIMEOUT_MS` (padrão 2 s). Estourou → `503 LOCK_TIMEOUT` com `Retry-After: 1` ("wallet ocupada, reenvie a mesma requisição").
- Se o **pool** da instância esgotar por sobrecarga geral, o banco está no ar: a resposta é `503 TEMPORARILY_UNAVAILABLE` ("sobrecarregado"), contada em `wagering_lock_conflicts_total{type="pool_exhausted"}`. Isso **não** pausa o consumer; o circuit breaker é só para queda do banco.

**Hot wallet, medido no compose (3 réplicas, valores padrão):**

| | Antes da fila por wallet | Depois |
|---|---|---|
| 200 apostas simultâneas na **mesma** wallet | 186 aplicadas, 14 × `503 TEMPORARILY_UNAVAILABLE` (código errado) | 101 aplicadas, 99 × `503 LOCK_TIMEOUT` (código certo) |
| **Outras** wallets durante a rajada | ~2 s, 3 de 5 falhando | 76–180 ms, todas aplicadas |
| Correção (lançamentos = sucessos, reconciliação) | ✅ | ✅ |

Operações da mesma wallet são sequenciais por definição; cada uma leva ~20 ms, então uma wallet sustenta ~50 operações por segundo. Uma rajada maior que isso dentro da janela de 2 s recebe `LOCK_TIMEOUT`: um sinal honesto de "esta wallet está ocupada", seguro de reenviar por causa da idempotência. Antes, o tempo extra que fazia mais requisições "caberem" vinha justamente de ocupar o pool e travar as demais wallets. Reduzir o custo por operação (menos idas ao banco por transação) aumentaria esse teto e é trabalho futuro.

## Schema: garantias aplicadas pelo banco

> CHALLENGE §5.9 ("unicidade, imutabilidade e não-negatividade… no schema do banco, não apenas em código de aplicação")

Migrations em `src/wagering/infrastructure/persistence/migrations/`: `…_initial` (schema) e `…_ledger_matches_wallet` (o lado "vice-versa" da garantia saldo ↔ ledger, adicionado depois da revisão da §5). Cada garantia abaixo tem um teste em `test/integration/persistence/constraints.test.ts` que tenta violá-la com SQL cru, e as principais também aparecem como sabotagem no `smoke:db`.

| Garantia | Mecanismo no Postgres |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet e no ledger |
| Toda alteração de saldo tem lançamento **e vice-versa** (§6.2) | duas constraint triggers **adiadas para o commit**, uma em cada tabela: quando a wallet muda (`wallet_matches_ledger_ck`) e quando entra um lançamento (`ledger_matches_wallet_ck`), a wallet precisa terminar a transação com o saldo e a versão do último lançamento |
| Sem lost update mesmo sem o lock da aplicação (§5.7) | `UNIQUE (wallet_id, wallet_version)` + encadeamento: um escritor que leu o saldo velho é recusado, mesmo que tente "pular" a versão (teste dedicado) |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Ledger encadeado e sem buracos | `UNIQUE (wallet_id, wallet_version)` + trigger que exige `balance_before` igual ao `balance_after` anterior |
| Um lançamento por transação | `UNIQUE (transaction_id)` |
| Lançamento/transação na moeda e player da wallet | FKs compostas `(wallet_id, currency)` e `(wallet_id, player_id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Um reversal por alvo (ADR 0006) | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| `PENDING` nunca commitado (ADR 0004) | `CHECK` de status sem `PENDING` |
| Estado terminal não muda; campos de negócio imutáveis | trigger `wager_transaction_guard` |
| Coerência status ↔ campos | `CHECK`s (por exemplo, `REJECTED`/`FAILED` exigem `failure_code`; `PENDING_REFERENCE` exige `next_resolution_at`) |
| Dedup do inbox | `PRIMARY KEY (consumer_name, message_id)` |

Todas as FKs são `DEFERRABLE INITIALLY DEFERRED`. Wallet, transação `OPENING` e lançamento nascem no mesmo commit, e o Unit of Work não precisa ordenar os `INSERT`s pelas dependências.

As migrations rodam num passo separado (serviço `migrate` do compose, `bun run migration:up`), nunca no boot da aplicação: 3 réplicas subindo juntas não disputam o DDL.

## Taxonomia de `failureCode`

> CHALLENGE §7.2

Há dois conjuntos de códigos, separados também no tipo (`src/wagering/domain/failure-code.ts` e `error-code.ts`), para que o compilador impeça um erro de requisição de ser gravado como resultado de transação.

**`FailureCode`: resultado de uma transação que não foi aplicada.** É gravado em `failure_code`, devolvido no corpo do `422` e nos eventos.

| Classe | Códigos | Ação do provider |
|---|---|---|
| Rejeição de negócio (`REJECTED`, terminal) | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH` | Desistir; um reenvio devolve o mesmo resultado |
| Falha interna (`FAILED`, terminal) | `INTERNAL_INVARIANT_VIOLATION` | Escalar para suporte (ADR 0011) |

**`ErrorCode`: erro da requisição.** Nada é persistido como transação; vem no envelope `error.code`.

| Classe | Códigos | Status | Ação do provider |
|---|---|---|---|
| Corrigir a requisição | `INVALID_PAYLOAD`, `UNSUPPORTED_KIND`, `REFERENCE_REQUIRED`, `PAYLOAD_TOO_LARGE` | `400`/`413` | Corrigir os dados; reenviar igual dá o mesmo erro |
| Wallet não serve | `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH` | `422` | Corrigir wallet, player ou moeda |
| Não encontrado / já existe | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND`, `WALLET_ALREADY_EXISTS` | `404`/`409` | Corrigir o identificador |
| Conflito de idempotência | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_ID_CONFLICT` | `409` | Não é replay: usar outra key ou corrigir o payload |
| Autorização | `FORBIDDEN` | `403` | Inativo enquanto não houver IdP (ADR 0005) |
| Transitória | `TEMPORARILY_UNAVAILABLE`, `LOCK_TIMEOUT` | `503` + `Retry-After` | Reenviar a **mesma** requisição (mesma `Idempotency-Key`) |
| Bug | `INTERNAL_ERROR` | `500` | Escalar; sem detalhes na resposta |

`LOCK_TIMEOUT` e `TEMPORARILY_UNAVAILABLE` pedem a mesma ação ao provider, mas ficam separados porque, para quem opera, são alertas diferentes: wallet muito disputada versus banco fora do ar. Cada código de rejeição corresponde a uma regra distinta do CHALLENGE §7, então a granularidade custa pouco e ajuda o diagnóstico.

**Envelope de erro HTTP** (igual em todos os endpoints):

```json
{ "error": { "code": "INVALID_PAYLOAD", "message": "invalid body",
             "details": [{ "path": "initialBalance.amount", "message": "..." }],
             "correlationId": "..." } }
```

- `details` só aparece em erro de validação.
- Status de cada código: tabela acima e ADR 0010.

## Interpretações adicionais das regras de negócio

> CHALLENGE §7 ("Qualquer interpretação adicional adotada deve ser documentada")

- **`LOSS` aceita `0.00`**: ela só registra o resultado. Todos os outros kinds exigem valor > 0.
- **`BET` não pode ter referência.** `WIN` e `LOSS` podem referenciar uma `BET`; nesse caso valem as mesmas validações de pertencimento e o alvo precisa ser uma `BET` não revertida (ADR 0006).
- **Uma transação não pode referenciar a si mesma** (`INVALID_PAYLOAD`).
- **Reference que ainda aguarda a própria reference** (por exemplo, `ROLLBACK` de um `REFUND` que está em `PENDING_REFERENCE`): a transação continua esperando, em vez de ser rejeitada, e cada espera conta como tentativa. Uma reference `REJECTED` ou `FAILED` leva a `REFERENCE_NOT_PROCESSED`.
- **Ordem das validações da reference:** pertencimento (provider, player, wallet, moeda, round) → kind permitido → estado → valor igual (só reversals) → já revertida. Assim, uma reference de outra wallet nunca revela detalhes sobre o estado dela.
- **Reference de outro provider não existe para quem pergunta.** A regra 2 manda resolver a reference por `(providerId, referenceExternalTransactionId)`, então uma transação de outro provider não é encontrada; não é "encontrada e diferente". Por isso o resultado não é `REFERENCE_MISMATCH` imediato: a transação fica `PENDING_REFERENCE` e, esgotadas as tentativas (~18,5 min), vira `REFERENCE_NOT_FOUND`. Um provider nunca consegue nem confirmar que um id externo de outro provider existe.
- **`WIN` é livre em valor e em quantidade.** O valor do prêmio não tem relação obrigatória com o da `BET` (só reversals exigem valor igual), e vários `WIN`s podem referenciar a mesma `BET` (rodadas com bônus, prêmios parciais). Cada `WIN` tem a própria idempotency key, então o mesmo `WIN` reenviado continua sendo replay.
- **Replay de transação pendente mostra o saldo atual.** A regra 7 ("devolve o resultado original, incluindo o saldo observado") vale para transações terminadas, que guardam o saldo no momento em que terminaram. Uma `PENDING_REFERENCE` ainda não terminou: o reenvio responde `202` com o saldo da wallet naquele instante.
- **Um `REFUND` desfeito não libera um novo `REFUND`.** Na sequência `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a aposta volta a estar debitada, mas um segundo `REFUND` da mesma `BET` é recusado com `REFERENCE_ALREADY_REVERSED`. A `BET` já foi alvo de um reversal aplicado, e é isso que conta (ADR 0006). Para devolver de novo, o provider desfaz a reversão errada; ele não pode empilhar reversões.
- **`REFUND`/`ROLLBACK` de uma `BET` que já foi liquidada (tem `WIN` ou `LOSS`) é aceito, e a responsabilidade é do provider.** As regras pedem só que a `BET` esteja `PROCESSED` e não revertida, e o enunciado não proíbe devolver uma aposta liquidada. O efeito é que o jogador recebe a aposta de volta e o prêmio continua com ele. Quem sabe se isso é correto (rodada anulada por erro do jogo, por exemplo) é o provider, que também é quem deve mandar o `ROLLBACK` do `WIN`, se for o caso. O sistema garante que cada movimento seja aplicado uma vez só e que o saldo nunca fique negativo, mas não interpreta a semântica da rodada.
- **`aggregateId` dos eventos é sempre o `walletId`**, inclusive nos eventos de transação. A wallet é a unidade de concorrência e de ordenação (`MessageGroupId`), então os eventos de uma wallet saem na ordem em que aconteceram.
- **`WagerTransactionPendingReference` é emitido uma única vez**, na entrada em `PENDING_REFERENCE`. As novas tentativas do worker não geram evento.

## Ciclo de vida da WagerTransaction

> CHALLENGE §6.3 ("Defina e documente as transições válidas"); ADRs 0004, 0011, 0012

```
                 ┌──────────────▶ PROCESSED  ─┐
                 │                            │
   (create) ─▶ PENDING ─────────▶ REJECTED   ├─ terminais: nada sai daqui
                 │                            │
                 ├──────────────▶ FAILED     ─┘   (só em teoria a partir de PENDING; ver abaixo)
                 │                  ▲
                 ▼                  │
          PENDING_REFERENCE ────────┤──▶ PROCESSED
             │      ▲               └──▶ REJECTED
             └──────┘ nova tentativa agendada
```

`PENDING` existe **só em memória**: a transação nasce, é aplicada e muda de estado dentro da mesma transação SQL, e o banco nem aceita gravar `PENDING` (ADR 0004). Todo estado persistido é um dos outros quatro.

| De → Para | Quando | Quem dispara | Evento na outbox |
|---|---|---|---|
| — → `PENDING` | `WagerTransaction.create` (provider) ou `createOpening` (abertura de wallet) | submissão HTTP/SQS, `CreateWallet` | — |
| `PENDING` → `PROCESSED` | regras ok; saldo e ledger aplicados (ou `LOSS`, sem mover saldo) | submissão | `WagerTransactionProcessed` + `WalletBalanceChanged` (se o saldo mudou) |
| `PENDING` → `REJECTED` | regra de negócio falhou (saldo insuficiente, reference inválida, valor diferente…) | submissão | `WagerTransactionRejected` |
| `PENDING` → `PENDING_REFERENCE` | a reference ainda não existe (ou ela mesma está esperando a dela) | submissão | `WagerTransactionPendingReference` (só nesta entrada) |
| `PENDING_REFERENCE` → `PENDING_REFERENCE` | o worker tentou e a reference continua ausente: `resolutionAttempts + 1` e nova data com backoff | worker | — (sem ruído a cada tentativa) |
| `PENDING_REFERENCE` → `PROCESSED` | a reference chegou e é válida | worker, ou reenvio do provider (ADR 0012) | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PENDING_REFERENCE` → `REJECTED` | a reference chegou mas é inválida, **ou** as tentativas acabaram (`REFERENCE_NOT_FOUND`) | worker, ou reenvio | `WagerTransactionRejected` |
| `PENDING_REFERENCE` → `FAILED` | erro permanente que não é de negócio ao reprocessar (ex.: o banco recusa o lançamento porque o ledger foi corrompido) | worker, numa transação separada | — (log `error` + métrica; ADR 0011) |
| `PROCESSED`/`REJECTED`/`FAILED` → qualquer | **proibido** | — | — |

**Regras que acompanham as transições:**

- **Reenvio de uma pendente cuja reference ainda não chegou não muda nada:** não conta tentativa, não remarca data, não emite evento (ADR 0012).
- **Quando uma transação termina** (`PROCESSED` ou `REJECTED`), as pendentes que esperavam por ela têm a próxima tentativa antecipada para agora, na mesma transação SQL.
- **`PENDING` → `FAILED`** é permitido pelo modelo, mas não acontece na prática: com processamento síncrono, uma falha antes do commit desfaz tudo e não sobra transação para marcar (ADR 0011).

**Quem impõe:**

| Garantia | Domínio | Banco |
|---|---|---|
| Terminais não mudam | `InvalidTransactionStateError` em `markProcessed`, `markPendingReference`, `reject` e `fail` (matriz 3 × 4 testada) | trigger `wager_transaction_guard` recusa qualquer `UPDATE` em linha terminal |
| `PENDING` nunca persistido | — | `CHECK` de status sem `PENDING` |
| Campos de negócio imutáveis | propriedades `readonly` | a mesma trigger recusa mudanças de valor, kind, wallet, reference etc., mesmo antes do estado terminal |
| Código certo para cada estado | `reject` só aceita rejeição de negócio; `fail` só `INTERNAL_INVARIANT_VIOLATION` (no tipo, desde a separação `FailureCode`/`ErrorCode`) | `CHECK`s: `REJECTED`/`FAILED` exigem `failure_code`; `PROCESSED` exige `processed_at`; `PENDING_REFERENCE` exige `next_resolution_at` |

## Submissão de wager transactions

> CHALLENGE §9 Submeter transação, §10 ("o mesmo use case da entrada HTTP"); ADRs 0003, 0004, 0007, 0008, 0010, 0012

`SubmitWagerTransaction` atende HTTP e SQS. Numa única transação SQL, com `lock_timeout` (`WALLET_LOCK_TIMEOUT_MS`, padrão 2 s):

1. Valida o contrato e calcula o `payloadHash` **antes** de tocar no banco.
2. Faz `SELECT … FOR UPDATE` na wallet. Wallet inexistente ou divergente é recusada sem persistir nada.
3. Busca por `(providerId, idempotencyKey)`:
   - hash igual → replay;
   - hash diferente → `409 IDEMPOTENCY_KEY_CONFLICT`.

   Sem resultado, busca por `(providerId, externalTransactionId)`; se encontrar → `409 EXTERNAL_ID_CONFLICT`.
4. Resolve a reference, aplica `settle()` e grava transação, lançamento, saldo, eventos na outbox e, via SQS, o registro de inbox.
5. Se a transação terminou (`PROCESSED`/`REJECTED`), reagenda para agora as `PENDING_REFERENCE` que esperavam por ela.

Como o lock vem antes da busca de idempotência, reenvios para a **mesma wallet** se serializam e nunca disputam o `INSERT`. Reenvios com a mesma key para **wallets diferentes** podem disputar; nesse caso a constraint única barra o segundo no commit e o use case repete uma vez, caindo no caminho normal (replay ou conflito, nunca `500`). Um teste de concorrência exercita exatamente esse caso.

**Reenvio de pendente:** se a reference ainda não existe, a resposta é `202` e **nada muda**: reenvios do provider não consomem as tentativas do worker (ADR 0012). Se a reference já chegou, a transação é resolvida no próprio reenvio.

**Status por resultado:**

| Resultado | Status |
|---|---|
| aplicada agora (nova, ou pendente resolvida no reenvio) | `201` |
| replay de `PROCESSED` | `200` |
| `PENDING_REFERENCE` | `202` |
| `REJECTED` (novo ou replay) | `422`, com o corpo completo |
| `FAILED` | `500` |

O corpo é sempre `{ transactionId, status, balance, failureCode, idempotentReplay }`, e `balance` é o saldo observado quando a transação terminou.

## Consumer SQS

> CHALLENGE §10; ADR 0014

O consumer roda em toda instância com o papel `consumer`. Ele faz long polling em `wager-transactions.fifo` e chama o **mesmo** `SubmitWagerTransaction` do HTTP, passando o registro de inbox para ser gravado na mesma transação SQL. A decisão sobre cada mensagem (`WagerMessageHandler`) fica separada do I/O com o SQS (`WagerTransactionConsumer`). O ack (`DeleteMessage`) só acontece depois que o handler devolve, ou seja, depois do commit.

| Situação | Destino | Inbox |
|---|---|---|
| Processada (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay) | ack | gravado na transação do efeito |
| `messageId` já no inbox com o mesmo conteúdo | ack (duplicata) | — |
| Erro de negócio sem persistência: `WALLET_NOT_FOUND`, `*_MISMATCH`, conflitos de idempotência | ack | gravado à parte (ADR 0007) |
| JSON ou schema inválido, `INVALID_PAYLOAD`, `UNSUPPORTED_KIND` (ex.: `OPENING`), `REFERENCE_REQUIRED` | **DLQ na hora**, com `deadLetterReason` | — |
| `messageId` já no inbox com **outro** conteúdo | **DLQ na hora** (`message_id_reused`) | — |
| `LOCK_TIMEOUT`, banco indisponível | retry: `ChangeMessageVisibility` com backoff por `ApproximateReceiveCount` (`SQS_RETRY_BASE_MS`…`SQS_RETRY_MAX_MS`) | — |
| Erro inesperado (bug) | retry; se persistir, o redrive do SQS (`maxReceiveCount = 5`) leva para a DLQ | — |

- **Banco indisponível → circuit breaker:** o consumer para de receber mensagens e só sonda o banco até ele voltar, em vez de gastar as entregas de cada mensagem e mandá-las para a DLQ (ADR 0014, atualização). Enquanto isso, `wagering_consumer_paused = 1`.
- **Hash do inbox:** SHA-256 do JSON canônico de `{type, data}`. O `occurredAt` fica de fora por ser metadado de transporte.
- **Ordem:** mensagens do mesmo `MessageGroupId` (a wallet) são processadas em sequência, e grupos diferentes em paralelo. Se uma mensagem do grupo precisa de retry, as seguintes do mesmo lote esperam junto, para não passarem na frente. Essa ordem é otimização; a correção vem do lock e do inbox.
- **Correlação:** atributo de mensagem `correlationId` ou, na falta dele, o `messageId`. O valor fica persistido na transação.
- **`SIGTERM`** (`enableShutdownHooks`): o consumer para de receber (aborta o long polling) e espera as mensagens em andamento até `SHUTDOWN_GRACE_MS` (padrão 10 s). O que não terminou volta para a fila com visibilidade 0, para outra instância pegar na hora. O compose dá `stop_grace_period: 20s`, maior que o prazo da aplicação. Se uma mensagem devolvida chegar a confirmar depois, a reentrega cai no inbox e não repete o efeito.
- **Métricas:** `wagering_dlq_messages_total{reason}` conta o que o consumer mandou explicitamente para a DLQ. `wagering_dlq_depth` (amostrado a cada 15 s) mostra a profundidade real, incluindo o que o redrive do SQS moveu sozinho. Também `wagering_retries_total{component="sqs_consumer"}` e `wagering_duplicates_detected_total{source="inbox"}`.

## Referências fora de ordem

> CHALLENGE §7.1

- O backoff exponencial começa em 2s, dobra a cada tentativa, tem teto de 5 min e para em **10 novas tentativas** depois da primeira (cerca de 18,5 min no total; `ReferenceResolutionPolicy.default()`). Esse prazo cobre atrasos normais de entrega e redelivery do provider sem deixar transações pendentes por tempo indefinido. Todos os parâmetros são configuráveis por env (os testes usam milissegundos).
- **Worker** (`ResolvePendingReferences`, papel `pending-reference-worker`):
  - lê as pendentes vencidas sem lock;
  - para cada uma, numa transação: trava a **wallet**, relê a transação e aplica as mesmas regras da submissão (`TransactionSettler`, compartilhado).

  A ordem de lock é a mesma da submissão (wallet → transação), então worker e submissão nunca entram em deadlock. Várias instâncias podem rodar o worker: se duas olham a mesma pendente, a segunda espera o lock, relê, vê que ela já foi tratada (ou ainda não venceu) e segue.
- Há um gatilho imediato: quando uma wager transaction termina (`PROCESSED`/`REJECTED`), a mesma transação SQL antecipa para agora o `next_resolution_at` das `PENDING_REFERENCE` que esperam por ela. Em produção, o worker resolve em menos de 1 s (no `smoke:events`, ~200–400 ms).
- Esgotadas as tentativas: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`. `WagerTransactionPendingReference` é emitido só na entrada em espera, não a cada nova tentativa.
- **Erro permanente que não é de negócio** (por exemplo, o banco recusa o lançamento porque o encadeamento do ledger foi corrompido): a transação vira `FAILED` com `INTERNAL_INVARIANT_VIOLATION`, numa transação separada, com log `error` (ADR 0011). Erros transitórios (lock, banco fora do ar) só deixam a pendente para a próxima rodada.

## Outbox publisher

> CHALLENGE §11; ADR 0013

Papel `outbox-publisher`; várias instâncias podem rodar juntas.

- **A cada rodada** (`OUTBOX_POLL_INTERVAL_MS`, padrão 500 ms; sem espera quando o lote veio cheio):
  1. **claim** de até `OUTBOX_BATCH_SIZE` eventos pendentes e vencidos, com `SKIP LOCKED` e lease de `OUTBOX_LEASE_MS` (padrão 30 s);
  2. **publish** em `wagering-events.fifo`, com `MessageGroupId = aggregateId` (wallet) e `MessageDeduplicationId = eventId`;
  3. **marcar** `published_at`.
- **Falha no publish:** `scheduleRetry` (backoff `OUTBOX_RETRY_BASE_MS`…`OUTBOX_RETRY_MAX_MS`, **sem limite de tentativas**) e a reserva é liberada.
- **Publisher que morre** entre publicar e marcar: depois do lease, outro republica. Garantia at-least-once, com deduplicação pelo `eventId`.
- **Métricas:** `wagering_outbox_pending_events`, `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo) e `wagering_retries_total{component="outbox_publisher"}`.
- **Shutdown:** no `SIGTERM`, os dois workers terminam a rodada em andamento antes de o pool de conexões fechar.

## Topologia

> CHALLENGE §8, §13 (≥ 3 instâncias)

Uma única imagem, com papéis ligados por env (`ROLES`): `api`, `consumer`, `outbox-publisher` e `pending-reference-worker`, todos ativos por padrão. O servidor HTTP sobe sempre, para health e métricas; os papéis ligam os controllers de negócio e os laços de fundo.

No Docker Compose:
- o serviço `migrate` aplica o schema uma vez e termina;
- só então sobem 3 réplicas `app`, atrás de um nginx (`:8080`, cache de DNS de 2 s para acompanhar réplicas recriadas);
- `stop_grace_period: 20s` dá folga ao `SHUTDOWN_GRACE_MS` da aplicação.

Nos testes de concorrência, 3 processos `bun src/main.ts` separados (via `Bun.spawn`) rodam contra o Postgres e o LocalStack reais, com crashes e reinícios.

## Observabilidade

> CHALLENGE §12

- Logs JSON com `nestjs-pino`, `correlationId` propagado por AsyncLocalStorage e redaction de valores e payloads financeiros.
- Erros passam por um serializer próprio (`error-serializer.ts`): o Postgres devolve a linha inteira que violou uma constraint (`Failing row contains (…, BRL, -987.65, …)`) em `detail` e, via MikroORM, também na `message`. Só campos de diagnóstico de uma allowlist (`code`, `constraint`, `table`…) saem no log, e `message`/`stack` são higienizados, inclusive nas causas. Testado com erros reais do banco (`test/integration/persistence/error-logging.test.ts`).
- `GET /metrics` com `prom-client`:

  | Métrica | Mede |
  |---|---|
  | `wagering_transactions_total{kind,status,channel}` | transações por status e canal |
  | `wagering_duplicates_detected_total{source}` | replays por idempotency key e duplicatas absorvidas pelo inbox |
  | `wagering_idempotency_conflicts_total{code}` | conflitos de idempotência |
  | `wagering_retries_total{component}` | retries no consumer, no publisher e no worker |
  | `wagering_dlq_messages_total{reason}` e `wagering_dlq_depth` | mensagens em DLQ |
  | `wagering_lock_conflicts_total{type}` | conflitos de lock (`lock_timeout`) e pool esgotado (`pool_exhausted`) |
  | `wagering_consumer_paused` | 1 enquanto o consumer espera o banco voltar |
  | `wagering_outbox_lag_seconds` e `wagering_outbox_pending_events` | outbox lag |
  | `wagering_processing_duration_seconds{channel,outcome}` | latência de processamento (histograma) |
  | `wagering_reconciliation_divergences_total` | divergências de reconciliação |
- `GET /health/live` e `GET /health/ready` (Postgres e SQS), sem autenticação.
- **Métricas são por instância:** cada réplica expõe o próprio `/metrics`. Em produção, o Prometheus coleta cada instância diretamente (service discovery), e não pelo load balancer; no compose, um `GET /metrics` pelo nginx mostra só a réplica que atendeu.
- **Qual réplica atendeu** fica só nos logs internos: toda linha traz `instanceId`, junto com `correlationId`, `transactionId` e `walletId`. Nenhum identificador de instância é exposto na resposta HTTP. Para investigar um problema, o provider informa o `transactionId` ou o `X-Correlation-Id` (que ele pode enviar e recebe de volta), e o resto se encontra nos logs.

## Reconciliação

> CHALLENGE §9 Reconciliação

A reconciliação lê a wallet e o ledger num snapshot `REPEATABLE READ`, sem lock, para não travar a hot wallet. Ela soma o ledger e também valida o encadeamento: cada `balance_before` é igual ao `balance_after` anterior, e as versões não têm buracos. A soma e a checagem são feitas pelo próprio Postgres, num único passe com funções de janela, sem trazer o ledger inteiro para a aplicação.

Anomalias reportadas:

| Anomalia | Significado |
|---|---|
| `BALANCE_MISMATCH` | saldo armazenado ≠ soma com sinal do ledger |
| `LAST_ENTRY_MISMATCH` | saldo armazenado ≠ `balance_after` do último lançamento |
| `VERSION_MISMATCH` | `version` da wallet ≠ versão do último lançamento |
| `VERSION_GAP` / `BALANCE_DISCONTINUITY` / `FIRST_ENTRY_NOT_FROM_ZERO` | quebra no encadeamento do ledger (até 20 são listadas) |

Divergências são logadas (`warn`, com o `walletId`, a diferença e os tipos de anomalia, sem saldos completos), contadas em `wagering_reconciliation_divergences_total` e retornadas com `consistent: false`. Nada é corrigido automaticamente. Com as triggers do schema, uma divergência só aparece se alguém passar por cima delas (por exemplo, um superusuário com `session_replication_role = replica`, que é como o teste simula a corrupção).

O extrato (`GET /wallets/:id/ledger`) vai do mais recente para o mais antigo, com `limit` de 1 a 200 (padrão 50) e cursor opaco (base64url de `{walletId, walletVersion}`). O cursor é estável porque o ledger é append-only e ordenado por versão: lançamentos novos entram no topo e nunca deslocam as páginas seguintes. Um cursor de outra wallet é recusado.

## Limitações

- Escala monetária fixa em 2 casas para todas as moedas (ADR 0002).
- Ledger de partida simples, sem double-entry (ADR 0009).
- Autenticação não implementada (ADR 0005).
- Recusas por wallet inexistente ou divergente não ficam na tabela de wager transactions (ADR 0007).
- **Sem retenção para inbox e outbox.** Linhas processadas e publicadas ficam para sempre. Em produção, faltaria um job de limpeza (por exemplo, apagar o que tem mais de N dias) ou particionamento por data.
- **Ordem de eventos entre publishers é melhor esforço**, e a deduplicação do SQS FIFO vale só 5 min: os consumidores precisam deduplicar por `eventId` e ordenar por `walletVersion` (ADR 0013).
- **Sem ferramenta de reprocessamento da DLQ.** Mensagens na DLQ ficam lá, com o motivo no atributo `deadLetterReason`, para análise manual.
- **`FAILED` não emite evento de integração.** Ele é raro (exige estado corrompido), e o alerta vem do log `error` e da métrica.
- **Métricas são por instância.** Não há agregação no próprio serviço; isso é papel do Prometheus.
- **Rodou só contra o LocalStack.** O comportamento do SQS real (por exemplo, a janela de deduplicação e o tempo de redrive) foi assumido a partir da documentação da AWS, não medido.

## Trabalho futuro

- **Teste de carga (`bun run test:load`)**: fora do escopo desta entrega (CHALLENGE §14, diferenciais opcionais). O plano seria um script Bun próprio com uma mistura de hot wallet e wallets distribuídas contra 3 réplicas, medindo throughput, p50/p95/p99, taxa de erro, lock timeouts e outbox lag, com ambiente e metodologia documentados.
- Integração com IdP (Keycloak, client-credentials por provider), conforme o ADR 0005.
- Reduzir as idas ao banco por operação (por exemplo, buscar idempotency key e id externo numa só query) para aumentar o teto de operações por segundo de uma hot wallet.
- Double-entry ledger com contas de contrapartida.
