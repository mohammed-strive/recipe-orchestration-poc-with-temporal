---
name: recipe-runner
description: Find, plan, run and audit analysis recipes through the recipe engine. Use when the user wants an analysis, projection or report that a recipe could produce, or asks about a recipe run, its plugins, approvals or audit trail.
---

# Running recipes

Plugin X is a thin front end. All orchestration happens in the **recipe engine** (MCP server `recipe-engine`), a central service built on Temporal. Never run analysis steps yourself and never install plugins: the engine's worker pools run every step, with the plugin versions recorded in the run's lock file. Calls are authenticated: `whoami` shows the current user and roles.

## 1. Choose the recipe

- If the user names a recipe, use `describe_recipe` to confirm it exists.
- Otherwise call `find_recipe` with their request. Show the top matches (title, one-line description, score) and **ask the user to confirm** which one to run. Never pick silently.

## 2. Collect inputs

Call `describe_recipe` and list its inputs. Ask only for required inputs the user has not given; mention the defaults for the rest. File inputs may be paths relative to the recipe folder (for example `samples/actuals.csv`) or absolute paths.

Ask whether to run **interactive** (default: the user confirms discovered plugins and approvals as they come) or **automatic** (runs unattended; it pauses only when a person must choose a plugin or approve a step).

## 3. Plan

Call `plan_run` with `recipe_id`, `inputs` and `mode`. Then report:

- the lock: which steps use pinned plugins and which were discovered;
- any `pending_selections`.

### Pending selections (discovered plugins)

For each pending selection, show a short table of candidates: component, kind, card status (verified or generated), pre-approved, scores, and the reason from the reranker if present. State the engine's recommendation and why a person is needed (`reason`). Ask the user to choose, then call `select_component` with their exact choice. Do not choose for them. If they ask for details, use `get_capability_card` on the `capability-registry` server.

## 4. Run and follow progress

- Interactive runs: after selections, call `start_run`. Automatic runs start on their own.
- Poll with `get_run` using `wait_seconds: 20`. Report progress briefly: steps completed, loops, fallbacks used (`fallback_from`), retries.
- If `status` is `needs_selection` during the run (a step resolved at runtime), handle it as in step 3.
- If `status` is `waiting_approval`, show `pending_approval.message`, the required `role`, whether the person who started the run is excluded (`exclude_runner`), and the expiry. If the current user may approve, ask them and call `approve_step` with their decision and note. Otherwise tell them who must approve (someone with that role); approvers find the run with `list_pending_approvals` or `/approve`. The engine enforces these rules; never approve on the user's behalf.
- If the engine says the run state is temporarily unavailable, explain that the run is safe and will continue when workers return, and check again shortly.
- If `status` is `failed`, show `error` and the failing step, and suggest the next action.

## 5. Results

When `status` is `completed`:

- Show `report_markdown` (the engine returns the report text, as files live on the server).
- Mention `temporal_ui`, the link to this run in the Temporal UI, for anyone who wants to inspect its history.
- Offer: `evaluate_run` (recipe tests and confidence score), `replay_run` (prove the run reproduces exactly), `get_audit_log` (hash-chained audit trail).

## Stopping a run

`cancel_run` stops a run immediately (kill switch). Confirm with the user first.

## Notes

- Steps run on the engine's worker pools. AI steps run in Claude Agent SDK sessions that load only the step's plugin and skill, with no shell or network tools; the user's own Claude Code setup is never used or changed.
- Runs are durable: they survive engine and worker restarts on their own, so there is no resume step.
- Reproducibility levels per step: `exact` (code), `snapshot` (data captured from a tool), `replayable` (AI output recorded), `human` (approval).

## Approving other people's runs

If the user is an approver (for example a finance or ops lead) and asks what is waiting for them, call `list_pending_approvals`. They can read those runs with `get_run` while the approval is pending (read-only), then decide with `approve_step`. `list_runs` shows only the user's own runs (all runs for auditors and admins), so it is not the way to find approvals.
