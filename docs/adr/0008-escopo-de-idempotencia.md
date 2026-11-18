# Unicidade por provider na idempotency key e no id externo

> Referência no README: §9 API HTTP — Idempotência; §6.3 WagerTransaction ("mesma idempotency key com payload diferente é conflito"); §7 regra 7 (replay retorna o resultado original); §5 itens 2 e 9.

Duas constraints no banco: `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Os casos ficam assim:

- mesma key e mesmo `payloadHash`: replay;
- mesma key com hash diferente: `IDEMPOTENCY_KEY_CONFLICT`;
- key diferente com o mesmo `externalTransactionId`: `EXTERNAL_ID_CONFLICT`, nunca uma segunda transação.

`payloadHash` é o SHA-256 hex do JSON canônico (chaves ordenadas recursivamente, sem espaços) dos campos `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}` e `referenceExternalTransactionId` (omitido quando ausente). O header e os metadados de transporte não entram no hash.
