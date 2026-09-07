#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildReviewBundle, parseNameStatus } from "./deploy-review.mjs";
import {
  assertIdentity,
  checkResources,
  independentVerify,
  loadConfig,
  runtimeSnapshot,
  stopAndVerifyRuntime,
} from "./deploy-runtime.mjs";
import {
  RESULT_SCHEMA_VERSION,
  DeploymentError,
  acquireLock,
  appendBoundedLog,
  atomicWriteJson,
  emitResult,
  exitCodeFor,
  isTerminalState,
  makeResult,
  progress,
  readJson,
  stateDirectory,
} from "./deploy-state.mjs";
import {
  REPOSITORY_ROOT,
  runCheckedSync,
  runStreaming,
  sanitizeText,
} from "./deploy-support.mjs";

export { sanitizeText } from "./deploy-support.mjs";
export { classifyReview } from "./deploy-review.mjs";

const SCRIPT_PATH = resolve(REPOSITORY_ROOT, "scripts/deploy.mjs");
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POST_QUIESCENCE_STAGES = new Set(["quiescing", "migration", "verification", "complete"]);

function parseArguments(arguments_) {
  const [subcommand = "help", ...rest] = arguments_;
  const options = { subcommand };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--allow-active-work" || argument === "--foreground") {
      options[argument.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (!argument.startsWith("--") || rest[index + 1] === undefined) {
      throw new DeploymentError("validation_failure", `Invalid argument: ${argument}`);
    }
    const key = argument.slice(2).replaceAll("-", "_");
    if (options[key] !== undefined) {
      throw new DeploymentError("validation_failure", `Duplicate argument: ${argument}`);
    }
    options[key] = rest[index + 1];
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/deploy.mjs plan --config PATH|-",
    "  node scripts/deploy.mjs apply --target FULL_SHA [--approve-review FULL_SHA] [--allow-active-work]",
    "  node scripts/deploy.mjs run --target FULL_SHA [--approve-review FULL_SHA] [--allow-active-work] [--foreground]",
    "  node scripts/deploy.mjs status",
    "  node scripts/deploy.mjs review",
    "  node scripts/deploy.mjs verify",
    "  node scripts/deploy.mjs diagnostics",
  ].join("\n");
}

function gitPlan(config) {
  const oldCommit = runCheckedSync("git", ["rev-parse", "HEAD"]).stdout.trim();
  runCheckedSync("git", ["fetch", "--prune", config.remote]);
  const targetCommit = runCheckedSync("git", ["rev-parse", "--verify", `${config.targetRef}^{commit}`]).stdout.trim();
  if (!FULL_SHA.test(oldCommit) || !FULL_SHA.test(targetCommit)) {
    throw new DeploymentError("validation_failure", "Git did not return full commit SHAs", { oldCommit, targetCommit });
  }
  const ancestry = runCheckedSync("git", ["merge-base", "--is-ancestor", oldCommit, targetCommit], { allowFailure: true });
  if (ancestry.status !== 0) {
    throw new DeploymentError("validation_failure", "Current commit is not an ancestor of the deployment target", { oldCommit, targetCommit });
  }
  const commitResult = runCheckedSync("git", ["log", "--format=%H%x09%s", "--no-merges", `${oldCommit}..${targetCommit}`]);
  const commitOutput = commitResult.stdout;
  const commits = commitOutput.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [sha, ...subject] = line.split("\t");
    return {
      sha,
      subject: sanitizeText(subject.join("\t"), 1000, config.storagePaths),
    };
  });
  const filesResult = runCheckedSync("git", ["diff", "--name-status", "-z", `${oldCommit}..${targetCommit}`]);
  const files = parseNameStatus(filesResult.stdout);
  const diffResult = runCheckedSync("git", [
    "diff",
    "--no-ext-diff",
    "--unified=40",
    `${oldCommit}..${targetCommit}`,
    "--",
    "compose.yaml",
    "compose*.yaml",
    "docker",
    "scripts",
    ".env.example",
    "*lock*",
    "packages/config",
    "packages/data-access/drizzle",
    "packages/data-access/src",
  ]);
  return {
    oldCommit,
    targetCommit,
    commits,
    files,
    diff: diffResult.stdout,
    inventoryIncomplete:
      commitResult.stdoutTruncated
      || filesResult.stdoutTruncated
      || diffResult.stdoutTruncated,
  };
}

function planId(oldCommit, targetCommit) {
  return createHash("sha256").update(`${oldCommit}\0${targetCommit}`).digest("hex").slice(0, 24);
}

function createPlan(options) {
  const config = loadConfig(options.config);
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let run = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command: "plan",
    state: "running",
    phase: "preflight",
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    _privatePaths: config.storagePaths,
  };
  let release = () => {};
  try {
    release = acquireLock(run.runId);
    run = progress(run, "preflight", "Checking deployment host, checkout, runtime, and resources.");
    assertIdentity(config);
    const resources = checkResources(config);
    const runtime = runtimeSnapshot(config);
    run = progress(run, "fetch", "Fetching the deployment remote and freezing the reviewed target.");
    const git = gitPlan(config);
    const review = buildReviewBundle(
      git.oldCommit,
      git.targetCommit,
      git.commits,
      git.files,
      git.diff,
      {
        inventoryIncomplete: git.inventoryIncomplete,
        privatePaths: config.storagePaths,
      },
    );
    const plan = {
      schemaVersion: 1,
      planId: planId(git.oldCommit, git.targetCommit),
      createdAt: new Date().toISOString(),
      config,
      oldCommit: git.oldCommit,
      targetCommit: git.targetCommit,
      targetRef: config.targetRef,
      commits: git.commits,
      files: git.files,
      activeWork: runtime.activeWork,
      failedUnitsBefore: runtime.failedUnits,
      driveChecksBefore: runtime.driveChecks,
      resources,
      reviewRequired: review.reviewRequired,
      reviewReasons: review.reasons,
    };
    atomicWriteJson(resolve(directory, "plan.json"), plan);
    atomicWriteJson(resolve(directory, "review-bundle.json"), review);
    run = {
      ...run,
      planId: plan.planId,
      oldCommit: plan.oldCommit,
      targetCommit: plan.targetCommit,
    };
    if (git.oldCommit === git.targetCommit) {
      run = progress(run, "already_current", "The deployment is already at the frozen target.");
      return emitResult(makeResult("plan", "already_current", plan, run.message, { reviewBundle: resolve(directory, "review-bundle.json") }, run));
    }
    if (runtime.activeWork.length > 0) {
      run = progress(run, "active_work", "Active disc work blocks deployment before checkout changes.", { activeWork: runtime.activeWork });
      const result = emitResult(makeResult("plan", "active_work", plan, run.message, { activeWork: runtime.activeWork, reviewRequired: review.reviewRequired }, run));
      process.exitCode = exitCodeFor("active_work");
      return result;
    }
    if (review.reviewRequired) {
      run = progress(run, "review_required", "The frozen commit range requires human semantic review.", { reasons: review.reasons });
      const result = emitResult(makeResult("plan", "review_required", plan, run.message, { reasons: review.reasons, reviewBundle: resolve(directory, "review-bundle.json") }, run));
      process.exitCode = exitCodeFor("review_required");
      return result;
    }
    run = progress(run, "planned", "Deployment plan is ready for the frozen target.");
    return emitResult(makeResult("plan", "planned", plan, run.message, { reviewBundle: resolve(directory, "review-bundle.json") }, run));
  } catch (error) {
    const failure = error instanceof DeploymentError ? error : new DeploymentError("validation_failure", error.message);
    if (failure.state === "concurrent_run") {
      const result = emitResult(
        makeResult("plan", failure.state, undefined, failure.message, failure.details, run),
        { persist: false },
      );
      process.exitCode = exitCodeFor("concurrent_run");
      return result;
    }
    run = progress(run, failure.state, failure.message, failure.details);
    const result = emitResult(makeResult("plan", failure.state, undefined, failure.message, failure.details, run));
    process.exitCode = exitCodeFor(failure.state);
    return result;
  } finally {
    release();
  }
}

function loadPlan() {
  return readJson(resolve(stateDirectory(), "plan.json"), "Deployment plan");
}

function assertFreshPlan(plan, options) {
  if (!FULL_SHA.test(options.target ?? "") || options.target !== plan.targetCommit) {
    throw new DeploymentError("stale_plan", "Apply target must equal the plan's frozen full SHA", {
      plannedTarget: plan.targetCommit,
      requestedTarget: options.target ?? null,
    });
  }
  assertIdentity(plan.config);
  const head = runCheckedSync("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== plan.oldCommit) {
    throw new DeploymentError("stale_plan", "Checkout HEAD changed after planning", { plannedHead: plan.oldCommit, actualHead: head });
  }
  runCheckedSync("git", ["fetch", "--prune", plan.config.remote]);
  const currentTarget = runCheckedSync("git", ["rev-parse", "--verify", `${plan.targetRef}^{commit}`]).stdout.trim();
  if (currentTarget !== plan.targetCommit) {
    throw new DeploymentError("stale_plan", "Deployment target moved after review", {
      plannedTarget: plan.targetCommit,
      currentTarget,
    });
  }
  const ancestry = runCheckedSync("git", ["merge-base", "--is-ancestor", plan.oldCommit, plan.targetCommit], { allowFailure: true });
  if (ancestry.status !== 0) {
    throw new DeploymentError("stale_plan", "Frozen target no longer has the planned commit as an ancestor");
  }
  checkResources(plan.config);
  let runtime;
  try {
    runtime = runtimeSnapshot(plan.config);
  } catch (error) {
    throw new DeploymentError("validation_failure", "Runtime preflight verification failed", {
      error: sanitizeText(error.message, 4000),
    });
  }
  if (runtime.activeWork.length > 0 && !options.allow_active_work) {
    throw new DeploymentError("active_work", "Active disc work blocks deployment before checkout changes", { activeWork: runtime.activeWork });
  }
  if (plan.reviewRequired && options.approve_review !== plan.targetCommit) {
    throw new DeploymentError("review_required", "Human review approval must name the frozen full SHA", {
      reasons: plan.reviewReasons,
      requiredApproval: plan.targetCommit,
    });
  }
  return runtime;
}

function updateFailureState(stage) {
  return POST_QUIESCENCE_STAGES.has(stage)
    ? "post_migration_failure"
    : "pre_migration_failure";
}

function readUpdateEvidence(path) {
  const evidence = readJson(path, "Update evidence");
  if (
    evidence.schemaVersion !== 1
    || evidence.migrationsCurrent !== true
    || !/^[A-Za-z0-9._-]+\.sqlite$/u.test(evidence.backup?.filename ?? "")
    || !Number.isSafeInteger(evidence.backup?.sizeBytes)
    || evidence.backup.sizeBytes <= 0
  ) {
    throw new Error("Updater returned invalid deployment evidence");
  }
  return evidence;
}

async function applyPlan(options) {
  const plan = loadPlan();
  let run = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command: "apply",
    state: "running",
    phase: "preflight",
    runId: randomUUID(),
    planId: plan.planId,
    oldCommit: plan.oldCommit,
    targetCommit: plan.targetCommit,
    startedAt: new Date().toISOString(),
    _privatePaths: plan.config.storagePaths,
  };
  let release = () => {};
  try {
    release = acquireLock(run.runId);
    run = progress(run, "preflight", "Rechecking the frozen deployment plan before changing HEAD.");
    const stagePath = resolve(stateDirectory(), "update-stage");
    const evidencePath = resolve(stateDirectory(), "update-evidence.json");
    rmSync(stagePath, { force: true });
    rmSync(evidencePath, { force: true });
    assertFreshPlan(plan, options);
    run = progress(run, "apply", `Applying reviewed commit ${plan.targetCommit}.`);
    const updater = await runStreaming("sh", [resolve(REPOSITORY_ROOT, "scripts/update.sh"), "--target", plan.targetCommit], {
      logPath: resolve(stateDirectory(), "run-output.log"),
      privatePaths: plan.config.storagePaths,
      env: {
        ...process.env,
        RIP_DVD_CONTROLLER_LOCK_HELD: "1",
        RIP_DVD_UPDATE_RESULT_FILE: evidencePath,
        RIP_DVD_UPDATE_STAGE_FILE: stagePath,
      },
    });
    appendBoundedLog(
      resolve(stateDirectory(), "deployment.log"),
      `${updater.stdout}\n${updater.stderr}`,
      plan.config.storagePaths,
    );
    if (updater.status !== 0) {
      let stage = "unknown";
      try { stage = readFileSync(stagePath, "utf8").trim(); } catch {}
      const state = updateFailureState(stage);
      throw new DeploymentError(state, state === "post_migration_failure"
        ? "Deployment failed at or after runtime quiescence; controller containment is required."
        : "Deployment failed before migration; the old runtime should still be running.", {
        stage,
        exitCode: updater.status,
        output: sanitizeText(`${updater.stdout}\n${updater.stderr}`, 32_768),
      });
    }
    let backup;
    try {
      backup = readUpdateEvidence(evidencePath).backup;
    } catch (error) {
      throw new DeploymentError("verification_failure", "Deployment evidence verification failed", {
        error: sanitizeText(error.message, 4000),
      });
    }
    run = progress(run, "verification", "Running independent service, drive, systemd, and log checks.");
    let verification;
    try {
      verification = independentVerify(plan, plan.targetCommit);
    } catch (error) {
      throw new DeploymentError("verification_failure", "Independent deployment verification failed", {
        error: sanitizeText(error.message, 4000),
        backup,
      });
    }
    run = progress(run, "success", "Deployment reached the reviewed commit and passed independent verification.");
    return emitResult(makeResult("apply", "success", plan, run.message, { backup, verification }, run));
  } catch (error) {
    let stage = "unknown";
    try {
      stage = readFileSync(resolve(stateDirectory(), "update-stage"), "utf8").trim();
    } catch {}
    const failure = error instanceof DeploymentError
      ? error
      : new DeploymentError(
          updateFailureState(stage),
          error.message,
          { stage },
        );
    if (["post_migration_failure", "verification_failure"].includes(failure.state)) {
      try {
        failure.details = {
          ...failure.details,
          containment: { verified: true, ...stopAndVerifyRuntime() },
        };
        failure.message = `${failure.message} Runtime services are stopped and verified.`;
      } catch (containmentError) {
        failure.details = {
          ...failure.details,
          containment: {
            verified: false,
            error: sanitizeText(containmentError.message, 4000, plan.config.storagePaths),
          },
        };
        failure.message = `${failure.message} Runtime containment could not be verified.`;
      }
    }
    run = progress(run, failure.state, failure.message, failure.details);
    const result = emitResult(makeResult("apply", failure.state, plan, failure.message, failure.details, run));
    process.exitCode = exitCodeFor(failure.state);
    return result;
  } finally {
    release();
  }
}

async function startRun(options) {
  if (options.foreground) return await applyPlan(options);
  const plan = loadPlan();
  if (!FULL_SHA.test(options.target ?? "") || options.target !== plan.targetCommit) {
    const result = emitResult(makeResult("run", "stale_plan", plan, "Run target must equal the plan's frozen full SHA"));
    process.exitCode = exitCodeFor("stale_plan");
    return result;
  }
  const screenArguments = ["-DmS", "rip-dvd-update", process.execPath, SCRIPT_PATH, "apply", "--target", options.target];
  if (options.approve_review) screenArguments.push("--approve-review", options.approve_review);
  if (options.allow_active_work) screenArguments.push("--allow-active-work");
  const existing = runCheckedSync("screen", ["-ls"], { allowFailure: true });
  if (existing.stdout.includes(".rip-dvd-update")) {
    return emitResult(makeResult("run", "running", plan, "The named deployment Screen session is already running. Use status to reconnect."));
  }
  const started = runCheckedSync("screen", screenArguments, { allowFailure: true });
  if (started.status !== 0) {
    const result = emitResult(makeResult("run", "validation_failure", plan, "Could not start the deployment Screen session", { error: started.stderr }));
    process.exitCode = exitCodeFor("validation_failure");
    return result;
  }
  return emitResult(makeResult("run", "running", plan, "Deployment started in GNU Screen session rip-dvd-update. Use status after reconnecting."));
}

function showStatus() {
  const directory = stateDirectory();
  let status;
  try {
    status = readJson(resolve(directory, "status.json"), "Deployment status");
  } catch (error) {
    const result = emitResult(makeResult("status", "validation_failure", undefined, error.message, error.details));
    process.exitCode = exitCodeFor("validation_failure");
    return result;
  }
  const state = isTerminalState(status.phase) ? status.phase : "running";
  let updateStage;
  if (status.phase === "apply") {
    try {
      updateStage = readFileSync(resolve(directory, "update-stage"), "utf8").trim();
    } catch {}
  }
  return emitResult({
    command: "status",
    state,
    phase: status.phase,
    runId: status.runId,
    planId: status.planId,
    oldCommit: status.oldCommit,
    targetCommit: status.targetCommit,
    message: status.message,
    details: {
      ...(status.details ?? {}),
      ...(updateStage ? { updateStage } : {}),
    },
  });
}

function showReview() {
  const directory = stateDirectory();
  const plan = loadPlan();
  const review = readJson(resolve(directory, "review-bundle.json"), "Review bundle");
  const state = review.reviewRequired ? "review_required" : "success";
  const result = emitResult(makeResult(
    "review",
    state,
    plan,
    review.reviewRequired
      ? "The frozen commit range requires semantic review"
      : "The frozen commit range has no classified review reasons",
    { review },
  ));
  if (review.reviewRequired) process.exitCode = exitCodeFor("review_required");
  return result;
}

function verifyCurrent() {
  const plan = loadPlan();
  try {
    assertIdentity(plan.config);
    const verification = independentVerify(plan, plan.targetCommit);
    return emitResult(makeResult("verify", "success", plan, "Current deployment passed independent verification", { verification }));
  } catch (error) {
    const result = emitResult(makeResult("verify", "verification_failure", plan, "Current deployment verification failed", { error: sanitizeText(error.message, 4000) }));
    process.exitCode = exitCodeFor("verification_failure");
    return result;
  }
}

function diagnostics() {
  const plan = loadPlan();
  const logs = runCheckedSync("docker", ["compose", "logs", "--tail", "200", "--timestamps", "web", "archive-worker", "encode-worker"], { allowFailure: true });
  const compose = runCheckedSync("docker", ["compose", "ps", "--all"], { allowFailure: true });
  const resources = (() => {
    try { return checkResources({ ...plan.config, minimumRootFreeBytes: 0, minimumMemoryAvailableBytes: 0 }); }
    catch (error) { return { error: sanitizeText(error.message, 2000) }; }
  })();
  return emitResult(makeResult("diagnostics", "success", plan, "Collected bounded, sanitized deployment diagnostics", {
    compose: sanitizeText(compose.stdout, 16_384),
    logs: sanitizeText(`${logs.stdout}\n${logs.stderr}`, 65_536),
    resources,
  }));
}

export async function main(arguments_ = process.argv.slice(2)) {
  let options = { subcommand: arguments_[0] ?? "help" };
  try {
    options = parseArguments(arguments_);
    if (options.subcommand === "help" || options.subcommand === "--help") {
      process.stdout.write(`${usage()}\n`);
      return emitResult(
        makeResult("help", "success", undefined, "Displayed deployment CLI usage"),
        { persist: false },
      );
    }
    if (options.subcommand === "plan") return await createPlan(options);
    if (options.subcommand === "apply") return await applyPlan(options);
    if (options.subcommand === "run") return await startRun(options);
    if (options.subcommand === "status") return await showStatus();
    if (options.subcommand === "review") return await showReview();
    if (options.subcommand === "verify") return await verifyCurrent();
    if (options.subcommand === "diagnostics") return await diagnostics();
    throw new DeploymentError("validation_failure", `Unknown command: ${options.subcommand}`);
  } catch (error) {
    const failure = error instanceof DeploymentError
      ? error
      : new DeploymentError("validation_failure", error.message);
    process.stderr.write(`${usage()}\n`);
    const result = emitResult(
      makeResult(options.subcommand, failure.state, undefined, failure.message, failure.details),
      { persist: false },
    );
    process.exitCode = exitCodeFor(failure.state);
    return result;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
