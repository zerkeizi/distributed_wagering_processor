# Crash points nomeados para testes de falha

> Referência no README: §13 Testes de concorrência, cenários 5 ("worker morto depois do commit e antes do ack") e 8 (reinício do serviço); §11 (processo morre antes de publicar).

Para que os cenários de crash sejam determinísticos, o código tem crash points nomeados, como `consumer:after-commit-before-ack` e `outbox:after-publish-before-mark`. Eles chamam `process.exit(137)` quando `FAULT_CRASH_AT` aponta para eles. A variável só é lida fora de produção. O teste sobe o processo, espera o exit, sobe outra instância e verifica o estado final.

## Considered Options

`SIGKILL` disparado por timing não exige código no fluxo de produção, mas acerta a janela entre commit e ack só às vezes, o que deixa o teste intermitente.
