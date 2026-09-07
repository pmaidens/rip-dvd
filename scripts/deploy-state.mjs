import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  MAX_LOG_BYTES,
  REPOSITORY_ROOT,
  runCheckedSync,
  sanitizeText,
  tailBytes,
} from "./deploy-support.mjs";

const RESULT_PREFIX = "RIP_DVD_RESULT_JSON=";
export const RESULT_SCHEMA_VERSION = 1;
const MAX_RESULT_BYTES = 65_536;

const STATE_METADATA = Object.freeze({
  running: { terminal: false, exitCode: 0 },
  active_work: { terminal: true, exitCode: 20 },
  already_current: { terminal: true, exitCode: 0 },
  concurrent_run: { terminal: true, exitCode: 26 },
  planned: { terminal: true, exitCode: 0 },
  post_migration_failure: { terminal: true, exitCode: 24 },
  pre_migration_failure: { terminal: true, exitCode: 23 },
  review_required: { terminal: true, exitCode: 21 },
  stale_plan: { terminal: true, exitCode: 22 },
  success: { terminal: true, exitCode: 0 },
  validation_failure: { terminal: true, exitCode: 10 },
  verification_failure: { terminal: true, exitCode: 25 },
});

export class DeploymentError extends Error {
  constructor(state, message, details = {}) {
    super(message);
    this.name = "DeploymentError";
    this.state = state;
    this.details = details;
  }
}

export function exitCodeFor(state) {
  return STATE_METADATA[state]?.exitCode ?? 1;
}

export function isTerminalState(state) {
  return STATE_METADATA[state]?.terminal === true;
}

export function stateDirectory() {
  if (process.env.RIP_DVD_DEPLOY_STATE_DIR) {
    return resolve(process.env.RIP_DVD_DEPLOY_STATE_DIR);
  }
  const path = runCheckedSync("git", ["rev-parse", "--git-path", "rip-dvd-deployment"]).stdout.trim();
  return resolve(REPOSITORY_ROOT, path);
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DeploymentError("validation_failure", `${label} is unavailable or invalid`, {
      error: sanitizeText(error.message, 1000),
    });
  }
}

export function appendBoundedLog(path, line, privatePaths = []) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = tailBytes(
    `${current}${new Date().toISOString()} ${sanitizeText(line, 32_768, privatePaths)}\n`,
    MAX_LOG_BYTES,
  );
  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
}

function sanitizeStructured(value, privatePaths) {
  if (typeof value === "string") return sanitizeText(value, 65_536, privatePaths);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStructured(entry, privatePaths));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(?:authorization|key|.*(?:credential|password|secret|token)|.*(?:api|private)[_-]?key)$/iu.test(key)
          ? "[REDACTED]"
          : sanitizeStructured(entry, privatePaths),
      ]),
    );
  }
  return value;
}

function compactResult(result) {
  if (Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES) return result;
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

export function emitResult(result, { persist = true } = {}) {
  const { _privatePaths: privatePaths = [], ...publicResult } = result;
  const normalized = compactResult(sanitizeStructured({
    schemaVersion: RESULT_SCHEMA_VERSION,
    ...publicResult,
  }, privatePaths));
  if (persist) {
    atomicWriteJson(resolve(stateDirectory(), "last-result.json"), normalized);
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(normalized)}\n`);
  return normalized;
}

export function progress(run, phase, message, details = {}) {
  const directory = stateDirectory();
  const { _privatePaths: privatePaths = [], ...publicRun } = run;
  const persisted = sanitizeStructured(
    { ...publicRun, phase, message, details, updatedAt: new Date().toISOString() },
    privatePaths,
  );
  atomicWriteJson(resolve(directory, "status.json"), persisted);
  appendBoundedLog(resolve(directory, "deployment.log"), `${phase}: ${message}`, privatePaths);
  process.stdout.write(`${sanitizeText(message, 65_536, privatePaths)}\n`);
  return { ...persisted, _privatePaths: privatePaths };
}

export function makeResult(commandName, state, plan, message, details = {}, run = {}) {
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
    _privatePaths: plan?.config?.storagePaths ?? run._privatePaths ?? [],
  };
}

function readLockOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function closeLock(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.stdin.end();
  });
}

export function acquireLock(runId) {
  const directory = stateDirectory();
  const lock = resolve(directory, "run.lock");
  const ownerPath = resolve(directory, "run.lock.owner.json");
  const owner = {
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        lock,
        "sh",
        "-c",
        "printf 'RIP_DVD_LOCKED\\n'; cat >/dev/null",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let settled = false;
    let output = "";
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new DeploymentError(
        "validation_failure",
        "Timed out while acquiring the deployment lock",
      ));
    }, 5_000);
    child.once("error", (error) => fail(new DeploymentError(
      "validation_failure",
      "The operating-system deployment lock is unavailable",
      { error: sanitizeText(error.message, 1000) },
    )));
    child.once("close", () => fail(new DeploymentError(
      "concurrent_run",
      "Another deployment process is running",
      readLockOwner(ownerPath),
    )));
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!output.includes("RIP_DVD_LOCKED\n") || settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        atomicWriteJson(ownerPath, owner);
      } catch (error) {
        child.stdin.end();
        rejectPromise(error);
        return;
      }
      resolvePromise(async () => {
        let ownershipError;
        const publishedOwner = readLockOwner(ownerPath);
        if (publishedOwner.runId !== runId || publishedOwner.pid !== process.pid) {
          ownershipError = new DeploymentError(
            "concurrent_run",
            "Deployment lock ownership changed before release",
          );
        }
        try {
          if (!ownershipError) rmSync(ownerPath);
        } finally {
          await closeLock(child);
        }
        if (ownershipError) throw ownershipError;
      });
    });
  });
}
