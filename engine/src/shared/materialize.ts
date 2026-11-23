// Plugin cache shared by every run and worker on this node: each plugin is cloned once per
// commit SHA into <data>/plugin-cache/<plugin>@<sha> and treated as read-only afterwards.
// A pinned commit never changes, so the cache never needs invalidating.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Card } from "./types.js";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function pluginDir(plugin: string, sha: string): string {
  return join(config.pluginCacheDir, `${plugin}@${sha}`);
}

/** Returns the cached checkout of plugin@sha, cloning it first if this node has not seen it. */
export function materializePlugin(plugin: string, version: string, sha: string): { dir: string; cached: boolean } {
  const dir = pluginDir(plugin, sha);
  if (existsSync(join(dir, ".ready"))) return { dir, cached: true };
  mkdirSync(config.pluginCacheDir, { recursive: true });
  const tmp = `${dir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const url = `${config.gitBaseUrl}/${plugin}.git`;
  try {
    git(["clone", "--quiet", url, tmp]);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Could not clone ${url}. Is the git-server running? ${(err as Error).message}`);
  }
  const tagSha = git(["rev-parse", `v${version}^{commit}`], tmp);
  if (tagSha !== sha) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`${plugin} v${version} is at ${tagSha} in the marketplace, but the recipe or lock pins ${sha}`);
  }
  git(["checkout", "--quiet", sha], tmp);
  checkPythonLock(tmp, plugin);
  execFileSync("touch", [join(tmp, ".ready")]);
  try {
    renameSync(tmp, dir); // atomic: concurrent workers either win or find the finished copy
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { dir, cached: false };
}

function checkPythonLock(dir: string, plugin: string) {
  const cards = readCards(dir);
  if (!cards.some((c) => c.kind === "code")) return;
  const lock = join(dir, "requirements.lock");
  if (!existsSync(lock)) throw new Error(`${plugin} has code components but no requirements.lock: library versions must be pinned`);
  const deps = readFileSync(lock, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (deps.length) throw new Error(`${plugin} declares Python dependencies; per-plugin environments are not implemented in this POC`);
}

export function readCards(dir: string): Card[] {
  const p = join(dir, "cards.json");
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as { components: Card[] }).components;
}

export function cardFor(dir: string, component: string): Card {
  const card = readCards(dir).find((c) => c.id === component);
  if (!card) throw new Error(`component ${component} has no capability card in ${dir}`);
  return card;
}
