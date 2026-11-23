import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist/shared -> repo root
export const REPO_ROOT = resolve(here, "..", "..", "..");

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const dataDir = resolve(REPO_ROOT, env("DATA_DIR", ".data"));

function parseRewrites(spec: string): [string, string][] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split("=") as [string, string]);
}

export const config = {
  apiPort: Number(env("ENGINE_PORT", "7400")),
  apiHost: env("ENGINE_HOST", "127.0.0.1"),
  recipesDir: resolve(REPO_ROOT, env("RECIPES_DIR", "recipes")),
  contractsDir: resolve(REPO_ROOT, env("CONTRACTS_DIR", "contracts")),
  marketplaceSrc: resolve(REPO_ROOT, env("MARKETPLACE_SRC", "marketplace/plugins")),
  policyFile: resolve(REPO_ROOT, env("POLICY_FILE", "marketplace/policy.json")),

  /** Shared storage for all workers. Stands in for object storage in this POC. */
  dataDir,
  runsDir: join(dataDir, "runs"),
  pluginCacheDir: join(dataDir, "plugin-cache"),
  stepCacheDir: join(dataDir, "step-cache"),
  stepCache: env("STEP_CACHE", "on") === "on",

  temporalAddress: env("TEMPORAL_ADDRESS", "localhost:7233"),
  temporalNamespace: env("TEMPORAL_NAMESPACE", "default"),
  queues: {
    orchestration: "orchestration",
    discovery: "discovery",
    code: "code-steps",
    tool: "tool-steps",
    ai: "ai-steps",
  },

  registryUrl: env("REGISTRY_URL", "http://localhost:7300/mcp"),
  gitBaseUrl: env("GIT_BASE_URL", "git://localhost:9418"),
  embeddingsUrl: env("EMBEDDINGS_URL", "http://localhost:7200"),
  databaseUrl: env("DATABASE_URL", "postgres://poc:poc@localhost:5433/orchestrator"),
  auditMode: env("AUDIT_MODE", "central") as "central" | "local",
  /** Plugin .mcp.json URLs are written for the host; workers in containers rewrite them, e.g. "localhost:7310=mock-data:7310". */
  mcpUrlRewrites: parseRewrites(env("MCP_URL_REWRITE", "")),

  /** claude: AI steps run in Claude Agent SDK sessions. stub: deterministic placeholder output (no AI, no cost). */
  agentRunner: env("AGENT_RUNNER", "claude") as "claude" | "stub",
  defaultModel: env("DEFAULT_MODEL", "claude-sonnet-5-5"),
  agentMaxTurns: Number(env("AGENT_MAX_TURNS", "25")),
  /** claude: rerank discovery candidates with the Messages API. none: retrieval scores only. */
  rerank: env("RERANK", process.env.AGENT_RUNNER === "stub" ? "none" : "claude") as "claude" | "none",
  host: env("HOST_NAME", "claude-code"),

  python: env("PYTHON_BIN", "python3"),
  codeCpuSeconds: Number(env("CODE_CPU_SECONDS", "120")),
  codeMemoryMb: Number(env("CODE_MEMORY_MB", "2048")),
  codeTimeoutMs: Number(env("CODE_TIMEOUT_MS", "180000")),

  /** Worker pool sizing. AI_RATE_PER_SEC is enforced by Temporal across every AI worker (a shared rate limiter). */
  codeConcurrency: Number(env("CODE_CONCURRENCY", "8")),
  toolConcurrency: Number(env("TOOL_CONCURRENCY", "50")),
  aiConcurrency: Number(env("AI_CONCURRENCY", "4")),
  aiRatePerSecond: Number(env("AI_RATE_PER_SEC", "2")),
  discoveryConcurrency: Number(env("DISCOVERY_CONCURRENCY", "8")),

  /** token:user:role|role,... Every request needs a bearer token from this list. */
  tokens: env("ENGINE_TOKENS", "dev-analyst-token:analyst@example.com:analyst,dev-lead-token:lead@example.com:analyst|finance-lead|ops-lead,dev-auditor-token:auditor@example.com:auditor"),
  maxActiveRunsPerUser: Number(env("MAX_ACTIVE_RUNS_PER_USER", "10")),
  maxInputBytes: Number(env("MAX_INPUT_BYTES", String(50 * 1024 * 1024))),
  defaultApprovalExpiry: env("DEFAULT_APPROVAL_EXPIRY", "72h"),
};
