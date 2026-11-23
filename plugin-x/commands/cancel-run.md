---
description: Stop a running recipe run (kill switch)
argument-hint: <run id>
---

Confirm with the user that they want to stop run $ARGUMENTS, then call `cancel_run` on the recipe-engine server and report the final status. The cancellation is recorded in the run's audit log.
