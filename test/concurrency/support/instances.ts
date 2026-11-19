import type { Subprocess } from "bun";

/**
 * Instâncias REAIS da aplicação: cada uma é um processo `bun src/main.ts` separado, com porta, pool
 * de conexões e consumer próprios — exatamente como as réplicas em produção (CHALLENGE §8, §13.4).
 */
export interface Instance {
  readonly name: string;
  readonly baseUrl: string;
  readonly proc: Subprocess;
  /** Últimas linhas de log (stdout+stderr), para diagnóstico quando um teste falha. */
  readonly logs: string[];
  kill(signal: "SIGKILL" | "SIGTERM"): Promise<number | null>;
  get alive(): boolean;
}

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port as number;
}

async function collect(stream: ReadableStream<Uint8Array> | null, into: string[]) {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    for (const line of decoder.decode(chunk).split("\n")) {
      if (!line) continue;
      into.push(line);
      if (into.length > 500) into.shift();
    }
  }
}

export async function spawnInstance(
  name: string,
  env: Record<string, string>,
  options: { waitReady?: boolean } = {},
): Promise<Instance> {
  const port = await freePort();
  const logs: string[] = [];
  const proc = Bun.spawn(["bun", "src/main.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      INSTANCE_ID: name,
      ...env,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void collect(proc.stdout, logs);
  void collect(proc.stderr, logs);
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  // Instância que vai morrer de propósito num crash point pode morrer antes de ficar "pronta".
  while (options.waitReady !== false) {
    if (exited) throw new Error(`${name} exited during startup:\n${logs.slice(-30).join("\n")}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) break;
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline)
      throw new Error(`${name} not ready in 30s:\n${logs.slice(-30).join("\n")}`);
    await Bun.sleep(200);
  }
  return {
    name,
    baseUrl,
    proc,
    logs,
    async kill(signal) {
      if (exited) return proc.exitCode;
      proc.kill(signal);
      await proc.exited;
      return proc.exitCode;
    },
    get alive() {
      return !exited;
    },
  };
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.map((i) => i.kill("SIGTERM")));
}

/**
 * Cliente como um provider de verdade: se a instância escolhida não responde (morta, reiniciando) ou
 * devolve 503, reenvia a MESMA requisição (mesma Idempotency-Key) para a próxima.
 */
export async function requestWithFailover(
  instances: () => Instance[],
  start: number,
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
  // biome-ignore lint/suspicious/noExplicitAny: corpo JSON arbitrário
): Promise<{ status: number; body: any; via: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const pool = instances().filter((i) => i.alive);
    const target = pool[(start + attempt) % Math.max(1, pool.length)];
    if (!target) {
      await Bun.sleep(200);
      continue;
    }
    try {
      const res = await fetch(`${target.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...init.headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      if (res.status === 503) {
        lastError = new Error(`503 from ${target.name}`);
        await Bun.sleep(100);
        continue;
      }
      return { status: res.status, body: await res.json(), via: target.name };
    } catch (error) {
      lastError = error; // conexão recusada/derrubada: tenta outra instância
      await Bun.sleep(50);
    }
  }
  throw lastError;
}
