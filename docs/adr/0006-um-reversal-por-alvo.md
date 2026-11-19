# No máximo um reversal aplicado por wager transaction

> Referência no CHALLENGE: §3 Invariantes globais ("não pode duplicar créditos"); §7 Regras de negócio, regras 3, 4 e 5 e tabela de operações; §5 item 9 (garantias no schema).

A regra 7.4 diz que uma referência "não pode ser revertida duas vezes **pelo mesmo tipo** de operação". Lida ao pé da letra, ela permite `BET` → `REFUND` → `ROLLBACK` da mesma `BET`, o que credita duas vezes. Adotamos a leitura estrita: **cada wager transaction pode ser alvo de no máximo um reversal (`REFUND` ou `ROLLBACK`) `PROCESSED`**. A garantia está no schema, com um índice único parcial em `reference_transaction_id WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`. Reverter um reversal continua permitido, porque é outro alvo (`BET` → `REFUND` → `ROLLBACK` do `REFUND`). A segunda tentativa sobre o mesmo alvo vira `REJECTED` com `REFERENCE_ALREADY_REVERSED`.

## Consequences

Pelo mesmo motivo, `WIN` e `LOSS` podem referenciar uma `BET` opcionalmente. Quando referenciam, valem as mesmas validações (mesmo provider, player, wallet, moeda e round; alvo `BET` `PROCESSED`). Uma referência ausente leva a `PENDING_REFERENCE`, e uma `BET` já revertida leva a `REJECTED` com `REFERENCE_ALREADY_REVERSED`.

Exemplo do que a regra implica: em `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a aposta volta a estar debitada, mas um segundo `REFUND` da mesma `BET` é recusado (`REFERENCE_ALREADY_REVERSED`), porque ela já foi alvo de um reversal aplicado. Reversões não se empilham sobre o mesmo alvo.

