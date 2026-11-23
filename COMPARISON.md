# POC 1 (custom engine) vs POC 2 (Temporal engine)

**Recommendation: build the production engine on Temporal.** On a single small machine, POC 2 completes runs at about half POC 1's rate, because every step makes round trips to the Temporal server. What POC 2 adds is what production needs:

- runs that survive crashes without anyone acting;
- worker pools that scale independently;
- paused runs that cost nothing;
- a shared rate limiter for model calls;
- validated approvals and selections;
- a full, inspectable history of every run.

POC 1 cannot be scaled beyond one process at all. The per-step overhead is tunable (see "Closing the throughput gap").

| | POC 1: custom engine | POC 2: Temporal engine |
| --- | --- | --- |
| Repository | `recipe-orchestrator-poc` | this repository |
| Where it runs | One Node process on the analyst's machine | Stateless API plus 5 worker roles plus Temporal, all in containers |
| Shared components | Same recipes, plugins, contracts, registry, marketplace and Plugin X tools | Same |

## 1. How the benchmarks were run

Both engines were tested on the same machine (2 vCPU, 7 GB RAM), one at a time, against the same registry, git marketplace, mock data server and Postgres. AI steps used the stub runner, so the numbers measure orchestration, not model latency. Each run is the finance recipe in automatic mode, with 13 steps per run:

- a plugin choice answered with the engine's recommendation;
- a loop over 5 regions, one of which falls back to a simpler projection;
- an approval given by a second user;
- 2 AI steps.

POC 2 ran Temporal's single-node development server (SQLite), and all five worker roles in one process. Tool: `tools/load-test.mjs`, which works against either engine.

These are relative numbers from a small, shared machine, not production capacity figures. In POC 2, the Temporal server, workers, API, Postgres, registry and the load generator all competed for the same 2 CPUs.

## 2. Results

### Throughput and latency

| Load | Engine | Completed | Wall time | Runs per minute | Run time p50 / p95 | Planning p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 20 runs, 10 at once | POC 1 | 20 / 20 | 15.6 s | **77.1** | 7.8 s / 8.3 s | 5.1 s / 5.1 s |
| 20 runs, 10 at once | POC 2, result cache off | 20 / 20 | 34.0 s | 35.3 | 11.7 s / 20.0 s | **1.2 s / 1.6 s** |
| 20 runs, 10 at once | POC 2, result cache on | 20 / 20 | 28.6 s | 42.0 | 10.8 s / 26.7 s | 1.5 s / 1.9 s |
| 50 runs, 25 at once | POC 1 | 50 / 50 | 35.6 s | **84.3** | 17.7 s / 18.2 s | 11.1 s / 12.2 s |
| 50 runs, 25 at once | POC 2, result cache off | 50 / 50 | 73.5 s | 40.8 | 27.9 s / 45.2 s | **1.3 s / 5.1 s** |
| 50 runs, 25 at once | POC 2, result cache on | 50 / 50 | 71.2 s | 42.1 | 26.6 s / 47.5 s | 1.2 s / 4.2 s |

What the numbers show:

- **POC 1 is about twice as fast on one machine.** It runs every step in its own process, with no network round trips. POC 2 makes several round trips per step: a workflow task, an activity task, and local activities for expressions and audit. On 2 shared CPUs that overhead dominates steps that take milliseconds.
- **POC 2 plans 4 to 9 times faster.** It clones each plugin once per commit SHA into a shared cache; POC 1 clones every plugin for every run. Planning is what the analyst waits for interactively.
- **The result cache served 8 of 13 steps per run**, but gained little here: stub code steps take milliseconds. It matters when code steps are real analyses.
- **POC 1 cannot go further. POC 2 can.** POC 1's ceiling is one process on one machine. POC 2 adds capacity by adding workers or machines (`--scale worker-code=4`), with no code change. That couldn't be shown on a 2-CPU machine; it needs a test on real infrastructure.

### Memory (resident memory under load)

| Process | POC 1 | POC 2 |
| --- | --- | --- |
| Engine | about 260 MB (single process) | API 120–270 MB; all workers in one process 250–480 MB |
| Workflow server | none | Temporal development server about 240 MB |

### Failure and recovery

| Scenario | POC 1 | POC 2 |
| --- | --- | --- |
| Process killed (`kill -9`) during a step | Planning requests in flight were lost (4 of 10 in the test). By design, runs that were executing are marked `interrupted` at restart and wait for someone to call `start_run` | **All workers killed mid-step: the run resumed on its own** when workers restarted, 52 s after the kill (30 s heartbeat timeout plus restart). No one acted, and the recipe's retry allowance was not used |
| Status requested while the engine is down | No answer: the engine *is* the API | The API stays up and answers clearly: the run is safe in Temporal and continues when workers return |
| A dependency (the registry) fails during planning | Runs left stuck in `planned` with no clean-up (10 observed during an accidental registry outage) | Planning retries 3 times with backoff, then the run fails with the reason recorded |
| Run waiting for approval when the engine restarts | Survives (state on disk), but holds an entry in an in-memory map while active | Survives with no process or memory held. The approval expires on a durable timer |

## 3. Features

| Capability | POC 1 | POC 2 |
| --- | --- | --- |
| Pinned plugins, discovery, lock files, contracts, replay, evals | Yes | Yes, same code |
| Durable runs, automatic recovery | Checkpoint files; manual resume | Built in (Temporal history) |
| Horizontal scaling | No (single process, in-memory state) | Yes (stateless API, worker pools per queue) |
| Independent worker pools | No | Code, tool, AI, discovery, orchestration |
| Parallel loop iterations | No | Yes (`max_parallel`) |
| Shared model rate limit | No | Yes (Temporal enforces it across every AI worker) |
| Separating infrastructure retries from recipe retries | Not applicable | Yes (heartbeats; step errors count against `retry.max`, crashes do not) |
| Approvals: roles, separation of duties, expiry | No | Yes, validated inside the run (Temporal updates) |
| Authentication and per-user access to runs | No | Bearer tokens with users and roles (stand-in for single sign-on) |
| Per-user quota | No | Yes (not atomic; see below) |
| Kill switch | No | `cancel_run`, plus plugin withdrawal at the next step |
| AI step isolation | `claude -p` with the user's login, user settings and full tool set | Agent SDK: no settings files, 5 tools, one plugin, one skill, service API key |
| Plugin cache / result cache | No / No | Yes / Yes |
| Run history and debugging | Audit log and state files | Audit log, plus Temporal UI with every event, input, output and retry |
| Audit writes | One database write per event | Batched; safe across processes |
| Code size (engine, TypeScript) | 2,310 lines; orchestration and state 614 | 2,697 lines; workflow and worker 449, API 328. More features in less orchestration code |
| Operational footprint | Node on each host, plus Docker infrastructure | Temporal (a cluster or Temporal Cloud in production), plus containers |

## 4. Findings from building POC 2

These change the design or the feasibility study.

1. **The Claude Agent SDK still starts a Claude Code process for each session.** The feasibility study (Sections 8.2, 9 and 12) says AI workers hold many sessions inside one process. That's not accurate: the SDK runs Claude Code as a subprocess per session. What the SDK does provide is reliable isolation (`settingSources: []`, a fixed tool list, per-session plugins and skills) and a service credential. AI worker capacity should therefore be planned per process: memory and start-up cost per concurrent session. The study should be corrected.
2. **Queries need workers.** Temporal answers state queries by running workflow code in a worker. With no orchestration worker running, state can't be read. A finished run's history must be replayed to answer a query, and that failed under load until finished runs were read from their stored result instead. In production, run several orchestration workers, and consider publishing run state to a read model (for example a Postgres table) for dashboards.
3. **Heartbeats are essential.** Without them, Temporal only notices a dead worker after the step's full timeout (10 minutes here). With a 30 s heartbeat timeout, recovery took under a minute.
4. **Infrastructure retries must be separate from recipe retries.** A worker crash used to consume the recipe's `retry.max` and could trigger a fallback that wasn't needed. POC 2 now gives Temporal extra attempts for infrastructure failures only.
5. **The per-user quota can be exceeded.** Counting active runs and then starting one is not atomic: 25 simultaneous requests all passed a limit of 10 (23 were active). Production needs an atomic counter (a Postgres row lock or a semaphore workflow).
6. **Workflow code must be versioned.** Changing workflow logic while runs are in progress needs Temporal's versioning (`patched()`) or worker build IDs. This is a new engineering discipline compared with POC 1.
7. **Keep large data out of Temporal.** Steps pass file references, so histories stay small. AI prompts are included in step results, so very long prompts should move to storage too.
8. **One pending approval per run.** Approvals inside parallel loop iterations would need a list of pending approvals.

## 5. Closing the throughput gap

POC 2's per-step overhead can be reduced without losing its guarantees:

- **Fewer round trips per step.** Move expression interpolation into `executeStep`, and have workers write their own audit events. That leaves one activity per step instead of three or four.
- **A production Temporal deployment.** Use a cluster on Postgres or Cassandra (or Temporal Cloud), not the SQLite development server sharing 2 CPUs with everything else.
- **Separate worker processes** for each role, as in `docker-compose.yml`, so orchestration isn't slowed by code execution.
- **Worker tuning** (task slots and poller counts) for short steps.
- **Batching tiny steps.** Very short deterministic steps can be grouped into one activity where the audit granularity allows.

The next benchmark should run on representative infrastructure, with real AI steps. There, model latency (seconds to minutes per AI step) will far outweigh the orchestration overhead measured here. That overhead was roughly 0.3 s per step under load on this machine: about 4 s more per 13-step run than POC 1.
