# OPENING usa um provider reservado do sistema

> Referência no README: §6.3 WagerTransaction ("`OPENING` é interno: não pode ser submetido pela API nem pela fila"); §9 Criar wallet (transação `OPENING` na mesma transação SQL); §5 item 9.

O `OPENING` vive na mesma tabela das wager transactions vindas de providers, para que ledger e reconciliação tratem todo crédito da mesma forma. Os campos de identidade ficam assim:

- `provider_id = '__system__'`, um valor reservado; a API e a fila rejeitam qualquer `providerId` que comece com `__`;
- `external_transaction_id = walletId`;
- `idempotency_key = 'opening:{walletId}'`;
- `round_id` e `game_id` aceitam nulo **somente** quando `kind = 'OPENING'`, garantido por `CHECK`.

A abertura emite `WagerTransactionProcessed` e `WalletBalanceChanged`. Com saldo inicial zero não há `OPENING`, ledger entry nem eventos, e a wallet nasce com `version = 1`.
