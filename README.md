# Recipe Orchestrator — Temporal POC

The second proof of concept. It runs the same recipes, plugins, registry and Plugin X as the [first POC](https://github.com/mohammed-strive/recipe-orchestrator-poc), but the engine follows the production design. It is a central service on [Temporal](https://temporal.io): a stateless engine API, durable recipe workflows, and separate worker pools for code, tool, AI and discovery steps. AI steps run on the Claude Agent SDK.

See **[COMPARISON.md](COMPARISON.md)** for the measured comparison between the two POCs.

```
 Claude Code + Plugin X ──MCP + bearer token──► engine-api (stateless, :7400)
                                                    │ start runs, updates, queries
                                                    ▼
                                            Temporal (:7233, UI :8233)
                                                    │ task queues
        ┌───────────────┬───────────────┬───────────┴───┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
  orchestration     discovery       code-steps      tool-steps       ai-steps
  (workflows +      (plan, search,  (Python, limits, (MCP calls,     (Agent SDK,
   local acts)       rerank)         result cache)    snapshots)      rate-limited)
        └───────────────┴──── shared /data: runs, plugin cache, step cache ────┘
   registry :7300 · git marketplace :9418 · postgres+pgvector :5433 · embeddings :7200 · mock data :7310
```

## What changed from the first POC

| | First POC | This POC |
| --- | --- | --- |
| Engine | One Node process on the analyst's machine, running steps itself | Stateless API plus Temporal workflows; steps run on worker pools in containers |
| Run state | Files plus in-memory map; resume with `start_run` after a crash | Temporal history; runs continue on their own after crashes; paused runs hold no resources |
| Worker pools | None | One task queue per step type: `orchestration`, `discovery`, `code-steps`, `tool-steps`, `ai-steps`, each scalable on its own |
| AI steps | `claude -p` CLI with the user's login and user settings | Claude Agent SDK with a service API key: no user settings, only Read/Write/Glob/Grep/Skill tools, only the step's plugin and skill |
| Rate limiting | None | Temporal enforces `AI_RATE_PER_SEC` across every AI worker (a shared rate limiter) |
| Loops | Sequential | Iterations run in parallel (`max_parallel`, default 4) |
| Plugins | Cloned for every run | Cloned once per commit SHA into a shared cache |
| Results | Always recomputed | Code-step results cached by content (component SHA, inputs and parameters) |
| Selections and approvals | Plain calls | Temporal updates, validated inside the run before they are accepted |
| Guardrails | None | Bearer-token users and roles, separation of duties, approval expiry, per-user quota, cancellation (kill switch), plugin withdrawal checked before each step, CPU and memory limits on code steps |
| Audit | One database write per event | Batched hash-chained events, safe across processes, mirrored to Postgres |
| Reports | File path on the analyst's machine | Report text returned by the API (files live on the server) |

## Quick start

```bash
cp .env.example .env        # set ANTHROPIC_API_KEY, or AGENT_RUNNER=stub to run without AI
docker compose up -d --build
docker compose logs -f registry     # wait for "initial index", then Ctrl-C
tools/smoke-test.sh                 # plan → choose plugin → approval (refused for the runner, given by the lead) → evals → replay → audit
open http://localhost:8233          # Temporal UI: every run's full history
```

From Claude Code:

```bash
RECIPE_ENGINE_TOKEN=dev-analyst-token claude --plugin-dir ./plugin-x
```

Approvals need someone other than the person who started the run, and with the recipe's role. Use `RECIPE_ENGINE_TOKEN=dev-lead-token` in a second Claude Code session, or `RECIPE_ENGINE_TOKEN=dev-lead-token tools/mcp.sh engine approve_step '{...}'`.

### Development identities

| Token | User | Roles |
| --- | --- | --- |
| `dev-analyst-token` | analyst@example.com | analyst |
| `dev-lead-token` | lead@example.com | analyst, finance-lead, ops-lead |
| `dev-auditor-token` | auditor@example.com | auditor (reads every run) |
| `dev-admin-token` | admin@example.com | admin, plugin-owner |

In production these are single sign-on tokens verified against your identity provider. See `engine/src/api/auth.ts`.

### Scaling and failure drills

```bash
docker compose up -d --scale worker-code=4 --scale worker-ai=2    # more workers, no other change
node tools/load-test.mjs --runs 50 --concurrency 25               # with AGENT_RUNNER=stub
docker compose kill worker-orchestrator worker-code               # mid-run; then:
docker compose up -d                                              # runs continue on their own
```

## Recipe additions

```yaml
- id: variance_review
  type: approval
  approvers: { role: finance-lead, exclude_runner: true, expires_after: 48h }

- id: project
  foreach: $distinct(steps.normalise_currency.outputs.usd_actuals.region)
  max_items: 20
  max_parallel: 4
```

`marketplace/policy.json` may also list `withdrawn` plugins (`"plugin"` or `"plugin#component"`). Withdrawn components are blocked at their next step, including in runs already in progress.

## Engine layout

```
engine/src/
  api/          stateless MCP API: auth, permissions, quotas, Temporal client
  workflows/    recipeRun and replayWorkflow (deterministic orchestration only)
  activities/   steps (code, tool, AI), planning and discovery, orchestration helpers, replay
  shared/       recipes, contracts, expressions, registry client, audit, evals, plugin cache
  worker.ts     --role orchestrator | discovery | code | tool | ai | all
```

Running on the host instead of in Docker is also possible: start `temporal server start-dev`, then the POC 1 infrastructure, then `cd engine && npm run build && npm run worker -- --role all` and `npm run api`.

## POC simplifications

- **Temporal** runs as the single-node development server with SQLite. Production uses a Temporal cluster (or Temporal Cloud) on Postgres or Cassandra.
- **Shared storage.** `/data` is a Docker volume standing in for object storage.
- **Code-step isolation** is CPU and memory limits plus a minimal environment. Network isolation needs a sandbox runtime such as gVisor or Firecracker.
- **Identity.** Users come from fixed development tokens, not single sign-on.
- **Quota check** reads active runs and then starts a new one. Simultaneous requests can exceed the limit (see COMPARISON.md); production needs an atomic check.
- **Data access** calls the mock MCP servers directly, without delegated user tokens.
- **Approvals inside loops.** One approval can be pending at a time.
- **Recipes** are read from the `recipes/` folder, not from a signed recipes repository.
