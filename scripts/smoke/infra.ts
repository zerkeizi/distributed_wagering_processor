const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";

/** Mostra o balanceamento entre réplicas, a readiness das dependências e as métricas expostas. */
export async function smokeInfra(): Promise<void> {
  console.log(`→ ${BASE_URL}\n`);

  console.log("1) GET / (10x) — qual réplica atendeu:");
  const hits = new Map<string, number>();
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE_URL}/`);
    const body = (await res.json()) as { instanceId: string };
    hits.set(body.instanceId, (hits.get(body.instanceId) ?? 0) + 1);
  }
  for (const [instance, count] of hits) console.log(`   ${instance}: ${count}`);
  console.log(`   ${hits.size} réplica(s) distinta(s)\n`);

  console.log("2) GET /health/live e /health/ready:");
  const live = await fetch(`${BASE_URL}/health/live`);
  console.log(`   live  → ${live.status}`);
  const ready = await fetch(`${BASE_URL}/health/ready`);
  console.log(`   ready → ${ready.status} ${JSON.stringify(await ready.json())}\n`);

  console.log("3) X-Correlation-Id ecoado na resposta:");
  const echoed = await fetch(`${BASE_URL}/`, { headers: { "x-correlation-id": "smoke-123" } });
  console.log(`   enviado smoke-123 → recebido ${echoed.headers.get("x-correlation-id")}\n`);

  console.log("4) GET /metrics — séries do domínio declaradas:");
  const metrics = await (await fetch(`${BASE_URL}/metrics`)).text();
  const names = [...new Set(metrics.match(/^# TYPE (wagering_\w+)/gm) ?? [])];
  for (const line of names) console.log(`   ${line.replace("# TYPE ", "")}`);
}
