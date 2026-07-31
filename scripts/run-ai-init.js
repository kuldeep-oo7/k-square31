async function main() {
  const secret = process.env.CRON_SECRET || process.env.AI_AUTOMATION_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required");
  const base = process.env.K2_BASE_URL || "https://k-square31.vercel.app";
  const shardCount = Number(process.env.K2_AI_SHARD_COUNT) || 50;
  const concurrency = Math.max(1, Math.min(10, Number(process.env.K2_AI_CONCURRENCY) || 5));
  let completed = 0;
  let trades = 0;
  const failures = [];
  async function runShard(shard) {
    const response = await fetch(`${base}/api/ai-run?shard=${shard}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(95_000)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Shard ${shard}: ${payload.error || response.status}`);
    completed += Number(payload.completed) || 0;
    trades += Number(payload.trades) || 0;
    failures.push(...(payload.failures || []));
    console.log(`Shard ${shard}: ${payload.completed}/${payload.symbols} symbols · ${payload.trades} trades · ${payload.failures.length} feed failures`);
  }
  for (let start = 0; start < shardCount; start += concurrency) {
    const shards = Array.from({ length: Math.min(concurrency, shardCount - start) }, (_, index) => start + index);
    await Promise.all(shards.map(runShard));
  }
  console.log(JSON.stringify({ completed, trades, failures }, null, 2));
  if (failures.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
