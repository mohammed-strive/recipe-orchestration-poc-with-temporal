// Small activities the workflow runs as local activities in the orchestration worker:
// expression evaluation, loop merging, audit batches, the lock file and run completion.
// Workflow code itself must stay deterministic and cannot touch files or the network.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAudit, runDir, upsertRunRow, type NewEvent } from "../shared/audit.js";
import { evaluateCondition, interpolate, type ExprContext } from "../shared/expr.js";
import type { LockEntry } from "../shared/types.js";
import { hashValue, isFileValue, now, readJson, sha256 } from "../shared/util.js";
import { stepDirOf } from "./steps.js";

export async function interpolateValues(input: { value: unknown; ctx: ExprContext }): Promise<unknown> {
  return interpolate(input.value, input.ctx);
}

export async function evaluate(input: { expr: string; ctx: ExprContext }): Promise<unknown> {
  return evaluateCondition(input.expr, input.ctx);
}

export async function audit(input: { runId: string; events: NewEvent[] }): Promise<string> {
  return appendAudit(input.runId, input.events);
}

export async function saveLock(input: { runId: string; lock: Record<string, unknown> }): Promise<string> {
  mkdirSync(runDir(input.runId), { recursive: true });
  const text = JSON.stringify({ ...input.lock, updated_at: now() }, null, 2);
  writeFileSync(join(runDir(input.runId), "recipe.lock.json"), text);
  return sha256(text);
}

/** Merges loop iterations: table outputs are concatenated into one file, scalars become lists. */
export async function mergeLoop(input: { runId: string; key: string; results: Record<string, unknown>[] }) {
  const outDir = join(stepDirOf(input.runId, input.key), "out");
  mkdirSync(outDir, { recursive: true });
  const merged: Record<string, unknown> = {};
  for (const port of new Set(input.results.flatMap((r) => Object.keys(r)))) {
    const values = input.results.map((r) => r[port]);
    if (values.every((v) => isFileValue(v) && Array.isArray(readJson(v)))) {
      const file = join(outDir, `${port}.json`);
      writeFileSync(file, JSON.stringify(values.flatMap((v) => readJson<unknown[]>(v as string)), null, 2));
      merged[port] = file;
    } else merged[port] = values;
  }
  return { outputs: merged, output_hashes: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, hashValue(v)])) };
}

export async function runRow(input: { run_id: string; recipe_id: string; recipe_version: string; mode: string; status: string; manifest?: unknown }) {
  await upsertRunRow(input, input.manifest ?? null);
}

/** Copies final outputs, writes the manifest, returns the report text for thin clients. */
export async function finalizeRun(input: {
  runId: string; outputs: Record<string, unknown>; manifest: Record<string, unknown>; lock: Record<string, LockEntry>;
}) {
  const outDir = join(runDir(input.runId), "outputs");
  mkdirSync(outDir, { recursive: true });
  const final: Record<string, unknown> = {};
  const hashes: Record<string, unknown> = {};
  let report: string | null = null;
  for (const [name, v] of Object.entries(input.outputs)) {
    if (isFileValue(v)) {
      const dest = join(outDir, `${name}.json`);
      copyFileSync(v, dest);
      const doc = readJson<{ markdown?: string }>(dest);
      if (doc && typeof doc.markdown === "string") {
        writeFileSync(join(outDir, `${name}.md`), doc.markdown);
        report ??= doc.markdown;
      }
      final[name] = dest;
      hashes[name] = { file: basename(dest), sha256: hashValue(dest) };
    } else {
      final[name] = v;
      hashes[name] = { file: null, sha256: hashValue(v) };
    }
  }
  const lockText = readFileSync(join(runDir(input.runId), "recipe.lock.json"));
  const manifest = {
    ...input.manifest,
    lock_sha256: sha256(lockText),
    plugins: Object.fromEntries(Object.values(input.lock).map((e) => [`${e.plugin}@${e.version}`, e.sha])),
    outputs: hashes,
    completed_at: now(),
  };
  const head = await appendAudit(input.runId, [{ type: "run_completed", data: { outputs: hashes } }]);
  const withHead = { ...manifest, audit_head: head };
  writeFileSync(join(runDir(input.runId), "manifest.json"), JSON.stringify(withHead, null, 2));
  return { final_outputs: final, report_markdown: report, manifest: withHead };
}
