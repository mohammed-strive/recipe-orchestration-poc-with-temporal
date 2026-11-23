// Tamper-evident audit log: append-only JSONL per run, every event hash-chained to the one
// before. Events are appended in batches (one call per step or decision, not per event),
// under a file lock so several processes can append to the same run safely, and mirrored to
// Postgres in one multi-row insert per batch.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { canonical, now, sha256, sleep } from "./util.js";

export interface AuditEvent {
  run_id: string;
  seq: number;
  ts: string;
  type: string;
  step_id: string | null;
  data: unknown;
  prev_hash: string;
  hash: string;
}

export interface NewEvent {
  type: string;
  step_id?: string | null;
  data: unknown;
}

const GENESIS = "0".repeat(64);
let pool: pg.Pool | null = null;
const db = () => (pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 4 }));

export const runDir = (runId: string) => join(config.runsDir, runId);
export const auditPath = (dir: string) => join(dir, "audit.jsonl");

export function readAudit(dir: string): AuditEvent[] {
  const p = auditPath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEvent);
}

function eventHash(e: Omit<AuditEvent, "hash">): string {
  return sha256(e.prev_hash + canonical({ run_id: e.run_id, seq: e.seq, ts: e.ts, type: e.type, step_id: e.step_id, data: e.data }));
}

async function withLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = join(dir, "audit.lock");
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      // Break locks left behind by a crashed process.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
      } catch { /* gone already */ }
      if (i > 600) throw new Error(`audit lock busy for run ${dir}`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* ignore */ }
  }
}

/** Appends events to a run's chain and returns the new head hash. */
export async function appendAudit(runId: string, events: NewEvent[]): Promise<string> {
  if (!events.length) return "";
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const written = await withLock(dir, () => {
    const existing = readAudit(dir);
    let seq = existing.length ? existing[existing.length - 1].seq : 0;
    let prev = existing.length ? existing[existing.length - 1].hash : GENESIS;
    const out: AuditEvent[] = [];
    for (const e of events) {
      const base = { run_id: runId, seq: ++seq, ts: now(), type: e.type, step_id: e.step_id ?? null, data: e.data, prev_hash: prev };
      const event = { ...base, hash: eventHash(base) };
      out.push(event);
      prev = event.hash;
    }
    appendFileSync(auditPath(dir), out.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return out;
  });
  if (config.auditMode === "central") await syncCentral(runId, written);
  return written[written.length - 1].hash;
}

async function syncCentral(runId: string, batch: AuditEvent[]) {
  try {
    // Catch up anything a previous failed sync missed, then insert in one statement.
    const { rows } = await db().query("select coalesce(max(seq), 0)::int as max from audit_events where run_id = $1", [runId]);
    const missing = readAudit(runDir(runId)).filter((e) => e.seq > rows[0].max);
    const events = missing.length ? missing : batch;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      values.push(e.run_id, e.seq, e.ts, e.type, e.step_id, JSON.stringify(e.data), e.prev_hash, e.hash);
      const b = i * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    });
    await db().query(
      `insert into audit_events (run_id, seq, ts, type, step_id, data, prev_hash, hash) values ${tuples.join(",")} on conflict do nothing`,
      values,
    );
  } catch (err) {
    console.warn(`audit: central store unavailable, events kept in the run directory (${(err as Error).message})`);
  }
}

export function verifyChain(dir: string): { valid: boolean; events: number; head: string; broken_at?: number } {
  const events = readAudit(dir);
  let prev = GENESIS;
  for (const e of events) {
    const { hash, ...rest } = e;
    if (e.prev_hash !== prev || eventHash(rest) !== hash) return { valid: false, events: events.length, head: prev, broken_at: e.seq };
    prev = hash;
  }
  return { valid: true, events: events.length, head: prev };
}

export async function upsertRunRow(run: { run_id: string; recipe_id: string; recipe_version: string; mode: string; status: string }, manifest: unknown = null) {
  if (config.auditMode !== "central") return;
  try {
    await db().query(
      `insert into runs (run_id, recipe, recipe_version, mode, status, manifest) values ($1,$2,$3,$4,$5,$6)
       on conflict (run_id) do update set status = excluded.status, manifest = coalesce(excluded.manifest, runs.manifest), updated_at = now()`,
      [run.run_id, run.recipe_id, run.recipe_version, run.mode, run.status, manifest === null ? null : JSON.stringify(manifest)],
    );
  } catch { /* optional */ }
}
