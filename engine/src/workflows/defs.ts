// Query and update definitions shared by the workflow and its clients (the engine API).
import { defineQuery, defineUpdate } from "@temporalio/workflow";
import type { ApproveArgs, RunView, SelectArgs } from "../shared/view.js";

export const stateQuery = defineQuery<RunView>("state");
export const selectUpdate = defineUpdate<RunView, [SelectArgs]>("selectComponent");
export const startUpdate = defineUpdate<RunView, [{ user: string }]>("start");
export const approveUpdate = defineUpdate<RunView, [ApproveArgs]>("approve");
