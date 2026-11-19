# Classificação de erros no consumer SQS

> Referência no CHALLENGE: §10 Processamento por SQS (negócio → ack; transitório → retry com backoff; permanente → DLQ; limite de tentativas; SIGTERM; redelivery); §6.5 InboxMessage; §5 item 3.

- **Negócio** (`REJECTED`, wallet inexistente, idempotency conflict): commit do resultado junto com o registro no inbox, depois ack.
- **Transitório** (banco ou SQS indisponível, lock timeout): sem ack. O consumer chama `ChangeMessageVisibility` com backoff exponencial calculado pelo `ApproximateReceiveCount`, e a redrive policy envia para a DLQ após `maxReceiveCount = 5`.
- **Permanente** (JSON ou schema inválido, `kind = OPENING`, mesmo `messageId` com `payloadHash` diferente no inbox): envio explícito para a DLQ, ack e métrica. Esses casos não esperam as 5 entregas.

A fila usa `MessageGroupId = walletId`. Essa ordenação é otimização; a correção vem do lock por wallet (ADR 0003). No `SIGTERM`, o consumer para de fazer polling, espera as mensagens em andamento até um deadline e, depois disso, chama `ChangeMessageVisibility(0)` nas restantes.

## Atualização (implementação)

- **Também são permanentes** (DLQ na hora) os erros de forma detectados pelo domínio: `INVALID_PAYLOAD` (por exemplo, `amount` fora da escala) e `REFERENCE_REQUIRED`. Reenviar a mesma mensagem nunca daria certo.
- **Erro inesperado** (bug, exceção não classificada) **não** vai para a DLQ na hora: recebe o tratamento de transitório, com retry e backoff, e o redrive do SQS leva para a DLQ se persistir. Assim, uma falha passageira que não classifiquei não descarta a mensagem cedo demais.
- O hash do inbox cobre `{type, data}`, sem o `occurredAt`: o mesmo `messageId` reenviado com outro timestamp é reentrega, não mensagem forjada.
- **Banco indisponível não é erro da mensagem: circuit breaker.** A primeira versão tratava "banco fora do ar" como qualquer erro transitório, e cada mensagem recebida durante a queda gastava uma das entregas permitidas. Uma queda de ~1 min mandava apostas **válidas** para a DLQ: foi verificado no compose e reproduzido em teste (as 3 mensagens do teste terminam na DLQ). Agora, quando o use case falha por `PersistenceUnavailableError`, o consumer:
  - **para de receber mensagens**;
  - devolve a mensagem em mão com visibilidade curta;
  - sonda o banco (`select 1`) com backoff (`SQS_CONSUMER_PAUSE_PROBE_MS`…`_MAX_MS`) até ele responder.

  Mensagens que não são recebidas não gastam entregas. A métrica `wagering_consumer_paused` fica em 1 durante a pausa. `LOCK_TIMEOUT` continua como retry só daquela mensagem, porque é problema de uma wallet, não do banco. Teste: `test/integration/sqs/database-outage.test.ts`, com uma queda real (`ALTER DATABASE … ALLOW_CONNECTIONS false`).
