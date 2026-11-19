/**
 * Crash points nomeados (ADR 0016): permitem que os testes matem o processo exatamente num ponto
 * crítico — por exemplo, depois do commit e antes do ack — de forma determinística.
 *
 * Ligado só por `FAULT_CRASH_AT=<nome>` fora de produção (a config zera o valor em produção). O
 * processo morre com SIGKILL: nenhum shutdown hook, nenhum flush, nenhum `finally` — como uma queda
 * de energia ou um OOM kill.
 */
let armed: string | undefined;

export function armCrashPoint(name: string | undefined): void {
  armed = name;
}

export function crashPoint(name: string): void {
  if (armed !== name) return;
  process.stderr.write(`[crash-point] ${name}: killing process ${process.pid}\n`);
  process.kill(process.pid, "SIGKILL");
}
