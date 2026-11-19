# Distributed Wagering Processor

Serviço financeiro que aplica operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por provedores de jogos sobre a carteira (wallet) de cada jogador. As operações chegam por HTTP ou por uma fila SQS, e o sistema se mantém correto quando elas chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo em várias instâncias**.

O que o sistema garante:

- **Dinheiro sem ponto flutuante.** `Money` usa `bigint` em centavos e `NUMERIC(20,2)` no banco.
- **Saldo nunca negativo e sem lost update**, inclusive com 3 instâncias disputando a mesma wallet. A serialização é feita por um lock por wallet no Postgres.
- **Idempotência persistente.** Um reenvio devolve o resultado original; a mesma key com conteúdo diferente é conflito.
- **Saldo e ledger sempre batendo**, com essa garantia aplicada pelo próprio schema: ledger append-only, encadeado e verificado no commit.
- **Nenhum evento confirmado se perde**, graças ao transactional outbox, ao inbox no consumer e à recuperação depois de crash.

| Documento | Conteúdo |
|---|---|
| [`CHALLENGE.md`](CHALLENGE.md) | Enunciado do desafio |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Como tudo funciona, garantias, trade-offs e limitações |
| [`docs/adr/`](docs/adr/) | Decisões de arquitetura (16 ADRs), cada uma ligada às seções do enunciado |
| [`GLOSSARY.md`](GLOSSARY.md) | Vocabulário do domínio |

## Stack

Bun 1.4 · TypeScript (strict) · NestJS · MikroORM 7 · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose · nginx.

## Pré-requisitos

- **Docker** com Docker Compose v2.
- **Bun 1.4.x**: `curl -fsSL https://bun.sh/install | bash`. Ele instala em `~/.bun`; abra um terminal novo depois.

## Subindo

```bash
bun install
bun run infra:up        # Postgres, LocalStack (filas SQS), migrations, 3 réplicas da app e nginx
bun run smoke:infra     # confere: 3 réplicas respondendo, health, métricas
```

O serviço fica em **http://localhost:8080** (nginx → 3 réplicas). Para derrubar tudo e apagar os dados, use `bun run infra:down`.

O `infra:up` sobe, nesta ordem:

| Serviço | Papel |
|---|---|
| `postgres` | banco (`localhost:5432`, usuário/senha/banco `wagering`) |
| `localstack` | SQS (`localhost:4566`); o init script cria `wager-transactions.fifo`, a DLQ (redrive após 5 entregas) e `wagering-events.fifo` |
| `migrate` | aplica as migrations uma vez e termina, antes de qualquer réplica subir |
| `app` × 3 | réplicas com todos os papéis: API HTTP, consumer SQS, publisher da outbox e worker de referências pendentes |
| `nginx` | porta única `:8080` balanceando entre as réplicas |

### Rodando a aplicação no host (desenvolvimento)

Com a infraestrutura do compose de pé:

```bash
cp .env.example .env    # o Bun carrega o .env sozinho
bun run dev             # localhost:3000, recarrega a cada arquivo salvo
```

## Explorando

- **No editor:** abra [`requests.http`](requests.http) com a extensão REST Client do VS Code (`humao.rest-client`). Ele tem uma sequência pronta: criar wallet → apostar → replay → conflito → REFUND → ROLLBACK pendente → consultas.
- **Pelos smokes:** cada um imprime o que acontece numa parte do sistema, contra o ambiente do compose.

| Comando | O que mostra |
|---|---|
| `bun run smoke:infra` | balanceamento entre as 3 réplicas, readiness, correlationId, métricas declaradas |
| `bun run smoke:domain` | uma rodada inteira só no domínio (sem banco): saldos, ledger, rejeições, referência fora de ordem |
| `bun run smoke:db` | grava wallet + aposta e tenta sabotar o banco com SQL cru; o Postgres recusa tudo |
| `bun run smoke:race` | duas apostas de 80.00 sobre 100.00 e 50 apostas idênticas, disparadas contra as 3 réplicas |
| `bun run smoke:sqs` | aposta pela fila, reentrega deduplicada pelo inbox, mensagem malformada indo para a DLQ |
| `bun run smoke:events` | ROLLBACK que chega antes da BET, resolvido sozinho pelo worker; eventos chegando em `wagering-events.fifo` |

- **Logs:** `docker compose logs -f app`. São JSON, com `instanceId`, `correlationId`, `walletId`, `transactionId` e `messageId`.

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (saldo inicial > 0 gera a transação interna `OPENING` e o lançamento) |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Extrato, do mais recente para o mais antigo, com cursor opaco e estável |
| `POST /wallets/:walletId/reconciliation` | Saldo armazenado × saldo reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete uma operação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provider |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness (Postgres e SQS), sem autenticação |
| `GET /metrics` | Métricas Prometheus da instância |

Status de `POST /wagering/transactions`:

| Status | Quando |
|---|---|
| `201` | aplicada agora |
| `200` | replay (`idempotentReplay: true`, saldo original) |
| `202` | aguardando a referência (`PENDING_REFERENCE`) |
| `422` | rejeitada por regra de negócio (`failureCode`) |
| `400` | payload inválido |
| `404` | wallet inexistente |
| `409` | conflito de idempotência |
| `503` | transitório: reenvie a mesma requisição |

Todos os erros usam o mesmo envelope `{ "error": { "code", "message", "details?", "correlationId" } }`. A taxonomia completa de códigos, com a ação esperada do provider, está no [ARCHITECTURE](ARCHITECTURE.md#taxonomia-de-failurecode) e no [ADR 0010](docs/adr/0010-mapeamento-de-status-http.md).

### Pela fila

Publique em `wager-transactions.fifo` no formato do CHALLENGE §10, usando `MessageGroupId` = `walletId`. O atributo de mensagem `correlationId` é opcional. Na fila FIFO, o SQS descarta um envio com o mesmo `--message-deduplication-id` dentro de 5 minutos: troque o valor a cada envio.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id dedup-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-19T12:00:00Z","data":{"providerId":"provider-a","externalTransactionId":"tx-1","idempotencyKey":"provider-a:tx-1","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) saem em `wagering-events.fifo`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run check` | lint, typecheck e testes unitários (rode antes de cada commit) |
| `bun run test:unit` | domínio e regras, sem containers (~1 s) |
| `bun run test:integration` | Postgres e LocalStack reais: constraints, HTTP, consumer SQS, outbox, workers, shutdown (~20 s) |
| `bun run test:concurrency` | paralelismo real e processos `bun src/main.ts` separados: crashes e reinício (~40 s) |
| `bun run test:all` | as três suítes em sequência |
| `bun run infra:up` / `infra:down` | sobe ou derruba o compose (`down` apaga os volumes) |
| `bun run migration:up` / `down` / `status` | migrations versionadas e reversíveis (usa `DATABASE_URL`) |
| `bun run dev` / `start` | aplicação no host, com e sem hot reload |
| `bun run lint` / `format` / `typecheck` | Biome e TypeScript |

Os testes de integração e de concorrência precisam do compose de pé (`bun run infra:up`). Eles usam um banco próprio (`wagering_test`, criado e migrado automaticamente), e as suítes mais sensíveis criam e apagam bancos e filas exclusivos. A tabela que liga cada cenário exigido pelo CHALLENGE §13 ao teste correspondente está no [ARCHITECTURE](ARCHITECTURE.md#testes).

## Configuração

Toda a configuração vem de variáveis de ambiente, validadas no boot: um valor inválido derruba o processo com a lista de erros. Os padrões abaixo são os de produção; o compose e os testes sobrescrevem o que precisam.

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | Postgres |
| `ROLES` | todos | papéis da instância: `api`, `consumer`, `outbox-publisher`, `pending-reference-worker` |
| `PORT` · `LOG_LEVEL` · `INSTANCE_ID` | `3000` · `info` · hostname | |
| `AWS_REGION` · `AWS_ENDPOINT_URL` · `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` | `us-east-1` · — | SQS (LocalStack no compose) |
| `SQS_WAGER_QUEUE_NAME` · `SQS_WAGER_DLQ_NAME` · `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo` · `wager-transactions-dlq.fifo` · `wagering-events.fifo` | filas |
| `WALLET_LOCK_TIMEOUT_MS` | `2000` | espera máxima pelo lock da wallet; depois responde `503 LOCK_TIMEOUT` |
| `REFERENCE_RETRY_MAX` · `REFERENCE_RETRY_BASE_MS` · `REFERENCE_RETRY_MAX_DELAY_MS` | `10` · `2000` · `300000` | espera por referência fora de ordem (~18,5 min no total) |
| `SQS_CONSUMER_WAIT_SECONDS` · `SQS_CONSUMER_BATCH_SIZE` | `20` · `10` | long polling do consumer |
| `SQS_RETRY_BASE_MS` · `SQS_RETRY_MAX_MS` | `2000` · `60000` | backoff de falha transitória no consumer |
| `SHUTDOWN_GRACE_MS` | `10000` | no `SIGTERM`, quanto esperar mensagens em andamento |
| `OUTBOX_POLL_INTERVAL_MS` · `OUTBOX_BATCH_SIZE` · `OUTBOX_LEASE_MS` | `500` · `50` · `30000` | publisher da outbox |
| `OUTBOX_RETRY_BASE_MS` · `OUTBOX_RETRY_MAX_MS` | `1000` · `60000` | backoff de publicação (sem limite de tentativas) |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` · `PENDING_REFERENCE_BATCH_SIZE` | `1000` · `50` | worker de referências pendentes |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | timeout de cada sonda do `/health/ready` |
| `FAULT_CRASH_AT` | — | só em testes: crash point (ADR 0016); ignorada em produção |

## Estrutura

```
src/
  wagering/
    domain/           regras puras: Money, Wallet, WagerTransaction, ledger, settle(), eventos
    application/      use cases e portas (UnitOfWork, repositórios, outbox, telemetria)
    infrastructure/   MikroORM (records, mappers, migration), SQS, métricas
    interface/        HTTP (controllers, filtro de erros), consumer SQS, workers, contratos
  shared/             config, observabilidade, auth (ponto de extensão), mensageria, utilitários
  health/             liveness e readiness
  cli/migrate.ts      migrations
test/
  unit/  integration/  concurrency/
scripts/smoke/        os smokes acima
infra/                init do LocalStack e config do nginx
```

## Problemas comuns

- **`bun: command not found`:** abra um terminal novo depois de instalar, ou rode `export PATH="$HOME/.bun/bin:$PATH"`.
- **Testes de integração falhando com erro de conexão:** o compose precisa estar de pé (`bun run infra:up`).
- **`502` logo depois de um rebuild:** o nginx leva até 2 s para enxergar os IPs novos das réplicas.
- **Editou `infra/nginx/nginx.conf`:** use `docker compose up -d --force-recreate nginx`, não `restart`. Alguns editores substituem o arquivo, e o container continua com o antigo.
- **Porta 5432, 4566 ou 8080 ocupada:** pare o serviço que está nela, ou ajuste as portas no `docker-compose.yml`.
