// Worker entry point. Each role polls its own task queue, so each pool scales on its own:
//   node dist/worker.js --role orchestrator|discovery|code|tool|ai|all
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as acts from "./activities/index.js";
import { config } from "./shared/config.js";

type Role = "orchestrator" | "discovery" | "code" | "tool" | "ai";
const ROLES: Role[] = ["orchestrator", "discovery", "code", "tool", "ai"];

async function makeWorker(role: Role, connection: NativeConnection): Promise<Worker> {
  const base = { connection, namespace: config.temporalNamespace };
  switch (role) {
    case "orchestrator":
      return Worker.create({
        ...base,
        taskQueue: config.queues.orchestration,
        workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
        // Local activities run here, next to the workflows that call them.
        activities: {
          interpolateValues: acts.interpolateValues, evaluate: acts.evaluate, audit: acts.audit, saveLock: acts.saveLock,
          mergeLoop: acts.mergeLoop, runRow: acts.runRow, finalizeRun: acts.finalizeRun,
        },
      });
    case "discovery":
      return Worker.create({
        ...base,
        taskQueue: config.queues.discovery,
        activities: { preparePlan: acts.preparePlan, discoverStep: acts.discoverStep, warmPlugin: acts.warmPlugin },
        maxConcurrentActivityTaskExecutions: config.discoveryConcurrency,
      });
    case "code":
      return Worker.create({
        ...base,
        taskQueue: config.queues.code,
        activities: { executeStep: acts.executeStep, replayRun: acts.replayRun },
        maxConcurrentActivityTaskExecutions: config.codeConcurrency,
      });
    case "tool":
      return Worker.create({
        ...base,
        taskQueue: config.queues.tool,
        activities: { executeStep: acts.executeStep },
        maxConcurrentActivityTaskExecutions: config.toolConcurrency,
      });
    case "ai":
      return Worker.create({
        ...base,
        taskQueue: config.queues.ai,
        activities: { executeStep: acts.executeStep },
        maxConcurrentActivityTaskExecutions: config.aiConcurrency,
        // Enforced by the Temporal server across every AI worker: a shared rate limiter for model calls.
        maxTaskQueueActivitiesPerSecond: config.aiRatePerSecond,
      });
  }
}

async function main() {
  const arg = process.argv.indexOf("--role");
  const requested = arg > 0 ? process.argv[arg + 1] : "all";
  const roles = requested === "all" ? ROLES : (requested.split(",") as Role[]);
  for (const r of roles) if (!ROLES.includes(r)) throw new Error(`unknown role ${r}; use ${ROLES.join(", ")} or all`);
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const workers = await Promise.all(roles.map((r) => makeWorker(r, connection)));
  console.log(`workers running: ${roles.join(", ")} (Temporal ${config.temporalAddress}, agent runner ${config.agentRunner}, data ${config.dataDir})`);
  await Promise.all(workers.map((w) => w.run()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
