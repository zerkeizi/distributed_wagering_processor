# Crash points nomeados para testes de falha

> Referência no CHALLENGE: §13 Testes de concorrência, cenários 5 ("worker morto depois do commit e antes do ack") e 8 (reinício do serviço); §11 (processo morre antes de publicar).

Para que os cenários de crash sejam determinísticos, o código tem crash points nomeados, como `consumer:after-commit-before-ack` e `outbox:after-publish-before-mark`. Quando `FAULT_CRASH_AT` aponta para um deles, o processo se mata com `SIGKILL`: sem shutdown hooks, sem flush e sem `finally`, como uma queda de energia ou um OOM kill. (A primeira versão desta decisão previa `process.exit(137)`; troquei por `SIGKILL` porque `exit` ainda rodaria handlers de saída e ficaria menos fiel a um crash real.) Em produção a configuração zera a variável. O teste sobe o processo, espera o exit, sobe outra instância e verifica o estado final.

## Considered Options

`SIGKILL` disparado por timing não exige código no fluxo de produção, mas acerta a janela entre commit e ack só às vezes, o que deixa o teste intermitente.

## Consequences

Os cenários estão em `test/concurrency/multi-instance.test.ts`, com processos `bun src/main.ts` reais:

- **`consumer:after-commit-before-ack`:** o commit acontece e o processo morre antes do `DeleteMessage`. Outra instância recebe a reentrega depois do visibility timeout, o inbox absorve, e o débito acontece uma única vez.
- **`outbox:after-publish-before-mark`:** o evento chega à fila, mas fica sem `published_at`. Depois do lease, outro publisher republica com o mesmo `eventId`; a deduplicação do SQS FIFO descarta a cópia, e nenhum evento se perde.
- **`submit:before-commit`:** o processo morre com transação, lançamento, saldo, outbox e inbox já registrados no Unit of Work, mas antes do commit. Nada fica gravado, e a reentrega aplica a operação normalmente, uma vez só (CHALLENGE §3, "o processo pode morrer antes ou depois do commit").
