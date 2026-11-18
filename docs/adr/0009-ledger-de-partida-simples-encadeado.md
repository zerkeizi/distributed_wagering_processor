# Ledger de partida simples, encadeado por versão da wallet

> Referência no README: §6.4 WalletLedgerEntry; §5 itens 5 e 9; §7 regra 7 ("incluindo o saldo observado naquele momento"); §9 Consultas (cursor estável) e Reconciliação; §13 (invariante final).

O ledger é de partida simples, sem double-entry. Cada ledger entry guarda `balance_before` e `balance_after`, e o schema impõe:

- `CHECK` da aritmética `balance_after = balance_before ± amount`;
- `UNIQUE (transaction_id)`;
- `UNIQUE (wallet_id, wallet_version)`, o que dá uma sequência sem buracos por wallet e serve de cursor estável do extrato;
- trigger que bloqueia `UPDATE` e `DELETE`.

Wager transactions sem ledger entry (`LOSS`, `REJECTED`) guardam o balance observado numa coluna própria, para que o replay devolva o saldo original.

## Considered Options

Double-entry (contas de contrapartida por provider/casa) foi descartado por custo e benefício no timebox. O encadeamento por versão já permite que a reconciliação detecte lacunas ou adulterações.
