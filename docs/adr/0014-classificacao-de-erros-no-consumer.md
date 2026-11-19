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
