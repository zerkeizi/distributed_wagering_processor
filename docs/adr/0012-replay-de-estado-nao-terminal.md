# Reenvio de transação pendente tenta resolver a referência

> Referência no CHALLENGE: §9 API HTTP — Idempotência ("requisição idêntica → mesma resposta"); §7 regra 7 e regra 8; §7.1 Referências fora de ordem.

"Mesma resposta" vale para estados terminais. Quando chega um reenvio idêntico de uma wager transaction em `PENDING_REFERENCE`, o use case tenta resolver a referência inline (sob o lock da wallet) e responde com o estado atual: `201`/`422` se ela foi resolvida, `202` se continua pendente. Em todos os casos a resposta leva `idempotentReplay: true`. Assim o reenvio do provider funciona como um "empurrão" legítimo e não precisa esperar o próximo ciclo do worker.
