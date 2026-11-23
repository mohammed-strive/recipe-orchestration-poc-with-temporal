// The run state the workflow keeps and returns from its "state" query. Pure types only.
import type { LockEntry, Mode, PendingSelection, RunStatus, StepState } from "./types.js";

export interface PendingApproval {
  step_id: string;
  message: string;
  role: string | null;
  exclude_runner: boolean;
  expires_at: string;
}

export interface RunView {
  run_id: string;
  recipe_id: string;
  recipe_version: string;
  recipe_title: string;
  recipe_hash: string;
  mode: Mode;
  model: string;
  user: string;
  status: RunStatus;
  started: boolean;
  created_at: string;
  inputs: Record<string, unknown>;
  input_hashes: Record<string, string>;
  steps: Record<string, StepState>;
  pending_selections: PendingSelection[];
  pending_approval: PendingApproval | null;
  lock: Record<string, LockEntry>;
  final_outputs?: Record<string, unknown>;
  report_markdown?: string | null;
  error?: string;
  step_counter: number;
}

export interface RecipeRunInput {
  runId: string;
  recipeId: string;
  inputs: Record<string, unknown>;
  mode: Mode;
  autoStart?: boolean;
  user: string;
  /** How long a run may wait for a person to choose a plugin or press start. */
  selectionExpiry: string;
  /** Default approval expiry when the recipe does not set one. */
  approvalExpiry: string;
}

export interface SelectArgs { step_id: string; component_id: string; user: string }
export interface ApproveArgs { step_id: string; decision: "approve" | "reject"; note?: string; user: string; roles: string[] }
