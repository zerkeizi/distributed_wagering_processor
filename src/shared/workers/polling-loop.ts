/**
 * Laço de polling com parada limpa: roda `tick` em sequência (nunca dois ao mesmo tempo na mesma
 * instância), dorme `intervalMs` quando não houve trabalho e repete na hora quando houve. `stop()`
 * espera o tick em andamento terminar — usado no SIGTERM para não cortar uma transação no meio.
 */
export class PollingLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly tick: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
        failures = 0;
      } catch (error) {
        failures++;
        this.onError(error);
      }
      if (!this.running) break;
      if (busy) continue;
      const delay =
        failures > 0
          ? Math.min(30_000, this.intervalMs * 2 ** Math.min(failures, 6))
          : this.intervalMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }
}
