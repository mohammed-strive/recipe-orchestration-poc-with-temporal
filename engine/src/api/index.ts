// Engine API: a stateless MCP server. It authenticates the caller, applies permissions and
// admission control, and talks to Temporal. It never runs steps. Any number of replicas can
// run side by side because all run state lives in Temporal (and audit files in shared storage).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client, Connection, WorkflowNotFoundError, type WorkflowHandle } from "@temporalio/client";
import type { UpdateDefinition } from "@temporalio/common";
import { z } from "zod";
import { readAudit, runDir, verifyChain } from "../shared/audit.js";
import { config } from "../shared/config.js";
import { evaluateRun } from "../shared/evals.js";
import { flatSteps, getRecipe, isOpenStep, loadRecipes, validateRecipe } from "../shared/recipe.js";
import { findRecipes } from "../shared/recipeSearch.js";
import type { Step } from "../shared/types.js";
import { sleep } from "../shared/util.js";
import type { RecipeRunInput, RunView } from "../shared/view.js";
import type { recipeRun, replayWorkflow } from "../workflows/index.js";
import { approveUpdate, selectUpdate, startUpdate, stateQuery } from "../workflows/defs.js";
import { authenticate, can, type Principal } from "./auth.js";
import { generateCards } from "./cards.js";

const connection = await Connection.connect({ address: config.temporalAddress });
const temporal = new Client({ connection, namespace: config.temporalNamespace });

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function newRunId(recipeId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${recipeId.split("@")[0]}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

async function view(handle: WorkflowHandle<typeof recipeRun>): Promise<RunView> {
  try {
    return await handle.query(stateQuery);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) throw err;
    // A finished run returns its final state as the workflow result, which Temporal stores:
    // read that instead of asking a worker to replay the history.
    const desc = await handle.describe().catch(() => null);
    if (desc?.status.name === "COMPLETED") return (await handle.result()) as RunView;
    if (desc && desc.status.name !== "RUNNING") {
      await sleep(500);
      try { return await handle.query(stateQuery); } catch { /* fall through */ }
    }
    // Temporal answers queries through a workflow worker. If none is running, say so plainly:
    // the run itself is safe in Temporal and continues when workers return.
    const d = await handle.describe().catch(() => null);
    throw new Error(
      `run state is temporarily unavailable (Temporal status: ${d?.status.name ?? "unknown"}). ` +
        "No orchestration worker is answering; the run is persisted and will continue when workers are back.",
    );
  }
}

/** Loads a run the caller may see: its owner, an auditor or an admin. */
async function readable(p: Principal, runId: string, write = false) {
  const handle = temporal.workflow.getHandle<typeof recipeRun>(runId);
  let v: RunView;
  try {
    v = await view(handle);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) throw new Error(`Unknown run ${runId}`);
    throw err;
  }
  const allowed = v.user === p.user || can(p, "admin") || (!write && can(p, "auditor"));
  if (!allowed) throw new Error(`Unknown run ${runId}`); // do not reveal other users' runs
  return { handle, v };
}

/** Runs a workflow update and surfaces the run's own reason when it refuses one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function update<A extends [any, ...any[]]>(handle: WorkflowHandle<typeof recipeRun>, def: UpdateDefinition<RunView, A>, args: A): Promise<RunView> {
  try {
    return await handle.executeUpdate(def, { args });
  } catch (err) {
    const e = err as { cause?: { message?: string }; message?: string };
    throw new Error(e.cause?.message ?? e.message ?? String(err));
  }
}

function summarize(v: RunView) {
  return {
    run_id: v.run_id,
    recipe: `${v.recipe_id}@${v.recipe_version}`,
    mode: v.mode,
    user: v.user,
    model: v.model,
    status: v.status,
    error: v.error ?? null,
    pending_selections: v.pending_selections.map((p) => ({
      step_id: p.step_id, task: p.task, reason: p.reason, recommended: p.recommended, confidence: p.confidence,
      candidates: p.candidates.map((c) => ({ component_id: c.component_id, kind: c.kind, summary: c.summary, card_status: c.card_status, pre_approved: c.pre_approved, scores: c.scores, reason: c.reason ?? null })),
    })),
    pending_approval: v.pending_approval,
    steps: Object.entries(v.steps).map(([key, s]) => ({
      step: key, status: s.status, component: s.component ?? null, reproducibility: s.reproducibility ?? null,
      cache_hit: s.cache_hit ?? false, fallback_from: s.fallback_from ?? null, error: s.error ?? null,
    })),
    lock: Object.values(v.lock).map((e) => ({ step: e.step_id, source: e.source, component: `${e.plugin}@${e.version}#${e.component}`, sha: e.sha.slice(0, 12), approved_by: e.approved_by ?? null, confidence: e.confidence ?? null })),
    final_outputs: v.final_outputs ?? null,
    report_markdown: v.report_markdown ?? null,
    temporal_ui: `http://localhost:8233/namespaces/${config.temporalNamespace}/workflows/${v.run_id}`,
  };
}

async function waitFor(handle: WorkflowHandle<typeof recipeRun>, done: (v: RunView) => boolean, seconds: number): Promise<RunView> {
  const deadline = Date.now() + seconds * 1000;
  let v = await view(handle);
  while (!done(v) && Date.now() < deadline) {
    await sleep(300);
    v = await view(handle);
  }
  return v;
}

async function activeRuns(user: string): Promise<number> {
  let n = 0;
  for await (const w of temporal.workflow.list({ query: `WorkflowType = 'recipeRun' AND ExecutionStatus = 'Running'` })) {
    if ((w.memo as { user?: string } | undefined)?.user === user) n++;
  }
  return n;
}

function describeStep(s: Step): unknown {
  if (s.foreach) return { id: s.id, kind: "loop", foreach: s.foreach, max_parallel: s.max_parallel ?? 4, steps: (s.steps ?? []).map(describeStep) };
  if (s.type === "approval") return { id: s.id, kind: "approval", when: s.when ?? null, approvers: s.approvers ?? null };
  return { id: s.id, kind: s.uses ? "pinned" : "discover", uses: s.uses ?? null, task: s.task ?? null, when: s.when ?? null, fallback: s.on_failure?.fallback ?? null, only_as_fallback: s.only_as_fallback ?? false };
}

function buildServer(p: Principal): McpServer {
  const server = new McpServer({ name: "recipe-engine", version: "0.2.0-temporal" });

  server.registerTool("whoami", { title: "Who am I", description: "The authenticated user and roles.", inputSchema: {} }, async () => ok(p));

  server.registerTool("list_recipes", { title: "List recipes", description: "All recipes in the recipes repository.", inputSchema: {} },
    async () => ok(loadRecipes().map(({ recipe: r }) => ({ recipe_id: `${r.recipe}@${r.version}`, title: r.title, industry: r.industry ?? null, description: r.description, valid: validateRecipe(r).length === 0 }))));

  server.registerTool("find_recipe", {
    title: "Find a recipe", description: "Propose the recipes that best match a request. The user confirms the choice.",
    inputSchema: { request: z.string(), limit: z.number().int().optional() },
  }, async ({ request, limit }) => ok({ candidates: await findRecipes(request, limit ?? 3) }));

  server.registerTool("describe_recipe", {
    title: "Describe a recipe", description: "Inputs, blocks and steps of a recipe.",
    inputSchema: { recipe_id: z.string() },
  }, async ({ recipe_id }) => {
    const { recipe: r } = getRecipe(recipe_id);
    return ok({
      recipe_id: `${r.recipe}@${r.version}`, title: r.title, description: r.description, inputs: r.inputs, pinned_plugins: r.plugins,
      runtime: r.runtime ?? {}, blocks: r.blocks.map((b) => ({ id: b.id, title: b.title, steps: b.steps.map(describeStep) })),
      outputs: r.outputs, problems: validateRecipe(r),
      open_steps: flatSteps(r).flatMap((s) => [s, ...(s.steps ?? [])]).filter(isOpenStep).map((s) => s.id),
    });
  });

  server.registerTool("plan_run", {
    title: "Plan a run",
    description: "Start a durable run: validate, resolve inputs, pin and discover plugins, write the lock file. Interactive runs wait for confirmation and start_run; automatic runs start unless a person must choose a plugin.",
    inputSchema: { recipe_id: z.string(), inputs: z.record(z.string(), z.any()).optional(), mode: z.enum(["interactive", "automatic"]).optional(), auto_start: z.boolean().optional() },
  }, async ({ recipe_id, inputs, mode, auto_start }) => {
    if (!can(p, "analyst")) throw new Error(`${p.user} may not run recipes`);
    const active = await activeRuns(p.user);
    if (active >= config.maxActiveRunsPerUser) throw new Error(`quota: ${p.user} already has ${active} active runs (limit ${config.maxActiveRunsPerUser})`);
    const runId = newRunId(recipe_id);
    const input: RecipeRunInput = {
      runId, recipeId: recipe_id, inputs: inputs ?? {}, mode: mode ?? "interactive", autoStart: auto_start, user: p.user,
      selectionExpiry: config.defaultApprovalExpiry, approvalExpiry: config.defaultApprovalExpiry,
    };
    const handle = await temporal.workflow.start<typeof recipeRun>("recipeRun", {
      taskQueue: config.queues.orchestration, workflowId: runId, args: [input], memo: { user: p.user, recipe: recipe_id, mode: input.mode },
    });
    const v = await waitFor(handle, (s) => s.status !== "planning", 120);
    return ok(summarize(v));
  });

  server.registerTool("select_component", {
    title: "Select a discovered plugin", description: "Choose one of the proposed candidates for a step. Validated by the run before it is accepted.",
    inputSchema: { run_id: z.string(), step_id: z.string(), component_id: z.string() },
  }, async ({ run_id, step_id, component_id }) => {
    const { handle } = await readable(p, run_id, true);
    await update(handle, selectUpdate, [{ step_id, component_id, user: p.user }]);
    return ok(summarize(await waitFor(handle, (s) => s.status !== "needs_selection" || !s.pending_selections.some((x) => x.step_id === step_id), 5)));
  });

  server.registerTool("start_run", {
    title: "Start a run", description: "Start a planned interactive run. Runs survive restarts on their own, so there is no resume step.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    const { handle } = await readable(p, run_id, true);
    await update(handle, startUpdate, [{ user: p.user }]);
    return ok(summarize(await waitFor(handle, (s) => s.status !== "ready", 5)));
  });

  server.registerTool("approve_step", {
    title: "Approve or reject a step",
    description: "Decide on a step waiting for approval. The run checks the approver's role and separation of duties before accepting.",
    inputSchema: { run_id: z.string(), step_id: z.string(), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
  }, async ({ run_id, step_id, decision, note }) => {
    const handle = temporal.workflow.getHandle<typeof recipeRun>(run_id);
    await update(handle, approveUpdate, [{ step_id, decision, note, user: p.user, roles: p.roles }]);
    return ok(summarize(await waitFor(handle, (s) => s.pending_approval?.step_id !== step_id, 5)));
  });

  server.registerTool("get_run", {
    title: "Get run status", description: "Status, steps, pending selections or approvals, lock and outputs. wait_seconds (max 25) waits for progress.",
    inputSchema: { run_id: z.string(), wait_seconds: z.number().optional() },
  }, async ({ run_id, wait_seconds }) => {
    const { handle, v: first } = await readable(p, run_id);
    const v = await waitFor(handle, (s) => s.status !== first.status || s.step_counter !== first.step_counter, Math.min(wait_seconds ?? 0, 25));
    return ok(summarize(v));
  });

  server.registerTool("cancel_run", {
    title: "Cancel a run", description: "Stop a run (kill switch). Recorded in the audit log.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    const { handle } = await readable(p, run_id, true);
    await handle.cancel();
    return ok(summarize(await waitFor(handle, (s) => s.status === "cancelled", 10)));
  });

  server.registerTool("list_runs", {
    title: "List runs", description: "Recent runs, newest first. Auditors see every user's runs.",
    inputSchema: { limit: z.number().int().optional() },
  }, async ({ limit }) => {
    const out: unknown[] = [];
    for await (const w of temporal.workflow.list({ query: `WorkflowType = 'recipeRun'` })) {
      const memo = (w.memo ?? {}) as { user?: string; recipe?: string; mode?: string };
      if (memo.user !== p.user && !can(p, "auditor")) continue;
      out.push({ run_id: w.workflowId, recipe: memo.recipe, mode: memo.mode, user: memo.user, temporal_status: w.status.name, started: w.startTime });
      if (out.length >= (limit ?? 20)) break;
    }
    return ok(out);
  });

  server.registerTool("replay_run", {
    title: "Replay a run", description: "Rebuild a completed run without AI or data sources and check the outputs are identical. Runs on the code-steps pool.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    const { v } = await readable(p, run_id);
    if (v.status !== "completed") throw new Error(`only completed runs can be replayed (status: ${v.status})`);
    const result = await temporal.workflow.execute<typeof replayWorkflow>("replayWorkflow", { taskQueue: config.queues.orchestration, workflowId: `${run_id}-replay-${Date.now()}`, args: [v] });
    return ok(result);
  });

  server.registerTool("evaluate_run", {
    title: "Evaluate a run", description: "Run the recipe's evals against a completed run and return a confidence score.",
    inputSchema: { run_id: z.string() },
  }, async ({ run_id }) => {
    const { v } = await readable(p, run_id);
    return ok(await evaluateRun(v));
  });

  server.registerTool("get_audit_log", {
    title: "Get audit log", description: "A run's audit events and a check that the hash chain is intact.",
    inputSchema: { run_id: z.string(), last: z.number().int().optional() },
  }, async ({ run_id, last }) => {
    await readable(p, run_id);
    const dir = runDir(run_id);
    const manifest = join(dir, "manifest.json");
    return ok({
      chain: verifyChain(dir),
      events: readAudit(dir).slice(-(last ?? 50)).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, step: e.step_id, data: e.data })),
      manifest: existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : null,
    });
  });

  server.registerTool("generate_capability_cards", {
    title: "Generate capability cards", description: "Draft capability cards with AI for a plugin version that has none (card_status: generated).",
    inputSchema: { plugin: z.string(), version: z.string().optional() },
  }, async ({ plugin, version }) => {
    if (!can(p, "admin") && !can(p, "plugin-owner")) throw new Error("generating capability cards needs the plugin-owner role");
    return ok(await generateCards(plugin, version));
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.post("/mcp", async (req, res) => {
  const principal = authenticate(req.header("authorization"));
  if (!principal) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "missing or invalid bearer token" }, id: null });
    return;
  }
  const server = buildServer(principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});
app.get("/health", (_req, res) => res.json({ ok: true, temporal: config.temporalAddress }));
app.listen(config.apiPort, config.apiHost, () => console.log(`engine API on http://${config.apiHost}:${config.apiPort}/mcp (Temporal ${config.temporalAddress})`));
