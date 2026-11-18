# FAILED só se aplica a transações já persistidas

> Referência no README: §6.3 WagerTransaction (`FAILED` como "erro permanente de infraestrutura, terminal, auditável"); §7.1 Referências fora de ordem; §10 (erros permanentes vão para a DLQ).

Com o processamento síncrono (ADR 0004), uma falha de infraestrutura faz rollback de tudo, e não sobra registro para marcar como `FAILED`. Por isso `FAILED` só é usado para uma wager transaction **já commitada** (na prática, `PENDING_REFERENCE`) cujo reprocessamento encontra um erro permanente que não é de negócio, como uma violação de invariante detectada pelo banco ou estado corrompido. A marcação acontece numa transação separada, com `failureCode = INTERNAL_INVARIANT_VIOLATION`, log e métrica. Erros permanentes de **mensagem** (JSON ou schema inválido) vão para a DLQ e não criam wager transaction.
