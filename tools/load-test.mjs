#!/usr/bin/env node
// Load test for either engine (same MCP tools). Starts N automatic runs, answers plugin
// selections with the engine's recommendation and approvals as a second user, and reports
// timings. Use AGENT_RUNNER=stub on the engine so the test measures orchestration, not AI.
//
//   node tools/load-test.mjs --runs 20 --concurrency 10 [--recipe quarterly-revenue-projection] [--url http://localhost:7400/mcp]
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL_ = arg("url", "http://localhost:7400/mcp");
const RUNS = Number(arg("runs", "20"));
const CONC = Number(arg("concurrency", "10"));
const RECIPE = arg("recipe", "quarterly-revenue-projection");
const INPUTS = RECIPE.startsWith("weekly") ? { sales_csv: "samples/store_sales.csv" } : { actuals_csv: "samples/actuals.csv" };
const RUNNER = process.env.RUNNER_TOKEN ?? "dev-analyst-token";
const APPROVER = process.env.APPROVER_TOKEN ?? "dev-lead-token";

async function call(tool, args, token = RUNNER) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`${tool}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const r = JSON.parse(line.slice(6));
  const out = r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.error);
  if (r.error || r.result?.isError) throw new Error(`${tool}: ${out.slice(0, 300)}`);
  return JSON.parse(out);
}

async function oneRun() {
  const t0 = Date.now();
  let v = await call("plan_run", { recipe_id: RECIPE, inputs: INPUTS, mode: "automatic" });
  const planMs = Date.now() - t0;
  const id = v.run_id;
  let humanMs = 0;
  for (let i = 0; i < 600; i++) {
    if (v.status === "completed") break;
    if (["failed", "cancelled", "interrupted"].includes(v.status)) throw new Error(`${id} ${v.status}: ${v.error}`);
    if (v.status === "needs_selection" && v.pending_selections.length) {
      const p = v.pending_selections[0];
      const h = Date.now();
      v = await call("select_component", { run_id: id, step_id: p.step_id, component_id: p.recommended });
      humanMs += Date.now() - h;
      continue;
    }
    if (v.status === "waiting_approval" && v.pending_approval) {
      const h = Date.now();
      v = await call("approve_step", { run_id: id, step_id: v.pending_approval.step_id, decision: "approve", note: "load test" }, APPROVER);
      humanMs += Date.now() - h;
      continue;
    }
    v = await call("get_run", { run_id: id, wait_seconds: 5 });
  }
  if (v.status !== "completed") throw new Error(`${id} did not complete: ${v.status}`);
  return { id, planMs, totalMs: Date.now() - t0, humanMs, cacheHits: v.steps.filter((s) => s.cache_hit).length, steps: v.steps.length };
}

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const started = Date.now();
const results = [];
const errors = [];
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < RUNS) {
    next++;
    try {
      results.push(await oneRun());
    } catch (e) {
      errors.push(e.message);
    }
  }
}));
const wall = (Date.now() - started) / 1000;
const totals = results.map((r) => r.totalMs);
const plans = results.map((r) => r.planMs);
const summary = {
  engine: URL_, recipe: RECIPE, runs: RUNS, concurrency: CONC, completed: results.length, failed: errors.length,
  wall_seconds: Number(wall.toFixed(1)),
  throughput_runs_per_min: Number(((results.length / wall) * 60).toFixed(1)),
  run_seconds: { p50: (pct(totals, 50) / 1000).toFixed(2), p95: (pct(totals, 95) / 1000).toFixed(2), max: (Math.max(...totals) / 1000).toFixed(2) },
  plan_seconds: { p50: (pct(plans, 50) / 1000).toFixed(2), p95: (pct(plans, 95) / 1000).toFixed(2) },
  steps_per_run: results[0]?.steps ?? null,
  cache_hits_per_run: results.length ? Number((results.reduce((s, r) => s + r.cacheHits, 0) / results.length).toFixed(1)) : 0,
  errors: errors.slice(0, 5),
};
console.log(JSON.stringify(summary, null, 2));
