# Processamento síncrono no HTTP, mesmo use case do SQS

> Referência no README: §6.3 WagerTransaction (status `PENDING`); §9 API HTTP — Submeter transação (resposta com `status` e `balance`); §10 Processamento por SQS ("reutilizar o mesmo use case da entrada HTTP").

## Decisão

`POST /wagering/transactions` executa o use case `SubmitWagerTransaction` inline, numa única transação SQL, e responde com o estado final (`PROCESSED` ou `REJECTED` com balance), ou com "aceito, pendente" quando o estado é `PENDING_REFERENCE`. O consumer SQS chama exatamente o mesmo use case.

## Alternativa descartada

Enfileirar toda requisição HTTP e responder sempre 202. Descartada porque contradiz a resposta de exemplo da §9 e obrigaria o provedor a consultar o resultado depois, mesmo nos casos simples.

## Consequências

- `PENDING` existe apenas em memória, entre `create` e a transição dentro da transação, e nunca é commitado.
- O HTTP é síncrono, mas o sistema tem três fluxos assíncronos: consumer SQS (§10), publisher da outbox (§11) e worker de `PENDING_REFERENCE` (§7.1).
- Recuperação de falha no HTTP: se o processo morre antes do commit, a transação SQL é desfeita; o provedor reenvia com a mesma `Idempotency-Key` e recebe o processamento normal (se não houve commit) ou o replay (se houve).