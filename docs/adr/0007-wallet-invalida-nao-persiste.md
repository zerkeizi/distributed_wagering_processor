# Wallet inexistente ou divergente é recusada sem persistir

> Referência no README: §7 Regras de negócio, regra 2 (mesmo player, wallet e moeda); §6.2 Wallet ("a moeda da operação deve ser igual à moeda da wallet"); §10 ("distinguir erros de negócio — terminal, ack").

Quando o `walletId` não existe, ou quando o `playerId` ou a moeda não batem com a wallet, a wager transaction **não é gravada**. A resposta é 404 `WALLET_NOT_FOUND` ou 422 `WALLET_PLAYER_MISMATCH`/`CURRENCY_MISMATCH`. Assim `wager_transaction.wallet_id` mantém a FK para `wallet`. A idempotência continua valendo porque a resposta é determinística: um reenvio produz o mesmo erro. No SQS, isso é erro de negócio (ack) e fica registrado no inbox.

## Consequences

Essas recusas não ficam na tabela de wager transactions; a auditoria delas fica em logs, métricas e inbox. Um provider que criar a wallet depois e reenviar a mesma idempotency key terá a operação processada normalmente.
