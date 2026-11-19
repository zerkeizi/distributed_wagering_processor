/**
 * Corrida real contra as 3 réplicas atrás do nginx (compose rodando: bun run infra:up).
 *   1) CHALLENGE §8: saldo 100.00, duas BETs de 80.00 disparadas ao mesmo tempo.
 *   2) A mesma BET enviada 50 vezes em paralelo.
 *
 * A API não expõe qual réplica atendeu. Como num diagnóstico de verdade, cada requisição sai com
 * um X-Correlation-Id próprio, e o smoke encontra a réplica procurando esse id nos logs internos
 * (`docker compose logs app`).
 */
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";
const RUN = `race-${Date.now()}`;
let sequence = 0;

interface Reply {
  readonly correlationId: string;
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: inspeção livre do JSON de resposta
  readonly body: any;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  sequence += 1;
  const correlationId = `${RUN}-${sequence}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-correlation-id": correlationId, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { correlationId, status: res.status, body: await res.json() };
}

/** correlationId → instanceId, lido das linhas JSON de log das réplicas. */
async function replicasFromLogs(): Promise<Map<string, string>> {
  // O log de "request completed" é escrito logo após a resposta; dá um instante para o flush.
  await Bun.sleep(500);
  const proc = Bun.spawn(
    ["docker", "compose", "logs", "--no-color", "--no-log-prefix", "--since", "5m", "app"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = await new Response(proc.stdout).text();
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line.includes(RUN)) continue;
    try {
      const entry = JSON.parse(line) as { correlationId?: string; instanceId?: string };
      if (entry.correlationId && entry.instanceId) map.set(entry.correlationId, entry.instanceId);
    } catch {
      // linha que não é JSON
    }
  }
  return map;
}

async function createWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const res = await call("POST", "/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  if (res.status !== 201)
    throw new Error(`create wallet: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId };
}

function bet(
  w: { walletId: string; playerId: string },
  amount: string,
  ext = `bet-${crypto.randomUUID()}`,
) {
  return {
    key: `provider-a:${ext}`,
    body: {
      providerId: "provider-a",
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  };
}

async function summary(walletId: string) {
  const [wallet, ledger, reconciliation] = await Promise.all([
    call("GET", `/wallets/${walletId}`),
    call("GET", `/wallets/${walletId}/ledger`),
    call("POST", `/wallets/${walletId}/reconciliation`),
  ]);
  const debits = ledger.body.items.filter(
    (i: { direction: string }) => i.direction === "DEBIT",
  ).length;
  console.log(
    `   saldo final ${wallet.body.balance.amount} · lançamentos de débito: ${debits} · reconciliação consistente: ${reconciliation.body.consistent}`,
  );
}

export async function smokeRace(): Promise<void> {
  console.log(`→ ${BASE_URL}\n`);

  const w1 = await createWallet("100.00");
  const pair = await Promise.all(
    [bet(w1, "80.00"), bet(w1, "80.00")].map((b) =>
      call("POST", "/wagering/transactions", b.body, { "idempotency-key": b.key }),
    ),
  );

  const w2 = await createWallet("100.00");
  const same = bet(w2, "25.00");
  const replies = await Promise.all(
    Array.from({ length: 50 }, () =>
      call("POST", "/wagering/transactions", same.body, { "idempotency-key": same.key }),
    ),
  );

  const replicaOf = await replicasFromLogs();
  const replica = (r: Reply) => replicaOf.get(r.correlationId) ?? "?";

  console.log(
    "1) Saldo 100.00, duas BETs de 80.00 ao mesmo tempo (réplica encontrada pelos logs):",
  );
  for (const r of pair) {
    const failure = r.body.failureCode ? ` (${r.body.failureCode})` : "";
    console.log(
      `   [${replica(r)}] ${r.status} ${r.body.status}${failure} → saldo ${r.body.balance.amount}`,
    );
  }
  await summary(w1.walletId);

  console.log("\n2) A mesma BET de 25.00 enviada 50 vezes em paralelo:");
  const byStatus = new Map<number, number>();
  const byReplica = new Map<string, number>();
  for (const r of replies) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    byReplica.set(replica(r), (byReplica.get(replica(r)) ?? 0) + 1);
  }
  console.log(`   status: ${[...byStatus].map(([s, n]) => `${n}× ${s}`).join(", ")}`);
  console.log(`   réplicas: ${[...byReplica].map(([id, n]) => `${id}=${n}`).join(", ")}`);
  console.log(
    `   transactionIds distintos nas respostas: ${new Set(replies.map((r) => r.body.transactionId)).size}`,
  );
  await summary(w2.walletId);
}
