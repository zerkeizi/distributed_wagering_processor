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
    domain/          # Money, Wallet, WagerTransaction, WalletLedgerEntry, eventos — sem ORM/Nest
    application/     # use cases + portas (repositórios, publisher, clock, id generator)
    infrastructure/  # adapters MikroORM (EntitySchema), SQS, migrations
    interface/       # controllers HTTP, consumer SQS, workers
  shared/            # IntegrationEvent base, observabilidade
  health/
```

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
- Todos os testes terminam verificando `wallet.balance == saldo reconstruído pelo ledger` por meio de um helper comum.
- Os cenários de crash usam crash points (ADR 0016).

## Schema: garantias aplicadas pelo banco

> CHALLENGE §5.9 ("unicidade, imutabilidade e não-negatividade… no schema do banco, não apenas em código de aplicação")

Migration: `src/wagering/infrastructure/persistence/migrations/Migration20261118000000_initial.ts`. Cada garantia abaixo tem um teste em `test/integration/persistence/constraints.test.ts` que tenta violá-la com SQL cru.

| Garantia | Mecanismo no Postgres |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet e no ledger |
| Toda alteração de saldo tem lançamento | constraint trigger **adiada para o commit** (`wallet_matches_ledger`): o saldo e a versão da wallet precisam bater com o último lançamento |
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

| Classe | Códigos | Ação do provider |
|---|---|---|
| Corrigir o payload | `INVALID_PAYLOAD`, `UNSUPPORTED_KIND`, `REFERENCE_REQUIRED`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `WALLET_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `TRANSACTION_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_ID_CONFLICT` | Não reenviar igual; corrigir os dados ou a chave |
| Rejeição de negócio (terminal) | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH` | Desistir; um reenvio devolve o mesmo resultado |
| Transitória | `TEMPORARILY_UNAVAILABLE`, `LOCK_TIMEOUT` | Reenviar a mesma requisição (com a mesma idempotency key) |
| Falha interna (terminal) | `INTERNAL_INVARIANT_VIOLATION` | Escalar para suporte; ver ADR 0011 |

**Envelope de erro HTTP** (igual em todos os endpoints):

```json
{ "error": { "code": "INVALID_PAYLOAD", "message": "invalid body",
             "details": [{ "path": "initialBalance.amount", "message": "..." }],
             "correlationId": "..." } }
```

- `details` só aparece em erro de validação.
- Respostas `503` trazem `Retry-After`.
- Erros que não estão no mapeamento (bugs) viram `500 INTERNAL_ERROR`, sem detalhes na resposta; o stack fica só no log.
- Status de cada código: ADR 0010. `WALLET_ALREADY_EXISTS` → `409`.

## Interpretações adicionais das regras de negócio

> CHALLENGE §7 ("Qualquer interpretação adicional adotada deve ser documentada")

- **`LOSS` aceita `0.00`**: ela só registra o resultado. Todos os outros kinds exigem valor > 0.
- **`BET` não pode ter referência.** `WIN` e `LOSS` podem referenciar uma `BET`; nesse caso valem as mesmas validações de pertencimento e o alvo precisa ser uma `BET` não revertida (ADR 0006).
- **Uma transação não pode referenciar a si mesma** (`INVALID_PAYLOAD`).
- **Reference que ainda aguarda a própria reference** (por exemplo, `ROLLBACK` de um `REFUND` que está em `PENDING_REFERENCE`): a transação continua esperando, em vez de ser rejeitada, e cada espera conta como tentativa. Uma reference `REJECTED` ou `FAILED` leva a `REFERENCE_NOT_PROCESSED`.
- **Ordem das validações da reference:** pertencimento (provider, player, wallet, moeda, round) → kind permitido → estado → valor igual (só reversals) → já revertida. Assim, uma reference de outra wallet nunca revela detalhes sobre o estado dela.
- **`aggregateId` dos eventos é sempre o `walletId`**, inclusive nos eventos de transação. A wallet é a unidade de concorrência e de ordenação (`MessageGroupId`), então os eventos de uma wallet saem na ordem em que aconteceram.
- **`WagerTransactionPendingReference` é emitido uma única vez**, na entrada em `PENDING_REFERENCE`. As novas tentativas do worker não geram evento.

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

- **Hash do inbox:** SHA-256 do JSON canônico de `{type, data}`. O `occurredAt` fica de fora por ser metadado de transporte.
- **Ordem:** mensagens do mesmo `MessageGroupId` (a wallet) são processadas em sequência, e grupos diferentes em paralelo. Se uma mensagem do grupo precisa de retry, as seguintes do mesmo lote esperam junto, para não passarem na frente. Essa ordem é otimização; a correção vem do lock e do inbox.
- **Correlação:** atributo de mensagem `correlationId` ou, na falta dele, o `messageId`. O valor fica persistido na transação.
- **`SIGTERM`** (`enableShutdownHooks`): o consumer para de receber (aborta o long polling) e espera as mensagens em andamento até `SHUTDOWN_GRACE_MS` (padrão 10 s). O que não terminou volta para a fila com visibilidade 0, para outra instância pegar na hora. O compose dá `stop_grace_period: 20s`, maior que o prazo da aplicação. Se uma mensagem devolvida chegar a confirmar depois, a reentrega cai no inbox e não repete o efeito.
- **Métricas:** `wagering_dlq_messages_total{reason}` conta o que o consumer mandou explicitamente para a DLQ. `wagering_dlq_depth` (amostrado a cada 15 s) mostra a profundidade real, incluindo o que o redrive do SQS moveu sozinho. Também `wagering_retries_total{component="sqs_consumer"}` e `wagering_duplicates_detected_total{source="inbox"}`.

## Referências fora de ordem

> CHALLENGE §7.1

- O backoff exponencial começa em 2s, dobra a cada tentativa, tem teto de 5 min e para em **10 novas tentativas** depois da primeira (cerca de 18,5 min no total; `ReferenceResolutionPolicy.default()`). Esse prazo cobre atrasos normais de entrega e redelivery do provider sem deixar transações pendentes por tempo indefinido. Todos os parâmetros são configuráveis por env (os testes usam milissegundos).
- O worker pega trabalho com `FOR UPDATE SKIP LOCKED`, então pode rodar em várias instâncias.
- Há um gatilho imediato: quando uma wager transaction vira `PROCESSED`, a mesma transação SQL zera o `next_attempt_at` das `PENDING_REFERENCE` que apontam para ela.
- Esgotadas as tentativas: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## Topologia

> CHALLENGE §8, §13 (≥ 3 instâncias)

Uma única imagem, com papéis ligados por env: `api`, `consumer`, `outbox-publisher` e `pending-reference-worker`, todos ativos por padrão. O Docker Compose sobe 3 réplicas atrás de um nginx. Nos testes de concorrência, 3 ou mais processos Bun são iniciados via `Bun.spawn` contra o Postgres e o LocalStack reais.

## Observabilidade

> CHALLENGE §12

- Logs JSON com `nestjs-pino`, `correlationId` propagado por AsyncLocalStorage e redaction de valores e payloads financeiros.
- `GET /metrics` com `prom-client`: transações por status, duplicatas detectadas, retries, mensagens em DLQ, lock timeouts, outbox lag (idade do evento pendente mais antigo), latência de processamento (histograma) e divergências de reconciliação.
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

## Trabalho futuro

- **Teste de carga (`bun run test:load`)**: fora do escopo desta entrega (CHALLENGE §14, diferenciais opcionais). O plano seria um script Bun próprio com uma mistura de hot wallet e wallets distribuídas contra 3 réplicas, medindo throughput, p50/p95/p99, taxa de erro, lock timeouts e outbox lag, com ambiente e metodologia documentados.
- Integração com IdP (Keycloak, client-credentials por provider), conforme o ADR 0005.
- Double-entry ledger com contas de contrapartida.
