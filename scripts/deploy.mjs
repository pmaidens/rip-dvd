#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const RESULT_PREFIX = "RIP_DVD_RESULT_JSON=";
const RESULT_SCHEMA_VERSION = 1;
const MAX_COMMAND_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 65_536;
const MAX_REVIEW_DIFF_BYTES = 65_536;
const MAX_REVIEW_BUNDLE_BYTES = 48 * 1024;
const MAX_LOG_BYTES = 1_048_576;
const MAX_FILES = 300;
const MAX_COMMITS = 100;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const TERMINAL_STATES = new Set([
  "active_work",
  "already_current",
  "concurrent_run",
  "pre_migration_failure",
  "post_migration_failure",
  "planned",
  "review_required",
  "stale_plan",
  "success",
  "validation_failure",
  "verification_failure",
]);
const EXIT_CODES = {
  active_work: 20,
  concurrent_run: 26,
  post_migration_failure: 24,
  pre_migration_failure: 23,
  review_required: 21,
  stale_plan: 22,
  validation_failure: 10,
  verification_failure: 25,
};

class DeploymentError extends Error {
  constructor(state, message, details = {}) {
    super(message);
    this.name = "DeploymentError";
    this.state = state;
    this.details = details;
  }
}

function tailBytes(value, maximum = MAX_COMMAND_BYTES) {
  const buffer = Buffer.from(String(value ?? ""));
  if (buffer.length <= maximum) return buffer.toString("utf8");
  return `[earlier output omitted]\n${buffer.subarray(buffer.length - maximum).toString("utf8")}`;
}

export function sanitizeText(value, maximum = MAX_COMMAND_BYTES) {
  const withoutPrivateKeys = tailBytes(value, maximum)
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .split(/\r?\n/u)
    .map((line) =>
      /\/(?:media\/(?:movies|originals)|mnt\/sandisk)(?:\/|\b)/iu.test(line)
        ? "[REDACTED_MEDIA_PATH]"
        : line,
    )
    .join("\n");
  return withoutPrivateKeys
    .replace(/\b((?:API_)?(?:KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY))\s*=\s*[^\s]+/giu, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/[\t ]+$/gmu, "");
}

function command(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_COMMAND_BYTES * 2,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout = tailBytes(result.stdout);
  const stderr = sanitizeText(result.stderr);
  if (result.error || result.status !== 0) {
    if (options.allowFailure) {
      return { status: result.status ?? 1, stdout, stderr };
    }
    const reason = result.error?.message ?? stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`${executable} failed: ${reason}`);
  }
  return { status: 0, stdout, stderr };
}

function streamingCommand(executable, arguments_, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logPath = resolve(stateDirectory(), "run-output.log");
    let stdout = "";
    let stderr = "";
    let log = "";
    try {
      log = readFileSync(logPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let flushTimer;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      writeFileSync(logPath, tailBytes(log, MAX_LOG_BYTES), {
        encoding: "utf8",
        mode: 0o600,
      });
    };
    const record = (channel, chunk) => {
      const text = sanitizeText(chunk, 65_536);
      if (channel === "stdout") {
        stdout = tailBytes(`${stdout}${text}`);
        process.stdout.write(text);
      } else {
        stderr = tailBytes(`${stderr}${text}`);
        process.stderr.write(text);
      }
      log = tailBytes(`${log}${text}`, MAX_LOG_BYTES);
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };
    child.stdout.on("data", (chunk) => record("stdout", chunk));
    child.stderr.on("data", (chunk) => record("stderr", chunk));
    child.on("error", (error) => {
      flush();
      resolvePromise({
        status: 1,
        stdout,
        stderr: `${stderr}${sanitizeText(error.message, 2000)}`,
      });
    });
    child.on("close", (status) => {
      flush();
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });
}

function stateDirectory() {
  if (process.env.RIP_DVD_DEPLOY_STATE_DIR) {
    return resolve(process.env.RIP_DVD_DEPLOY_STATE_DIR);
  }
  const path = command("git", ["rev-parse", "--git-path", "rip-dvd-deployment"]).stdout.trim();
  return resolve(REPOSITORY_ROOT, path);
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DeploymentError("validation_failure", `${label} is unavailable or invalid`, {
      error: sanitizeText(error.message, 1000),
    });
  }
}

function appendBoundedLog(path, line) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = tailBytes(`${current}${new Date().toISOString()} ${sanitizeText(line, 32_768)}\n`, MAX_LOG_BYTES);
  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
}

function compactResult(result) {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES) return result;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command: result.command,
    state: result.state,
    phase: result.phase,
    runId: result.runId,
    oldCommit: result.oldCommit,
    targetCommit: result.targetCommit,
    message: sanitizeText(result.message, 2000),
    details: { truncated: true },
  };
}

function emitResult(result, { persist = true } = {}) {
  const normalized = compactResult({
    schemaVersion: RESULT_SCHEMA_VERSION,
    ...result,
  });
  if (persist) {
    const directory = stateDirectory();
    atomicWriteJson(resolve(directory, "last-result.json"), normalized);
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(normalized)}\n`);
  return normalized;
}

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

function loadConfig(path) {
  let source;
  if (path === "-") {
    source = readFileSync(0, "utf8");
  } else if (typeof path === "string") {
    source = readFileSync(resolve(path), "utf8");
  } else {
    throw new DeploymentError("validation_failure", "plan requires --config PATH or --config -");
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new DeploymentError("validation_failure", "Deployment configuration is not valid JSON");
  }
  const requiredStrings = [
    "expectedHostname",
    "expectedRepositoryRoot",
    "expectedRemoteUrl",
  ];
  for (const key of requiredStrings) {
    if (typeof raw[key] !== "string" || raw[key].length === 0) {
      throw new DeploymentError("validation_failure", `Deployment configuration requires ${key}`);
    }
  }
  const expectedDrives = raw.expectedDrives ?? [];
  if (!Array.isArray(expectedDrives)) {
    throw new DeploymentError("validation_failure", "expectedDrives must be an array");
  }
  for (const drive of expectedDrives) {
    if (!drive || typeof drive.serialNumber !== "string" || typeof drive.applicationId !== "string") {
      throw new DeploymentError("validation_failure", "Each expected drive requires serialNumber and applicationId");
    }
  }
  return {
    expectedHostname: raw.expectedHostname,
    expectedRepositoryRoot: resolve(raw.expectedRepositoryRoot),
    expectedRemoteUrl: raw.expectedRemoteUrl,
    branch: raw.branch ?? "main",
    upstream: raw.upstream ?? "origin/main",
    remote: raw.remote ?? "origin",
    targetRef: raw.targetRef ?? "origin/main",
    healthUrl: raw.healthUrl ?? "http://127.0.0.1:3000/api/health",
    dashboardUrl: raw.dashboardUrl ?? "http://127.0.0.1:3000/api/dashboard",
    storagePaths: raw.storagePaths ?? ["/", "/mnt/sandisk"],
    minimumRootFreeBytes: raw.minimumRootFreeBytes ?? 4 * 1024 ** 3,
    minimumMemoryAvailableBytes: raw.minimumMemoryAvailableBytes ?? 512 * 1024 ** 2,
    expectedDrives,
  };
}

function normalizedRemote(value) {
  return value.trim().replace(/^git@github\.com:/u, "https://github.com/").replace(/\.git$/u, "");
}

function assertIdentity(config) {
  const actualHost = process.env.RIP_DVD_DEPLOY_HOSTNAME_OVERRIDE ?? hostname();
  if (actualHost !== config.expectedHostname) {
    throw new DeploymentError("validation_failure", "Deployment host identity does not match", {
      expected: config.expectedHostname,
      actual: actualHost,
    });
  }
  const actualRoot = resolve(command("git", ["rev-parse", "--show-toplevel"]).stdout.trim());
  if (actualRoot !== config.expectedRepositoryRoot || actualRoot !== REPOSITORY_ROOT) {
    throw new DeploymentError("validation_failure", "Repository root identity does not match", {
      expected: config.expectedRepositoryRoot,
      actual: actualRoot,
    });
  }
  const remote = command("git", ["remote", "get-url", config.remote]).stdout.trim();
  if (normalizedRemote(remote) !== normalizedRemote(config.expectedRemoteUrl)) {
    throw new DeploymentError("validation_failure", "Repository remote identity does not match", {
      expected: normalizedRemote(config.expectedRemoteUrl),
      actual: normalizedRemote(remote),
    });
  }
  const branch = command("git", ["branch", "--show-current"]).stdout.trim();
  const upstream = command("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).stdout.trim();
  if (branch !== config.branch || upstream !== config.upstream) {
    throw new DeploymentError("validation_failure", "Branch or upstream does not match", {
      expectedBranch: config.branch,
      actualBranch: branch,
      expectedUpstream: config.upstream,
      actualUpstream: upstream,
    });
  }
  const dirty = command("git", ["status", "--porcelain", "--untracked-files=normal"]).stdout;
  if (dirty.length > 0) {
    throw new DeploymentError("validation_failure", "Checkout has local changes", {
      paths: sanitizeText(dirty, 32_768).trim().split(/\r?\n/u),
    });
  }
  command("docker", ["compose", "config", "--quiet"]);
}

function parseMemoryAvailable(output) {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.trimStart().startsWith("Mem:"));
  const fields = line?.trim().split(/\s+/u) ?? [];
  const available = Number(fields[6]);
  if (!Number.isFinite(available)) throw new Error("free did not report available memory");
  return available;
}

function parseDiskRows(output) {
  const lines = output.trim().split(/\r?\n/u).slice(1);
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/u);
    return {
      filesystem: fields[0],
      availableBytes: Number(fields[3]) * 1024,
      usedPercent: fields[4],
      path: fields.at(-1),
    };
  });
}

function checkResources(config) {
  const memoryAvailableBytes = parseMemoryAvailable(command("free", ["--bytes"]).stdout);
  const disks = parseDiskRows(command("df", ["-Pk", ...config.storagePaths]).stdout);
  const root = disks.find((disk) => disk.path === "/") ?? disks[0];
  if (!root || root.availableBytes < config.minimumRootFreeBytes) {
    throw new DeploymentError("validation_failure", "Root filesystem lacks deployment build space", {
      requiredBytes: config.minimumRootFreeBytes,
      availableBytes: root?.availableBytes ?? null,
    });
  }
  if (memoryAvailableBytes < config.minimumMemoryAvailableBytes) {
    throw new DeploymentError("validation_failure", "Host lacks available memory for a deployment build", {
      requiredBytes: config.minimumMemoryAvailableBytes,
      availableBytes: memoryAvailableBytes,
    });
  }
  return { memoryAvailableBytes, disks };
}

function parseDashboard(output) {
  let dashboard;
  try {
    dashboard = JSON.parse(output);
  } catch {
    throw new Error("Dashboard returned malformed JSON");
  }
  const drives = (dashboard.opticalDrives?.items ?? []).map((drive) => ({
    id: String(drive.id ?? ""),
    displayName: String(drive.displayName ?? ""),
    state: String(drive.state ?? ""),
    inspection: drive.currentInspection
      ? { id: String(drive.currentInspection.id ?? ""), status: String(drive.currentInspection.status ?? "") }
      : null,
  }));
  const discs = (dashboard.detectedDiscs?.items ?? []).map((disc) => ({
    id: String(disc.id ?? ""),
    archiveRequest: disc.archiveRequest
      ? { id: String(disc.archiveRequest.id ?? ""), status: String(disc.archiveRequest.status ?? "") }
      : null,
  }));
  const archiveJobs = (dashboard.archiveJobs?.items ?? []).map((job) => ({
    id: String(job.id ?? ""),
    status: String(job.status ?? ""),
  }));
  const encodeJobs = (dashboard.encodeJobs?.items ?? []).map((job) => ({
    id: String(job.id ?? ""),
    status: String(job.status ?? ""),
  }));
  return { drives, discs, archiveJobs, encodeJobs };
}

function activeWork(dashboard) {
  const active = [];
  for (const drive of dashboard.drives) {
    if (drive.inspection?.status === "running") active.push({ kind: "disc_inspection", driveId: drive.id, ...drive.inspection });
  }
  for (const disc of dashboard.discs) {
    if (["pending", "running", "cancellation_requested"].includes(disc.archiveRequest?.status)) {
      active.push({ kind: "archive_request", discId: disc.id, ...disc.archiveRequest });
    }
  }
  for (const job of dashboard.archiveJobs) {
    if (job.status === "running") active.push({ kind: "archive_job", ...job });
  }
  for (const job of dashboard.encodeJobs) {
    if (["queued", "running", "cancellation_requested"].includes(job.status)) active.push({ kind: "encode_job", ...job });
  }
  return active;
}

function runtimeSnapshot(config) {
  const health = command("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", config.healthUrl]);
  const dashboard = parseDashboard(command("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", config.dashboardUrl]).stdout);
  const driveChecks = verifyDrives(config, dashboard);
  const failedUnits = command("systemctl", ["--failed", "--no-legend", "--plain"], { allowFailure: true }).stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => sanitizeText(line, 1000));
  return {
    health: sanitizeText(health.stdout, 2000).trim(),
    dashboard,
    driveChecks,
    activeWork: activeWork(dashboard),
    compose: sanitizeText(command("docker", ["compose", "ps"]).stdout, 16_384),
    dockerDiskUsage: sanitizeText(command("docker", ["system", "df"]).stdout, 16_384),
    failedUnits,
  };
}

function parseNameStatus(output) {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files = [];
  for (let index = 0; index < parts.length && files.length < MAX_FILES; index += 1) {
    const status = parts[index];
    if (/^[RC]/u.test(status)) {
      files.push({ status, oldPath: parts[index + 1], path: parts[index + 2] });
      index += 2;
    } else {
      files.push({ status, path: parts[index + 1] });
      index += 1;
    }
  }
  return files;
}

export function classifyReview(files, diff) {
  const paths = files.flatMap((file) => [file.path, file.oldPath].filter(Boolean));
  const reasons = new Set();
  const hasMigration = paths.some((path) => /(?:^|\/)(?:drizzle|migrations?)(?:\/|$)|\.sql$/u.test(path));
  const hasSchema = paths.some((path) => /packages\/data-access\/(?:src\/)?(?:schema|tables)|schema\.ts$/u.test(path));
  if (hasMigration) reasons.add("migration");
  if (hasSchema && !hasMigration) reasons.add("schema_without_migration");
  if (paths.some((path) => /(^|\/)compose(?:\.[^/]*)?\.ya?ml$/u.test(path))) {
    reasons.add("compose_change");
    if (/^[+-].*\b(?:volumes|devices)\s*:/gmu.test(diff)) reasons.add("compose_volumes_or_devices");
  }
  if (paths.some((path) => /(?:^|\/)Dockerfile(?:\.[^/]*)?$|\.Dockerfile$/u.test(path))) reasons.add("dockerfile");
  if (paths.some((path) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/u.test(path))) reasons.add("dependency_lockfile");
  if (paths.some((path) => /^(?:scripts\/(?:update|deploy|compose-|.*recover)|docker\/backup-sqlite|README\.md$)/u.test(path))) reasons.add("deployment_or_recovery");
  if (paths.some((path) => /optical-drive|optical_drives|compose.*hardware/iu.test(path)) || /^[+-].*\bdevices\s*:/gmu.test(diff)) reasons.add("optical_drive_identity_policy");
  if (paths.some((path) => path === ".env.example") || /^[+].*\$\{[A-Z0-9_]+(?::?\?)/gmu.test(diff)) reasons.add("required_environment");
  if (paths.some((path) => /^(?:\.github\/|docker\/|scripts\/)/u.test(path)) && reasons.size === 0) reasons.add("unclassified_operational_change");
  return [...reasons].sort();
}

function buildReviewBundle(oldCommit, targetCommit, commits, files, diff) {
  const reasons = classifyReview(files, diff);
  const bundle = {
    schemaVersion: 1,
    oldCommit,
    targetCommit,
    reviewRequired: reasons.length > 0,
    reasons,
    limits: {
      commits: MAX_COMMITS,
      files: MAX_FILES,
      diffBytes: MAX_REVIEW_DIFF_BYTES,
    },
    caveat: "The classifier identifies risky change classes. It does not prove SQL, configuration, or recovery changes are semantically safe.",
    commits: commits.slice(0, MAX_COMMITS),
    files: files.slice(0, MAX_FILES),
    relevantDiff: sanitizeText(diff, MAX_REVIEW_DIFF_BYTES),
  };
  while (Buffer.byteLength(JSON.stringify(bundle)) > MAX_REVIEW_BUNDLE_BYTES) {
    if (Buffer.byteLength(bundle.relevantDiff) > 4096) {
      bundle.relevantDiff = tailBytes(
        bundle.relevantDiff,
        Math.max(4096, Math.floor(Buffer.byteLength(bundle.relevantDiff) / 2)),
      );
    } else if (bundle.files.length > 50) {
      bundle.files = bundle.files.slice(0, Math.ceil(bundle.files.length / 2));
    } else if (bundle.commits.length > 20) {
      bundle.commits = bundle.commits.slice(0, Math.ceil(bundle.commits.length / 2));
    } else {
      bundle.relevantDiff = "[diff omitted to preserve the bounded review contract]";
      break;
    }
  }
  return bundle;
}

function gitPlan(config) {
  const oldCommit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  command("git", ["fetch", "--prune", config.remote]);
  const targetCommit = command("git", ["rev-parse", "--verify", `${config.targetRef}^{commit}`]).stdout.trim();
  if (!FULL_SHA.test(oldCommit) || !FULL_SHA.test(targetCommit)) {
    throw new DeploymentError("validation_failure", "Git did not return full commit SHAs", { oldCommit, targetCommit });
  }
  const ancestry = command("git", ["merge-base", "--is-ancestor", oldCommit, targetCommit], { allowFailure: true });
  if (ancestry.status !== 0) {
    throw new DeploymentError("validation_failure", "Current commit is not an ancestor of the deployment target", { oldCommit, targetCommit });
  }
  const commitOutput = command("git", ["log", "--format=%H%x09%s", "--no-merges", `${oldCommit}..${targetCommit}`]).stdout;
  const commits = commitOutput.trim().split(/\r?\n/u).filter(Boolean).slice(0, MAX_COMMITS).map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: sanitizeText(subject.join("\t"), 1000) };
  });
  const files = parseNameStatus(command("git", ["diff", "--name-status", "-z", `${oldCommit}..${targetCommit}`]).stdout);
  const diff = command("git", [
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
    "packages/data-access/drizzle",
    "packages/data-access/src",
  ]).stdout;
  return { oldCommit, targetCommit, commits, files, diff };
}

function planId(oldCommit, targetCommit) {
  return createHash("sha256").update(`${oldCommit}\0${targetCommit}`).digest("hex").slice(0, 24);
}

function progress(run, phase, message, details = {}) {
  const directory = stateDirectory();
  const next = { ...run, phase, message, details, updatedAt: new Date().toISOString() };
  atomicWriteJson(resolve(directory, "status.json"), next);
  appendBoundedLog(resolve(directory, "deployment.log"), `${phase}: ${message}`);
  process.stdout.write(`${message}\n`);
  return next;
}

function makeResult(commandName, state, plan, message, details = {}, run = {}) {
  return {
    command: commandName,
    state,
    phase: run.phase ?? state,
    runId: run.runId,
    planId: plan?.planId,
    oldCommit: plan?.oldCommit,
    targetCommit: plan?.targetCommit,
    message,
    details,
  };
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
  };
  try {
    run = progress(run, "preflight", "Checking deployment host, checkout, runtime, and resources.");
    assertIdentity(config);
    const resources = checkResources(config);
    const runtime = runtimeSnapshot(config);
    run = progress(run, "fetch", "Fetching the deployment remote and freezing the reviewed target.");
    const git = gitPlan(config);
    const review = buildReviewBundle(git.oldCommit, git.targetCommit, git.commits, git.files, git.diff);
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
      process.exitCode = EXIT_CODES.active_work;
      return result;
    }
    if (review.reviewRequired) {
      run = progress(run, "review_required", "The frozen commit range requires human semantic review.", { reasons: review.reasons });
      const result = emitResult(makeResult("plan", "review_required", plan, run.message, { reasons: review.reasons, reviewBundle: resolve(directory, "review-bundle.json") }, run));
      process.exitCode = EXIT_CODES.review_required;
      return result;
    }
    run = progress(run, "planned", "Deployment plan is ready for the frozen target.");
    return emitResult(makeResult("plan", "planned", plan, run.message, { reviewBundle: resolve(directory, "review-bundle.json") }, run));
  } catch (error) {
    const failure = error instanceof DeploymentError ? error : new DeploymentError("validation_failure", error.message);
    run = progress(run, failure.state, failure.message, failure.details);
    const result = emitResult(makeResult("plan", failure.state, undefined, failure.message, failure.details, run));
    process.exitCode = EXIT_CODES[failure.state] ?? 1;
    return result;
  }
}

function loadPlan() {
  return readJson(resolve(stateDirectory(), "plan.json"), "Deployment plan");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireLock(runId) {
  const lock = resolve(stateDirectory(), "run.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = {};
    try {
      owner = JSON.parse(readFileSync(resolve(lock, "owner.json"), "utf8"));
    } catch {}
    if (processAlive(owner.pid)) {
      throw new DeploymentError("concurrent_run", "Another deployment process is running", owner);
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { mode: 0o700 });
  }
  atomicWriteJson(resolve(lock, "owner.json"), { pid: process.pid, runId, startedAt: new Date().toISOString() });
  return () => rmSync(lock, { recursive: true, force: true });
}

function assertFreshPlan(plan, options) {
  if (!FULL_SHA.test(options.target ?? "") || options.target !== plan.targetCommit) {
    throw new DeploymentError("stale_plan", "Apply target must equal the plan's frozen full SHA", {
      plannedTarget: plan.targetCommit,
      requestedTarget: options.target ?? null,
    });
  }
  assertIdentity(plan.config);
  const head = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== plan.oldCommit) {
    throw new DeploymentError("stale_plan", "Checkout HEAD changed after planning", { plannedHead: plan.oldCommit, actualHead: head });
  }
  command("git", ["fetch", "--prune", plan.config.remote]);
  const currentTarget = command("git", ["rev-parse", "--verify", `${plan.targetRef}^{commit}`]).stdout.trim();
  if (currentTarget !== plan.targetCommit) {
    throw new DeploymentError("stale_plan", "Deployment target moved after review", {
      plannedTarget: plan.targetCommit,
      currentTarget,
    });
  }
  const ancestry = command("git", ["merge-base", "--is-ancestor", plan.oldCommit, plan.targetCommit], { allowFailure: true });
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

function parseBackupFilename(output) {
  const matches = [...output.matchAll(/SQLite backup written to \/backups\/([^\s/]+\.sqlite)\b/gu)];
  return matches.at(-1)?.[1] ?? null;
}

function verifyBackup(filename) {
  if (!filename || basename(filename) !== filename) {
    throw new Error("Updater did not report a safe backup filename");
  }
  const environment = command("docker", ["compose", "config", "--environment"]).stdout;
  const configured = environment.split(/\r?\n/u).find((line) => line.startsWith("RIP_DVD_BACKUP_HOST_PATH="))?.slice("RIP_DVD_BACKUP_HOST_PATH=".length);
  const directory = configured ? resolve(REPOSITORY_ROOT, configured) : resolve(REPOSITORY_ROOT, "backups");
  const path = resolve(directory, filename);
  if (dirname(path) !== resolve(directory) || statSync(path).size <= 0) {
    throw new Error("The reported backup file is missing or empty");
  }
  return { filename, sizeBytes: statSync(path).size };
}

function verifyDrives(config, dashboard) {
  const output = command("docker", ["compose", "exec", "-T", "archive-worker", "lsblk", "--json", "--output", "PATH,TYPE,MODEL,SERIAL"]).stdout;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("archive-worker lsblk returned malformed JSON");
  }
  const physical = (parsed.blockdevices ?? []).filter((device) => device.type === "rom");
  const checks = config.expectedDrives.map((expected) => {
    const hardware = physical.filter((device) => String(device.serial ?? "").trim() === expected.serialNumber);
    const application = dashboard.drives.filter((drive) => drive.id === expected.applicationId);
    return {
      serialNumber: expected.serialNumber,
      applicationId: expected.applicationId,
      hardwareMatches: hardware.length,
      applicationMatches: application.length,
      applicationState: application[0]?.state ?? null,
    };
  });
  const mismatch = checks.find((check) => check.hardwareMatches !== 1 || check.applicationMatches !== 1 || ["missing", "disabled"].includes(check.applicationState));
  if (mismatch) throw new Error(`Physical optical-drive identity check failed for ${mismatch.serialNumber}`);
  return checks;
}

function independentVerify(plan, expectedCommit) {
  const head = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  const dirty = command("git", ["status", "--porcelain", "--untracked-files=normal"]).stdout;
  if (head !== expectedCommit || dirty.length > 0) throw new Error("Checkout verification failed after deployment");
  command("docker", ["compose", "config", "--quiet"]);
  const web = command("docker", ["compose", "ps", "--quiet", "web"]).stdout.trim();
  if (!web) throw new Error("Web service container is unavailable");
  const webStatus = command("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", web]).stdout.trim();
  if (webStatus !== "healthy") throw new Error(`Web service is ${webStatus || "unknown"}`);
  const services = new Set(command("docker", ["compose", "ps", "--status", "running", "--services"]).stdout.trim().split(/\r?\n/u));
  for (const service of ["web", "archive-worker", "encode-worker"]) {
    if (!services.has(service)) throw new Error(`Runtime service is not running: ${service}`);
  }
  command("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", plan.config.healthUrl]);
  const dashboard = parseDashboard(command("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", plan.config.dashboardUrl]).stdout);
  const drives = verifyDrives(plan.config, dashboard);
  const failedUnitsAfter = command("systemctl", ["--failed", "--no-legend", "--plain"], { allowFailure: true }).stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => sanitizeText(line, 1000));
  const newFailedUnits = failedUnitsAfter.filter((line) => !plan.failedUnitsBefore.includes(line));
  if (newFailedUnits.length > 0) throw new Error(`New failed systemd units: ${newFailedUnits.join(", ")}`);
  const logs = command("docker", ["compose", "logs", "--since", "10m", "--no-color", "web", "archive-worker", "encode-worker"], { allowFailure: true }).stdout
    .split(/\r?\n/u)
    .filter((line) => /error|fail|fatal|panic|unhandled|exception|unhealthy/iu.test(line))
    .map((line) => sanitizeText(line, 4000))
    .slice(-200);
  if (logs.length > 0) {
    throw new Error("Recent runtime logs contain error indicators; inspect the sanitized diagnostics");
  }
  return { head, webStatus, services: [...services], drives, failedUnitsAfter, suspiciousLogs: logs };
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
  };
  let release = () => {};
  try {
    release = acquireLock(run.runId);
    run = progress(run, "preflight", "Rechecking the frozen deployment plan before changing HEAD.");
    const stagePath = resolve(stateDirectory(), "update-stage");
    try { rmSync(stagePath, { force: true }); } catch {}
    assertFreshPlan(plan, options);
    run = progress(run, "apply", `Applying reviewed commit ${plan.targetCommit}.`);
    const updater = await streamingCommand("sh", [resolve(REPOSITORY_ROOT, "scripts/update.sh"), "--target", plan.targetCommit], {
      env: {
        ...process.env,
        RIP_DVD_CONTROLLER_LOCK_HELD: "1",
        RIP_DVD_UPDATE_STAGE_FILE: stagePath,
      },
    });
    appendBoundedLog(resolve(stateDirectory(), "deployment.log"), `${updater.stdout}\n${updater.stderr}`);
    process.stdout.write(sanitizeText(updater.stdout, 65_536));
    if (updater.status !== 0) {
      let stage = "unknown";
      try { stage = readFileSync(stagePath, "utf8").trim(); } catch {}
      const postMigration = ["migration", "verification"].includes(stage);
      const state = postMigration ? "post_migration_failure" : "pre_migration_failure";
      throw new DeploymentError(state, postMigration
        ? "Deployment failed after runtime services were stopped; keep them stopped and use recovery guidance."
        : "Deployment failed before migration; the old runtime should still be running.", {
        stage,
        exitCode: updater.status,
        output: sanitizeText(`${updater.stdout}\n${updater.stderr}`, 32_768),
      });
    }
    let backup;
    try {
      if (!updater.stdout.includes("SQLite migrations are current")) {
        throw new Error("Updater output did not confirm current SQLite migrations");
      }
      backup = verifyBackup(parseBackupFilename(updater.stdout));
    } catch (error) {
      command("sh", [resolve(REPOSITORY_ROOT, "scripts/compose-stop.sh")], { allowFailure: true });
      throw new DeploymentError("verification_failure", "Deployment evidence verification failed; runtime services were stopped", {
        error: sanitizeText(error.message, 4000),
      });
    }
    run = progress(run, "verification", "Running independent service, drive, systemd, and log checks.");
    let verification;
    try {
      verification = independentVerify(plan, plan.targetCommit);
    } catch (error) {
      command("sh", [resolve(REPOSITORY_ROOT, "scripts/compose-stop.sh")], { allowFailure: true });
      throw new DeploymentError("verification_failure", "Independent deployment verification failed; runtime services were stopped", {
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
          ["migration", "verification", "complete"].includes(stage)
            ? "post_migration_failure"
            : "pre_migration_failure",
          error.message,
          { stage },
        );
    run = progress(run, failure.state, failure.message, failure.details);
    const result = emitResult(makeResult("apply", failure.state, plan, failure.message, failure.details, run));
    process.exitCode = EXIT_CODES[failure.state] ?? 1;
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
    process.exitCode = EXIT_CODES.stale_plan;
    return result;
  }
  const screenArguments = ["-DmS", "rip-dvd-update", process.execPath, SCRIPT_PATH, "apply", "--target", options.target];
  if (options.approve_review) screenArguments.push("--approve-review", options.approve_review);
  if (options.allow_active_work) screenArguments.push("--allow-active-work");
  const existing = command("screen", ["-ls"], { allowFailure: true });
  if (existing.stdout.includes(".rip-dvd-update")) {
    return emitResult(makeResult("run", "running", plan, "The named deployment Screen session is already running. Use status to reconnect."));
  }
  const started = command("screen", screenArguments, { allowFailure: true });
  if (started.status !== 0) {
    const result = emitResult(makeResult("run", "validation_failure", plan, "Could not start the deployment Screen session", { error: started.stderr }));
    process.exitCode = EXIT_CODES.validation_failure;
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
    process.exitCode = EXIT_CODES.validation_failure;
    return result;
  }
  const state = TERMINAL_STATES.has(status.phase) ? status.phase : "running";
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
  if (review.reviewRequired) process.exitCode = EXIT_CODES.review_required;
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
    process.exitCode = EXIT_CODES.verification_failure;
    return result;
  }
}

function diagnostics() {
  const plan = loadPlan();
  const logs = command("docker", ["compose", "logs", "--tail", "200", "--timestamps", "web", "archive-worker", "encode-worker"], { allowFailure: true });
  const compose = command("docker", ["compose", "ps", "--all"], { allowFailure: true });
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

export function main(arguments_ = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(arguments_);
  } catch (error) {
    const failure = error instanceof DeploymentError ? error : new DeploymentError("validation_failure", error.message);
    process.stderr.write(`${usage()}\n`);
    const result = emitResult(makeResult("unknown", failure.state, undefined, failure.message, failure.details), { persist: false });
    process.exitCode = EXIT_CODES[failure.state] ?? 1;
    return result;
  }
  if (options.subcommand === "help" || options.subcommand === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.subcommand === "plan") return createPlan(options);
  if (options.subcommand === "apply") return applyPlan(options);
  if (options.subcommand === "run") return startRun(options);
  if (options.subcommand === "status") return showStatus();
  if (options.subcommand === "review") return showReview();
  if (options.subcommand === "verify") return verifyCurrent();
  if (options.subcommand === "diagnostics") return diagnostics();
  process.stderr.write(`${usage()}\n`);
  const result = emitResult(makeResult(options.subcommand, "validation_failure", undefined, `Unknown command: ${options.subcommand}`), { persist: false });
  process.exitCode = EXIT_CODES.validation_failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
