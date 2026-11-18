# Wagering

Serviço financeiro que aplica, sobre a carteira de um jogador, as operações de aposta enviadas por provedores de jogos, mantendo saldo e histórico auditável sempre consistentes entre si.

## Participantes

**Provider**:
Empresa externa que opera jogos e envia operações de aposta em nome dos jogadores.
_Avoid_: Fornecedor, integrador, cliente

**Player**:
Pessoa que joga e é dona de uma ou mais carteiras (no máximo uma por moeda).
_Avoid_: Usuário, cliente, conta

**Game**:
Jogo do provider em que a rodada acontece; serve apenas como contexto da operação.

**Round**:
Uma partida de um jogo; agrupa a aposta e os resultados e reversões que dependem dela.
_Avoid_: Sessão, partida, jogada

## Carteira e saldo

**Wallet**:
Conta de saldo de um player em uma única moeda.
_Avoid_: Conta, account, carteira digital

**Balance**:
Valor disponível na wallet; nunca negativo.
_Avoid_: Saldo disponível, crédito

**Money**:
Quantia exata em uma moeda, com duas casas decimais.
_Avoid_: Valor, amount (isolado), preço

**Ledger Entry**:
Registro imutável de uma única alteração de balance, com o balance antes e depois.
_Avoid_: Movimentação, lançamento contábil, extrato

**Ledger**:
A sequência completa de ledger entries de uma wallet; a fonte da verdade do balance.
_Avoid_: Histórico, extrato

**Reconciliation**:
Verificação de que o balance armazenado é igual ao balance reconstruído a partir do ledger.
_Avoid_: Auditoria, conferência

## Operações

**Wager Transaction**:
Uma operação de aposta enviada por um provider (ou gerada internamente) sobre uma wallet.
_Avoid_: Transação (isolado), operação, evento

**Opening**:
Wager transaction interna que credita o balance inicial na abertura da wallet; nunca vem de um provider.
_Avoid_: Depósito, saldo inicial

**Bet**:
Wager transaction que debita a wallet para entrar em uma round.
_Avoid_: Aposta (no código), stake, wager

**Win**:
Wager transaction que credita um prêmio da round.
_Avoid_: Payout, prêmio

**Loss**:
Wager transaction que registra o fim de uma round sem prêmio; não altera o balance.

**Refund**:
Reversal que devolve uma bet.
_Avoid_: Estorno, devolução, reembolso

**Rollback**:
Reversal que desfaz o efeito de uma bet, win ou refund.
_Avoid_: Cancelamento, undo

**Reversal**:
Termo coletivo para refund e rollback; cada wager transaction pode ser alvo de no máximo um reversal aplicado.

**Reference**:
A wager transaction anterior (do mesmo provider, player, wallet, moeda e round) à qual outra se refere, identificada pelo id do provider.
_Avoid_: Transação pai, origem

## Ciclo de vida

**Pending Reference**:
Estado de uma wager transaction aceita cuja reference ainda não chegou.
_Avoid_: Órfã, aguardando

**Processed**:
Estado final de uma wager transaction aplicada.
_Avoid_: Concluída, sucesso, confirmada

**Rejected**:
Estado final de uma wager transaction recusada por regra de negócio; não altera o balance.
_Avoid_: Recusada, negada, inválida

**Failed**:
Estado final de uma wager transaction que não pôde ser concluída por erro permanente fora das regras de negócio.
_Avoid_: Erro, rejeitada

**Failure Code**:
Motivo estável e legível por máquina de um rejected ou failed, que diz ao provider se deve reenviar, corrigir ou desistir.
_Avoid_: Mensagem de erro, motivo

## Idempotência

**Idempotency Key**:
Identificador escolhido pelo provider que torna uma wager transaction única dentro desse provider.

**Replay**:
Reenvio idêntico de uma wager transaction já registrada; recebe o resultado original.
_Avoid_: Retry, duplicata

**Idempotency Conflict**:
Reenvio com a mesma idempotency key (ou o mesmo id do provider) mas conteúdo de negócio diferente; nunca é tratado como replay.
_Avoid_: Duplicata, colisão
