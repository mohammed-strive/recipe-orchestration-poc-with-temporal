---
description: Approve or reject a recipe step that is waiting for approval
argument-hint: [run id] [approve|reject] [note]
---

If no run id is given ($ARGUMENTS is empty), call `list_pending_approvals` and show the runs waiting for an approval this user may give (run, recipe, who started it, step, message, role, expiry). Ask which one to decide on. If the list is empty, say so: either nothing is waiting, or the user lacks the required role, or they started the run and the recipe excludes the runner (`whoami` shows their roles).

For the chosen run: call `get_run`, show `pending_approval.message` with the relevant numbers from completed steps, and confirm the decision with the user if it was not given. Then call `approve_step` with the decision and note. If the run belongs to someone else, report the outcome and stop: following the rest of the run is the owner's job.
