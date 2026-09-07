#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { runtimeReadiness } from "./deploy-runtime.mjs";
import { sanitizeText } from "./deploy-support.mjs";

function loadPlan(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("The controller did not provide a deployment plan");
  }
  const plan = JSON.parse(readFileSync(path, "utf8"));
  if (plan?.schemaVersion !== 1 || typeof plan.config?.readinessUrl !== "string") {
    throw new Error("The deployment plan is invalid");
  }
  return plan;
}

try {
  const plan = loadPlan(process.env.RIP_DVD_DEPLOY_PLAN_FILE);
  const readiness = runtimeReadiness(plan.config);
  if (readiness.activeWork.length > 0) {
    throw new Error(
      "Active disc work began during image builds; leaving the old runtime running",
    );
  }
  process.stdout.write("No active disc work was present at the quiescence boundary.\n");
} catch (error) {
  process.stderr.write(`${sanitizeText(error.message, 2_000)}\n`);
  process.exitCode = 1;
}
