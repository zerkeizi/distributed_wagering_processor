# Classificação de erros no consumer SQS

> Referência no README: §10 Processamento por SQS (negócio → ack; transitório → retry com backoff; permanente → DLQ; limite de tentativas; SIGTERM; redelivery); §6.5 InboxMessage; §5 item 3.

- **Negócio** (`REJECTED`, wallet inexistente, idempotency conflict): commit do resultado junto com o registro no inbox, depois ack.
- **Transitório** (banco ou SQS indisponível, lock timeout): sem ack. O consumer chama `ChangeMessageVisibility` com backoff exponencial calculado pelo `ApproximateReceiveCount`, e a redrive policy envia para a DLQ após `maxReceiveCount = 5`.
- **Permanente** (JSON ou schema inválido, `kind = OPENING`, mesmo `messageId` com `payloadHash` diferente no inbox): envio explícito para a DLQ, ack e métrica. Esses casos não esperam as 5 entregas.

A fila usa `MessageGroupId = walletId`. Essa ordenação é otimização; a correção vem do lock por wallet (ADR 0003). No `SIGTERM`, o consumer para de fazer polling, espera as mensagens em andamento até um deadline e, depois disso, chama `ChangeMessageVisibility(0)` nas restantes.
