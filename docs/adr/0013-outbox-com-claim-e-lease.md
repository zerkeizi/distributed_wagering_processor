# Outbox publicada com claim por SKIP LOCKED e lease

> Referência no CHALLENGE: §11 Transactional Outbox (publishers concorrentes, cenário de crash após o commit, publicação duplicada segura); §5 item 4; §6.5 OutboxMessage (`scheduleRetry`, backoff); §12 (outbox lag).

Cada publisher pega um lote numa transação curta: `SELECT … FOR UPDATE SKIP LOCKED` sobre os eventos pendentes e vencidos, gravando `locked_until = now() + lease`. Depois do commit, ele publica no SQS (`wagering-events.fifo`, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) e marca `published_at`. Numa falha, chama `scheduleRetry` com backoff exponencial **sem limite de tentativas**: o evento nunca é descartado, e o atraso aparece na métrica de outbox lag. Se o processo morrer, o lease expira e outra instância publica. Um duplicado é seguro porque o consumidor deduplica por `eventId`.

## Considered Options

Segurar a transação aberta durante o publish elimina o lease, mas mantém conexões e locks presos enquanto o SQS responde. Uma lentidão do SQS esgotaria o pool usado pelo fluxo financeiro.

## Consequences

- **Ordem por wallet é melhor esforço entre publishers.** Dentro de um claim, os eventos saem em ordem de ocorrência, mas dois publishers podem pegar eventos da mesma wallet em lotes diferentes e publicá-los fora de ordem. Consumidores que precisam de ordem usam o `walletVersion` de `WalletBalanceChanged` e descartam duplicatas pelo `eventId`.
- **Deduplicação no SQS.** A deduplicação do SQS FIFO (por `MessageDeduplicationId = eventId`) só vale por 5 minutos. Um republish depois disso chega ao consumidor, por isso a deduplicação pelo `eventId` do lado dele é obrigatória.
- **Cada operação do publisher é um único statement em autocommit:** claim com `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, depois marcar, depois agendar retry. Nenhuma conexão fica presa enquanto o SQS responde.

