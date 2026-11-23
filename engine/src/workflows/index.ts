// Recipe workflows. Everything here is deterministic orchestration: no files, no network,
// no clock other than workflow time. All work happens in activities on the worker pools.
// Temporal persists every step, so a run survives worker and engine restarts, and a run
// waiting for a person holds no process or memory.
import {
  ApplicationFailure, CancellationScope, condition, isCancellation,
  proxyActivities, proxyLocalActivities, setHandler, workflowInfo,
} from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import { findStep, flatSteps } from "../shared/shape.js";
import type { LockEntry, Recipe, Step, StepState } from "../shared/types.js";
import type { RecipeRunInput, RunView } from "../shared/view.js";
import type { ExprContext } from "../shared/expr.js";
import type { NewEvent } from "../shared/audit.js";

import { approveUpdate, selectUpdate, startUpdate, stateQuery } from "./defs.js";
export { approveUpdate, selectUpdate, startUpdate, stateQuery };

const QUEUE: Record<string, string> = { code: "code-steps", tool: "tool-steps", skill: "ai-steps" };

const planning = proxyActivities<typeof acts>({
  taskQueue: "discovery",
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3, initialInterval: "2s" },
});
const local = proxyLocalActivities<typeof acts>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

/** Infrastructure failures (a worker dying, a timeout) are retried up to this many extra times. */
const INFRA_RETRIES = 3;

function stepActivities(kind: string, retryMax: number) {
  return proxyActivities<typeof acts>({
    taskQueue: QUEUE[kind] ?? "code-steps",
    startToCloseTimeout: kind === "skill" ? "20 minutes" : kind === "tool" ? "2 minutes" : "10 minutes",
    heartbeatTimeout: kind === "skill" ? "2 minutes" : "30 seconds",
    // Step errors stop after the recipe's retry.max (the activity marks them non-retryable);
    // the extra attempts are only for infrastructure failures.
    retry: { maximumAttempts: retryMax + 1 + INFRA_RETRIES, initialInterval: "1s", backoffCoefficient: 2 },
  });
}

function ms(spec: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(spec.trim());
  if (!m) return 72 * 3600_000;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

const reason = (err: unknown): string => {
  const e = err as { cause?: { message?: string; cause?: { message?: string } }; message?: string };
  return e.cause?.cause?.message ?? e.cause?.message ?? e.message ?? String(err);
};

export async function recipeRun(input: RecipeRunInput): Promise<RunView> {
  const runId = input.runId;
  const state: RunView = {
    run_id: runId, recipe_id: input.recipeId.split("@")[0], recipe_version: "", recipe_title: "", recipe_hash: "",
    mode: input.mode, model: "", user: input.user, status: "planning", started: false,
    created_at: new Date(workflowInfo().startTime).toISOString(), inputs: {}, input_hashes: {}, steps: {},
    pending_selections: [], pending_approval: null, lock: {}, step_counter: 0,
  };
  const approvals: Record<string, NonNullable<StepState["approval"]>> = {};
  const buffer: NewEvent[] = [];
  const emit = (type: string, data: unknown, step: string | null = null) => buffer.push({ type, step_id: step, data });
  const flush = async () => {
    if (buffer.length) await local.audit({ runId, events: buffer.splice(0) });
  };
  const row = (manifest?: unknown) =>
    local.runRow({ run_id: runId, recipe_id: state.recipe_id, recipe_version: state.recipe_version, mode: state.mode, status: state.status, manifest });
  const persistLock = () =>
    local.saveLock({ runId, lock: { recipe: state.recipe_id, recipe_version: state.recipe_version, recipe_hash: state.recipe_hash, model: state.model, steps: state.lock } });
  let recipe: Recipe;

  // ---------------------------------------------------------------- handlers
  setHandler(stateQuery, () => state);

  setHandler(selectUpdate, async ({ step_id, component_id, user }) => {
    const pending = state.pending_selections.find((p) => p.step_id === step_id)!;
    const chosen = pending.candidates.find((c) => c.component_id === component_id)!;
    const runtime = state.started;
    state.lock[step_id] = {
      step_id, source: "discovered", plugin: chosen.plugin, version: chosen.version, sha: chosen.sha, component: chosen.component,
      kind: chosen.kind, resolved_at: runtime ? "runtime" : "preflight", confidence: pending.confidence, reasons: `selected by ${user}`,
      candidates: pending.candidates.map((c) => ({ component_id: c.component_id, score: c.scores.rerank ?? c.scores.fused, card_status: c.card_status, pre_approved: c.pre_approved })),
      approved_by: user, approved_at: new Date().toISOString(),
    };
    state.pending_selections = state.pending_selections.filter((p) => p.step_id !== step_id);
    emit("component_selected", { component_id, sha: chosen.sha, by: user, recommended: pending.recommended, followed_recommendation: pending.recommended === component_id }, step_id);
    await persistLock();
    await planning.warmPlugin({ plugin: chosen.plugin, version: chosen.version, sha: chosen.sha });
    await flush();
    if (!state.pending_selections.length && state.status === "needs_selection") state.status = state.started ? "running" : "ready";
    return state;
  }, {
    validator: ({ step_id, component_id }) => {
      const pending = state.pending_selections.find((p) => p.step_id === step_id);
      if (!pending) throw new Error(`run ${runId} has no pending selection for step ${step_id}`);
      if (!pending.candidates.some((c) => c.component_id === component_id)) {
        throw new Error(`${component_id} is not one of the proposed candidates: ${pending.candidates.map((c) => c.component_id).join(", ")}`);
      }
    },
  });

  setHandler(startUpdate, ({ user }) => {
    state.started = true;
    emit("start_requested", { by: user });
    return state;
  }, {
    validator: (_args: { user: string }) => {
      if (state.started) throw new Error("run already started");
      if (state.status !== "ready") throw new Error(`run cannot start from status ${state.status}`);
    },
  });

  setHandler(approveUpdate, ({ step_id, decision, note, user }) => {
    approvals[step_id] = { decision, by: user, note, at: new Date().toISOString() };
    return state;
  }, {
    validator: ({ step_id, user, roles }) => {
      const p = state.pending_approval;
      if (!p || p.step_id !== step_id) throw new Error(`run ${runId} is not waiting for approval of ${step_id}`);
      if (p.role && !roles.includes(p.role)) throw new Error(`approving ${step_id} needs the role ${p.role}`);
      if (p.exclude_runner && user === state.user) throw new Error(`separation of duties: ${user} started this run and cannot approve it`);
    },
  });

  // ---------------------------------------------------------------- steps
  async function complete(step: Step, key: string, st: StepState, entry: LockEntry, res: Awaited<ReturnType<typeof acts.executeStep>>, ctx: ExprContext) {
    st.status = "completed";
    st.outputs = res.outputs;
    st.output_hashes = res.output_hashes;
    st.reproducibility = res.reproducibility;
    st.component = res.component;
    st.cache_hit = res.cache_hit;
    st.order = ++state.step_counter;
    st.finished_at = new Date().toISOString();
    ctx.steps[step.id] = { outputs: res.outputs };
    emit("step_completed", {
      component: res.component, sha: entry.sha, source: entry.source, reproducibility: res.reproducibility,
      input_hashes: res.input_hashes, output_hashes: res.output_hashes, cache_hit: res.cache_hit, plugin_cached: res.plugin_cached,
      fallback_from: st.fallback_from ?? null, details: res.details,
    }, key);
    await flush();
  }

  async function resolveAtRuntime(step: Step, key: string, ctx: ExprContext): Promise<LockEntry> {
    const done = Object.entries(ctx.steps).filter(([, s]) => !s.skipped).map(([id, s]) => `${id}: ${Object.keys(s.outputs).join(", ")}`).join("; ");
    const d = await planning.discoverStep({
      step, recipeTitle: state.recipe_title, mode: state.mode, threshold: recipe.runtime?.discovery_threshold ?? 0.7,
      model: state.model, stage: "runtime", context: `Completed steps so far: ${done}`,
    });
    emit("discovery", { stage: "runtime", confidence: d.confidence, auto: d.auto, why: d.why, candidates: d.candidates.slice(0, 5).map((c) => ({ id: c.component_id, scores: c.scores, card_status: c.card_status, pre_approved: c.pre_approved })) }, key);
    if (d.entry) {
      state.lock[step.id] = d.entry;
      await persistLock();
      return d.entry;
    }
    state.pending_selections.push(d.pending!);
    state.status = "needs_selection";
    emit("selection_required", { steps: [{ step: step.id, reason: d.why }] }, key);
    await flush();
    await row();
    if (!(await condition(() => !!state.lock[step.id], ms(input.selectionExpiry)))) {
      throw ApplicationFailure.nonRetryable(`no plugin was chosen for ${step.id} within ${input.selectionExpiry}`);
    }
    state.status = "running";
    return state.lock[step.id];
  }

  async function runComponent(step: Step, key: string, ctx: ExprContext, st: StepState) {
    const entry = state.lock[step.id] ?? (await resolveAtRuntime(step, key, ctx));
    const withValues = (await local.interpolateValues({ value: step.with ?? {}, ctx })) as Record<string, unknown>;
    const inputPorts = step.inputs ? ((await local.interpolateValues({ value: step.inputs, ctx })) as Step["inputs"]) : undefined;
    st.status = "running";
    st.started_at = new Date().toISOString();
    emit("step_started", { component: `${entry.plugin}@${entry.version}#${entry.component}`, sha: entry.sha, kind: entry.kind, source: entry.source }, key);
    const call = {
      runId, stepKey: key, stepId: step.id, task: step.task ?? step.title ?? step.id, entry, model: state.model,
      withValues, inputPorts, outputPorts: step.outputs, outName: "out" as const, retryMax: step.retry?.max ?? 0,
    };
    try {
      const res = await stepActivities(entry.kind ?? "code", step.retry?.max ?? 0).executeStep(call);
      st.attempts = 1;
      return complete(step, key, st, entry, res, ctx);
    } catch (err) {
      if (isCancellation(err)) throw err;
      const error = reason(err);
      st.attempts = (step.retry?.max ?? 0) + 1;
      emit("step_failed", { error, attempts_allowed: st.attempts }, key);
      const fbId = step.on_failure?.fallback;
      if (fbId) {
        const fb = findStep(recipe, fbId)!;
        const fbEntry = state.lock[fb.id];
        const fbWith = (await local.interpolateValues({ value: fb.with ?? {}, ctx })) as Record<string, unknown>;
        emit("fallback_started", { fallback: fb.id, component: `${fbEntry.plugin}@${fbEntry.version}#${fbEntry.component}`, after_error: error }, key);
        st.fallback_from = `${entry.plugin}@${entry.version}#${entry.component}`;
        const res = await stepActivities(fbEntry.kind ?? "code", 0).executeStep({ ...call, entry: fbEntry, withValues: fbWith, outName: "fallback", retryMax: 0 });
        return complete(step, key, st, fbEntry, res, ctx);
      }
      if (step.on_failure?.action === "skip") {
        st.status = "skipped";
        st.error = error;
        ctx.steps[step.id] = { outputs: {}, skipped: true };
        emit("step_skipped", { after_error: error }, key);
        return flush();
      }
      st.status = "failed";
      st.error = error;
      throw ApplicationFailure.nonRetryable(`step ${key} failed: ${error}`);
    }
  }

  async function runLoop(step: Step, key: string, ctx: ExprContext, st: StepState) {
    const items = await local.evaluate({ expr: step.foreach!, ctx });
    const list = Array.isArray(items) ? items : items === undefined || items === null ? [] : [items];
    if (list.length > (step.max_items ?? 0)) throw ApplicationFailure.nonRetryable(`foreach ${step.id}: ${list.length} items exceeds max_items ${step.max_items}`);
    st.status = "running";
    const inner = (step.steps ?? []).filter((s) => !s.only_as_fallback);
    const last = inner[inner.length - 1].id;
    const parallel = Math.max(1, step.max_parallel ?? 4);
    const results: Record<string, unknown>[] = new Array(list.length);
    for (let i = 0; i < list.length; i += parallel) {
      await Promise.all(list.slice(i, i + parallel).map(async (item, j) => {
        const idx = i + j;
        const ictx: ExprContext = { ...ctx, steps: { ...ctx.steps }, item, index: idx };
        for (const s of inner) await runStep(s, `${key}[${idx}].${s.id}`, ictx);
        results[idx] = ictx.steps[last]?.outputs ?? {};
      }));
    }
    const merged = await local.mergeLoop({ runId, key, results });
    st.status = "completed";
    st.outputs = merged.outputs;
    st.output_hashes = merged.output_hashes;
    st.order = ++state.step_counter;
    st.finished_at = new Date().toISOString();
    ctx.steps[step.id] = { outputs: merged.outputs };
    emit("loop_completed", { items: list, parallel, output_hashes: merged.output_hashes }, key);
    await flush();
  }

  async function runStep(step: Step, key: string, ctx: ExprContext): Promise<void> {
    const st: StepState = (state.steps[key] ??= { status: "pending", attempts: 0 });
    if (step.when && !(await local.evaluate({ expr: step.when, ctx }))) {
      st.status = "skipped";
      ctx.steps[step.id] = { outputs: {}, skipped: true };
      emit("step_skipped", { when: step.when }, key);
      return flush();
    }
    if (step.type === "approval" || step.approval === "required") {
      const message = String((await local.interpolateValues({ value: step.message ?? `Approve step ${step.id}?`, ctx })) ?? "").trim();
      const rules = step.approvers ?? {};
      const expiry = ms(rules.expires_after ?? input.approvalExpiry);
      st.status = "waiting_approval";
      state.pending_approval = {
        step_id: key, message, role: rules.role ?? null, exclude_runner: !!rules.exclude_runner,
        expires_at: new Date(Date.now() + expiry).toISOString(),
      };
      state.status = "waiting_approval";
      emit("approval_requested", { message, role: rules.role ?? null, exclude_runner: !!rules.exclude_runner, expires_after: rules.expires_after ?? input.approvalExpiry }, key);
      await flush();
      await row();
      const decided = await condition(() => approvals[key] !== undefined, expiry);
      state.pending_approval = null;
      if (!decided) {
        st.status = "failed";
        emit("approval_expired", {}, key);
        throw ApplicationFailure.nonRetryable(`approval for ${key} expired after ${rules.expires_after ?? input.approvalExpiry}`);
      }
      const a = approvals[key];
      st.approval = a;
      emit("approval_decided", { decision: a.decision, by: a.by, note: a.note ?? null }, key);
      if (a.decision === "reject") {
        st.status = "failed";
        throw ApplicationFailure.nonRetryable(`step ${key} rejected by ${a.by}${a.note ? `: ${a.note}` : ""}`);
      }
      state.status = "running";
      if (step.type === "approval") {
        st.status = "completed";
        st.reproducibility = "human";
        st.order = ++state.step_counter;
        st.outputs = { decision: a.decision };
        ctx.steps[step.id] = { outputs: st.outputs };
        return flush();
      }
    }
    if (step.foreach) return runLoop(step, key, ctx, st);
    return runComponent(step, key, ctx, st);
  }

  // ---------------------------------------------------------------- the run
  try {
    const plan = await planning.preparePlan({ runId, recipeId: input.recipeId, inputs: input.inputs, mode: input.mode });
    recipe = plan.recipe;
    Object.assign(state, {
      recipe_id: recipe.recipe, recipe_version: recipe.version, recipe_title: recipe.title, recipe_hash: plan.recipe_hash,
      model: plan.model, inputs: plan.inputs, input_hashes: plan.input_hashes, lock: { ...plan.pinned },
    });
    emit("run_created", { recipe: recipe.recipe, recipe_version: recipe.version, recipe_hash: plan.recipe_hash, mode: input.mode, model: plan.model, user: input.user, inputs: plan.input_summary });
    for (const id of plan.preflight) {
      const step = findStep(recipe, id)!;
      const d = await planning.discoverStep({ step, recipeTitle: recipe.title, mode: input.mode, threshold: plan.threshold, model: plan.model, stage: "preflight" });
      emit("discovery", { stage: "preflight", confidence: d.confidence, auto: d.auto, why: d.why, candidates: d.candidates.slice(0, 5).map((c) => ({ id: c.component_id, scores: c.scores, card_status: c.card_status, pre_approved: c.pre_approved, reason: c.reason ?? null })) }, id);
      if (d.entry) state.lock[id] = d.entry;
      else state.pending_selections.push(d.pending!);
    }
    await persistLock();
    emit("plugins_pinned", { plugins: Object.fromEntries(Object.values(state.lock).map((e) => [`${e.plugin}@${e.version}`, e.sha])) });
    state.status = state.pending_selections.length ? "needs_selection" : "ready";
    if (state.pending_selections.length) emit("selection_required", { steps: state.pending_selections.map((p) => ({ step: p.step_id, reason: p.reason })) });
    await flush();
    await row();

    const expiry = ms(input.selectionExpiry);
    if (!(await condition(() => state.pending_selections.length === 0, expiry))) {
      throw ApplicationFailure.nonRetryable(`no plugin was chosen within ${input.selectionExpiry}`);
    }
    state.status = "ready";
    if (input.autoStart ?? input.mode === "automatic") state.started = true;
    if (!(await condition(() => state.started, expiry))) throw ApplicationFailure.nonRetryable(`run was not started within ${input.selectionExpiry}`);

    state.status = "running";
    emit("run_started", { lock: Object.keys(state.lock).length });
    await flush();
    await row();
    const ctx: ExprContext = { inputs: state.inputs, steps: {} };
    for (const step of flatSteps(recipe)) {
      if (!step.only_as_fallback) await runStep(step, step.id, ctx);
    }
    const outputs = (await local.interpolateValues({ value: recipe.outputs ?? {}, ctx })) as Record<string, unknown>;
    const fin = await local.finalizeRun({
      runId, outputs, lock: state.lock,
      manifest: {
        run_id: runId, recipe: state.recipe_id, recipe_version: state.recipe_version, recipe_hash: state.recipe_hash,
        mode: state.mode, model: state.model, user: state.user, inputs: state.input_hashes,
        steps: Object.entries(state.steps).filter(([, s]) => s.status === "completed" && s.component)
          .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
          .map(([k, s]) => ({ step: k, component: s.component, reproducibility: s.reproducibility, cache_hit: s.cache_hit ?? false, fallback_from: s.fallback_from ?? null, output_hashes: s.output_hashes })),
      },
    });
    state.final_outputs = fin.final_outputs;
    state.report_markdown = fin.report_markdown;
    state.status = "completed";
    await row(fin.manifest);
    return state;
  } catch (err) {
    if (isCancellation(err)) {
      state.status = "cancelled";
      await CancellationScope.nonCancellable(async () => {
        emit("run_cancelled", {});
        await flush();
        await row();
      });
      throw err;
    }
    state.status = "failed";
    state.error = reason(err);
    await CancellationScope.nonCancellable(async () => {
      emit("run_failed", { error: state.error });
      await flush();
      await row();
    });
    throw ApplicationFailure.nonRetryable(state.error);
  }
}

/** Replays a completed run on the code-steps pool and returns the comparison. */
export async function replayWorkflow(view: RunView) {
  const { replayRun } = proxyActivities<typeof acts>({ taskQueue: "code-steps", startToCloseTimeout: "15 minutes" });
  return replayRun(view);
}
