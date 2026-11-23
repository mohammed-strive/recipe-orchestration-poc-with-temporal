// Planning activities, run by the discovery worker pool.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { runDir } from "../shared/audit.js";
import { config, REPO_ROOT } from "../shared/config.js";
import { cardFor, materializePlugin } from "../shared/materialize.js";
import { allSteps, getRecipe, isOpenStep, validateRecipe } from "../shared/recipe.js";
import { discover, type Discovery } from "../shared/resolver.js";
import type { LockEntry, Mode, Recipe, Step } from "../shared/types.js";
import { hashValue, isFileValue } from "../shared/util.js";
import { ApplicationFailure } from "@temporalio/common";

export interface PlanInput {
  runId: string;
  recipeId: string;
  inputs: Record<string, unknown>;
  mode: Mode;
}

export interface Plan {
  recipe: Recipe;
  recipe_hash: string;
  recipe_dir: string;
  model: string;
  threshold: number;
  inputs: Record<string, unknown>;
  input_hashes: Record<string, string>;
  input_summary: Record<string, unknown>;
  pinned: Record<string, LockEntry>;
  /** Open steps resolved before the run starts. */
  preflight: string[];
}

const invalid = (message: string) => ApplicationFailure.create({ type: "PlanError", message, nonRetryable: true });

function resolveInputs(recipe: Recipe, dir: string, provided: Record<string, unknown>, runId: string) {
  const values: Record<string, unknown> = {};
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of Object.keys(provided)) if (!(k in (recipe.inputs ?? {}))) throw invalid(`unknown input ${k}`);
  for (const [name, spec] of Object.entries(recipe.inputs ?? {})) {
    let v = provided[name] ?? spec.default;
    if (v === undefined || v === null || v === "") {
      if (spec.required) missing.push(name);
      continue;
    }
    if (spec.type === "file") {
      const candidates = isAbsolute(String(v)) ? [String(v)] : [resolve(dir, String(v)), resolve(REPO_ROOT, String(v))];
      const found = candidates.find((p) => existsSync(p));
      if (!found) throw invalid(`input ${name}: file not found on the engine (${v}). Upload it or use a recipe sample path.`);
      if (statSync(found).size > config.maxInputBytes) throw invalid(`input ${name} exceeds the ${config.maxInputBytes}-byte limit`);
      const dest = join(runDir(runId), "inputs", `${name}-${basename(found)}`);
      mkdirSync(join(runDir(runId), "inputs"), { recursive: true });
      copyFileSync(found, dest);
      v = dest;
    } else if (spec.type === "integer" || spec.type === "number") {
      v = Number(v);
      if (Number.isNaN(v)) throw invalid(`input ${name} must be a number`);
    } else if (spec.type === "enum" && spec.values && !spec.values.includes(v)) {
      throw invalid(`input ${name} must be one of ${spec.values.join(", ")}`);
    }
    values[name] = v;
    hashes[name] = hashValue(v);
  }
  if (missing.length) throw invalid(`missing required inputs: ${missing.join(", ")}`);
  return { values, hashes };
}

export async function preparePlan(input: PlanInput): Promise<Plan> {
  let lr;
  try {
    lr = getRecipe(input.recipeId);
  } catch (err) {
    throw invalid((err as Error).message);
  }
  const problems = validateRecipe(lr.recipe);
  if (problems.length) throw invalid(`recipe ${input.recipeId} is invalid:\n- ${problems.join("\n- ")}`);
  const r = lr.recipe;
  mkdirSync(runDir(input.runId), { recursive: true });
  const { values, hashes } = resolveInputs(r, lr.dir, input.inputs, input.runId);

  // Pinned steps: resolve kinds from the plugin's own cards (plugin cached by SHA).
  const pinned: Record<string, LockEntry> = {};
  for (const step of allSteps(r)) {
    if (!step.uses) continue;
    const [plugin, component] = step.uses.split("#");
    const pin = r.plugins[plugin];
    const { dir } = materializePlugin(plugin, pin.version, pin.sha);
    const card = cardFor(dir, component);
    pinned[step.id] = { step_id: step.id, source: "pinned", plugin, version: pin.version, sha: pin.sha, component, kind: card.kind };
  }
  return {
    recipe: r,
    recipe_hash: lr.hash,
    recipe_dir: lr.dir,
    model: r.runtime?.model ?? config.defaultModel,
    threshold: r.runtime?.discovery_threshold ?? 0.7,
    inputs: values,
    input_hashes: hashes,
    input_summary: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isFileValue(v) ? { file: basename(v), sha256: hashes[k] } : v])),
    pinned,
    preflight: allSteps(r).filter((s) => isOpenStep(s) && s.discovery?.resolve !== "runtime").map((s) => s.id),
  };
}

export async function discoverStep(input: {
  step: Step; recipeTitle: string; mode: Mode; threshold: number; model: string; stage: "preflight" | "runtime"; context?: string;
}): Promise<Discovery> {
  const d = await discover(input);
  if (d.entry) materializePlugin(d.entry.plugin, d.entry.version, d.entry.sha); // warm the cache for the step
  return d;
}

/** Called when a person picks a candidate: warm the plugin cache before the step needs it. */
export async function warmPlugin(input: { plugin: string; version: string; sha: string }): Promise<boolean> {
  return materializePlugin(input.plugin, input.version, input.sha).cached;
}
