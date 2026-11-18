# Rejeição de negócio persistida responde 422 com corpo completo

> Referência no README: §9 API HTTP — "Status HTTP" (distinguir payload inválido, conflito, rejeição, pendente e falha transitória) e Idempotência (replay retorna a mesma resposta); §7.2 Códigos de falha.

O provider decide o que fazer pelo status, sem precisar ler a mensagem. Por isso cada situação tem um status próprio, igual em todos os endpoints:

| Situação | Status |
|---|---|
| `PROCESSED` novo | `201` |
| Replay | `200`, com `idempotentReplay: true` |
| `PENDING_REFERENCE` | `202` |
| `REJECTED` | `422`, com o mesmo corpo de sucesso (`transactionId`, `status`, `failureCode`, `balance`) |
| Payload inválido | `400` |
| Wallet inexistente | `404` |
| Idempotency conflict | `409` |
| Falha transitória | `503` + `Retry-After` |

A escolha que pode surpreender: uma rejeição é um resultado **registrado**, e mesmo assim responde `422` em vez de `200`. Um replay de `REJECTED` também volta com `422`, para que um provider que só olha o status nunca trate uma rejeição como sucesso. O corpo de erro segue o envelope `{ error: { code, message } }`, com `code` vindo da taxonomia de `failureCode`.
