# Rejeição de negócio persistida responde 422 com corpo completo

> Referência no CHALLENGE: §9 API HTTP — "Status HTTP" (distinguir payload inválido, conflito, rejeição, pendente e falha transitória) e Idempotência (replay retorna a mesma resposta); §7.2 Códigos de falha.

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

## Atualização (implementação)

Detalhes que surgiram na implementação e completam a tabela acima:

- `404 TRANSACTION_NOT_FOUND` nas consultas de transação; `409 WALLET_ALREADY_EXISTS` na criação de wallet duplicada.
- `422 WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH` quando a wallet existe mas não é do player ou da moeda (ADR 0007).
- Uma transação pendente que se resolve no próprio reenvio responde `201`, porque foi aplicada agora (ADR 0012).
- `FAILED` (raro, ADR 0011) responde `500`.
- `503` vem com `Retry-After`: `LOCK_TIMEOUT` (1 s) ou `TEMPORARILY_UNAVAILABLE` (2 s).
- Erro não mapeado (bug) responde `500 INTERNAL_ERROR`, sem detalhes na resposta.
