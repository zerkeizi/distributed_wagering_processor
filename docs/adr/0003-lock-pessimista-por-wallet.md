# Lock pessimista por linha de wallet

> Referência no README: §5 Restrições invioláveis, itens 6, 7, 8 e 9; §6.2 Wallet (invariantes e `version`); §8 Concorrência e ordenação (cenário obrigatório); §12 Observabilidade ("conflitos de lock").

Toda operação que altera o balance abre uma transação SQL e faz `SELECT … FOR UPDATE` na linha da wallet (`LockMode.PESSIMISTIC_WRITE`). A serialização acontece por `walletId`, nunca por um lock global. Por baixo disso ficam `CHECK (balance >= 0)` no schema e o incremento de `version` como defesa em profundidade. Usamos `lock_timeout` para que esperas longas virem falha transitória contabilizada como conflito de lock.

## Considered Options

- **Lock otimista por `version` com retry**: rejeitado. Numa hot wallet (por exemplo, 50 apostas paralelas) cada commit invalida os demais e gera uma tempestade de retries com latência imprevisível.
- **`UPDATE … WHERE balance >= x` atômico**: correto para o débito, mas não entrega `balance_before`/`balance_after` do ledger nem as validações de referência sob o mesmo lock sem lógica espalhada em SQL.
