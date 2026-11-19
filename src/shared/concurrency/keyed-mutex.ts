/**
 * Exclusão mútua por chave, em memória, dentro de UMA instância: para a mesma chave, as tarefas
 * rodam uma de cada vez, em ordem de chegada; chaves diferentes não se esperam.
 *
 * Uso aqui: fila por wallet antes de pedir conexão ao pool (CHALLENGE §8). Sem ela, cada requisição
 * de uma hot wallet segura uma conexão enquanto espera o `FOR UPDATE` no banco — e uma única wallet
 * quente esgota o pool da instância, travando as outras wallets. Com ela, cada wallet usa no máximo
 * uma conexão por instância.
 *
 * NÃO é garantia de correção: entre instâncias, quem serializa continua sendo o lock no banco
 * (ADR 0003). Também não é lock global (CHALLENGE §5.6): é uma fila independente por chave, e a
 * entrada some quando a fila esvazia.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Executa `task` quando chegar a vez de `key`. Se a espera passar de `timeoutMs`, lança o erro de
   * `onTimeout()` sem executar a tarefa — e sem deixar quem veio depois passar na frente de quem
   * ainda está rodando.
   */
  async run<T>(
    key: string,
    timeoutMs: number,
    onTimeout: () => Error,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // O próximo da fila espera o anterior E a mim: mesmo se eu desistir, ele não fura a fila.
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        previous.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
      if (timedOut) throw onTimeout();
      return await task();
    } finally {
      clearTimeout(timer);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Chaves com fila ativa (diagnóstico e testes). */
  get size(): number {
    return this.tails.size;
  }
}

export const WALLET_MUTEX = Symbol("WALLET_MUTEX");
