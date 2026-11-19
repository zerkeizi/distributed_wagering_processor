# Lock pessimista por linha de wallet

> Referência no CHALLENGE: §5 Restrições invioláveis, itens 6, 7, 8 e 9; §6.2 Wallet (invariantes e `version`); §8 Concorrência e ordenação (cenário obrigatório); §12 Observabilidade ("conflitos de lock").

Toda operação que altera o balance abre uma transação SQL e faz `SELECT … FOR UPDATE` na linha da wallet (`LockMode.PESSIMISTIC_WRITE`). A serialização acontece por `walletId`, nunca por um lock global. Por baixo disso ficam `CHECK (balance >= 0)` no schema e o incremento de `version` como defesa em profundidade. Usamos `lock_timeout` para que esperas longas virem falha transitória contabilizada como conflito de lock.

## Considered Options

- **Lock otimista por `version` com retry**: rejeitado. Numa hot wallet (por exemplo, 50 apostas paralelas) cada commit invalida os demais e gera uma tempestade de retries com latência imprevisível.
- **`UPDATE … WHERE balance >= x` atômico**: correto para o débito, mas não entrega `balance_before`/`balance_after` do ledger nem as validações de referência sob o mesmo lock sem lógica espalhada em SQL.

## Atualização (revisão da §8): fila por wallet na instância

Medindo a hot wallet com os valores padrão, apareceu um efeito que os testes (com timeout longo) escondiam: cada requisição esperando o `FOR UPDATE` segura uma conexão do pool. Uma única wallet quente esgotava as 10 conexões da instância, e as **outras** wallets passavam a levar ~2 s e a falhar com `503`. Isso contraria a §8, "wallets diferentes processadas em paralelo".

A correção é uma fila em memória **por wallet**, dentro de cada instância (`KeyedMutex`), antes de pedir conexão: só uma operação por wallet, por instância, segura conexão. Ela não substitui o lock no banco, que continua sendo a garantia entre instâncias, e não é um lock global (§5.6): é uma fila independente por chave. O pool esgotado por sobrecarga geral passou a ser distinguido de banco fora do ar (`PersistenceBusyError`). Números antes e depois em ARCHITECTURE, seção "Concorrência por wallet".

