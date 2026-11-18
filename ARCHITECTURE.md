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

## Taxonomia de `failureCode`

> CHALLENGE §7.2

| Classe | Códigos | Ação do provider |
|---|---|---|
| Corrigir o payload | `INVALID_PAYLOAD`, `UNSUPPORTED_KIND`, `REFERENCE_REQUIRED`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_ID_CONFLICT` | Não reenviar igual; corrigir os dados ou a chave |
| Rejeição de negócio (terminal) | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH` | Desistir; um reenvio devolve o mesmo resultado |
| Transitória | `TEMPORARILY_UNAVAILABLE`, `LOCK_TIMEOUT` | Reenviar a mesma requisição (com a mesma idempotency key) |
| Falha interna (terminal) | `INTERNAL_INVARIANT_VIOLATION` | Escalar para suporte; ver ADR 0011 |

## Interpretações adicionais das regras de negócio

> CHALLENGE §7 ("Qualquer interpretação adicional adotada deve ser documentada")

- **`LOSS` aceita `0.00`**: ela só registra o resultado. Todos os outros kinds exigem valor > 0.
- **`BET` não pode ter referência.** `WIN` e `LOSS` podem referenciar uma `BET`; nesse caso valem as mesmas validações de pertencimento e o alvo precisa ser uma `BET` não revertida (ADR 0006).
- **Uma transação não pode referenciar a si mesma** (`INVALID_PAYLOAD`).
- **Reference que ainda aguarda a própria reference** (por exemplo, `ROLLBACK` de um `REFUND` que está em `PENDING_REFERENCE`): a transação continua esperando, em vez de ser rejeitada, e cada espera conta como tentativa. Uma reference `REJECTED` ou `FAILED` leva a `REFERENCE_NOT_PROCESSED`.
- **Ordem das validações da reference:** pertencimento (provider, player, wallet, moeda, round) → kind permitido → estado → valor igual (só reversals) → já revertida. Assim, uma reference de outra wallet nunca revela detalhes sobre o estado dela.
- **`aggregateId` dos eventos é sempre o `walletId`**, inclusive nos eventos de transação. A wallet é a unidade de concorrência e de ordenação (`MessageGroupId`), então os eventos de uma wallet saem na ordem em que aconteceram.
- **`WagerTransactionPendingReference` é emitido uma única vez**, na entrada em `PENDING_REFERENCE`. As novas tentativas do worker não geram evento.

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

## Reconciliação

> CHALLENGE §9 Reconciliação

A reconciliação lê a wallet e o ledger num snapshot `REPEATABLE READ`, sem lock, para não travar a hot wallet. Ela soma o ledger e também valida o encadeamento: cada `balance_before` é igual ao `balance_after` anterior, e as versões não têm buracos. Divergências são logadas, contadas em métrica e retornadas com `consistent: false` e a lista de anomalias. Nada é corrigido automaticamente.

O extrato (`GET /wallets/:id/ledger`) vai do mais recente para o mais antigo, com cursor opaco (base64 de `wallet_version`).

## Limitações

- Escala monetária fixa em 2 casas para todas as moedas (ADR 0002).
- Ledger de partida simples, sem double-entry (ADR 0009).
- Autenticação não implementada (ADR 0005).
- Recusas por wallet inexistente ou divergente não ficam na tabela de wager transactions (ADR 0007).

## Trabalho futuro

- **Teste de carga (`bun run test:load`)**: fora do escopo desta entrega (CHALLENGE §14, diferenciais opcionais). O plano seria um script Bun próprio com uma mistura de hot wallet e wallets distribuídas contra 3 réplicas, medindo throughput, p50/p95/p99, taxa de erro, lock timeouts e outbox lag, com ambiente e metodologia documentados.
- Integração com IdP (Keycloak, client-credentials por provider), conforme o ADR 0005.
- Double-entry ledger com contas de contrapartida.
