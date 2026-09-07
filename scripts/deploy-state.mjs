import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  linkSync,
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function concurrentRun(owner = {}) {
  return new DeploymentError(
    "concurrent_run",
    "Another deployment process is running",
    owner,
  );
}

function readLockOwner(lock) {
  try {
    try {
      return JSON.parse(readFileSync(lock, "utf8"));
    } catch (error) {
      if (error?.code !== "EISDIR") throw error;
      return JSON.parse(readFileSync(resolve(lock, "owner.json"), "utf8"));
    }
  } catch {
    return null;
  }
}

function publishLock(candidate, lock) {
  linkSync(candidate, lock);
  try {
    rmSync(candidate);
  } catch (error) {
    rmSync(lock);
    throw error;
  }
}

export function acquireLock(runId) {
  const directory = stateDirectory();
  const lock = resolve(directory, "run.lock");
  const recovery = resolve(directory, "run.lock.recovery");
  const candidate = resolve(directory, `run.lock.candidate-${process.pid}-${randomUUID()}`);
  const owner = {
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(candidate, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  let acquired = false;
  try {
    publishLock(candidate, lock);
    acquired = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      rmSync(candidate, { force: true });
      throw error;
    }
    const publishedOwner = readLockOwner(lock);
    if (publishedOwner === null || processAlive(publishedOwner.pid)) {
      rmSync(candidate);
      throw concurrentRun(publishedOwner ?? {});
    }
    try {
      mkdirSync(recovery, { mode: 0o700 });
    } catch (recoveryError) {
      rmSync(candidate);
      if (recoveryError?.code === "EEXIST") throw concurrentRun();
      throw recoveryError;
    }
    try {
      const confirmedOwner = readLockOwner(lock);
      if (
        confirmedOwner === null
        || confirmedOwner.runId !== publishedOwner.runId
        || confirmedOwner.pid !== publishedOwner.pid
        || processAlive(confirmedOwner.pid)
      ) {
        throw concurrentRun(confirmedOwner ?? {});
      }
      rmSync(lock, { recursive: true });
      try {
        publishLock(candidate, lock);
        acquired = true;
      } catch (replacementError) {
        if (replacementError?.code === "EEXIST") {
          throw concurrentRun(readLockOwner(lock) ?? {});
        }
        throw replacementError;
      }
    } finally {
      if (!acquired) rmSync(candidate, { force: true });
      rmSync(recovery, { recursive: true });
    }
  }
  return () => {
    const publishedOwner = readLockOwner(lock);
    if (publishedOwner?.runId !== runId || publishedOwner?.pid !== process.pid) {
      throw new DeploymentError(
        "concurrent_run",
        "Deployment lock ownership changed before release",
      );
    }
    rmSync(lock, { recursive: true });
  };
}
