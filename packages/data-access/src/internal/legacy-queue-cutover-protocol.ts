import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface LegacyQueueCutoverProtocol {
  version: number;
  command: string;
  indexes: {
    state: number;
    release: number;
    heartbeat: number;
  };
  states: {
    starting: number;
    intentReady: number;
    ready: number;
    released: number;
    failed: number;
  };
  sentinels: {
    abort: string;
    error: string;
    intentReady: string;
    ready: string;
    release: string;
    released: string;
    workerError: string;
  };
}

function protocolRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Legacy queue cutover protocol ${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function protocolInteger(
  record: Record<string, unknown>,
  name: string,
  path: string,
): number {
  const value = record[name];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(
      `Legacy queue cutover protocol ${path}.${name} must be a non-negative integer`,
    );
  }
  return value as number;
}

function protocolSentinel(
  record: Record<string, unknown>,
  name: string,
): string {
  const value = record[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    basename(value) !== value
  ) {
    throw new Error(
      `Legacy queue cutover protocol sentinels.${name} must be a non-empty basename`,
    );
  }
  return value;
}

function protocolCommand(record: Record<string, unknown>): string {
  const value = record.command;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "Legacy queue cutover protocol contract.command must be a non-empty string",
    );
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
): void {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    const missing = sortedExpectedKeys.find((key) => !(key in record));
    throw new Error(
      `Legacy queue cutover protocol ${path}${
        missing ? `.${missing}` : ""
      } has unexpected fields`,
    );
  }
}

function requireUniqueValues(
  values: readonly (number | string)[],
  path: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(
      `Legacy queue cutover protocol ${path} values must be unique`,
    );
  }
}

export function loadLegacyQueueCutoverProtocol(
  protocolPath: string,
): LegacyQueueCutoverProtocol {
  const decoded: unknown = JSON.parse(readFileSync(protocolPath, "utf8"));
  const root = protocolRecord(decoded, "contract");
  requireExactKeys(
    root,
    ["version", "command", "indexes", "states", "sentinels"],
    "contract",
  );
  const indexesRecord = protocolRecord(root.indexes, "indexes");
  const statesRecord = protocolRecord(root.states, "states");
  const sentinelsRecord = protocolRecord(root.sentinels, "sentinels");
  requireExactKeys(indexesRecord, ["state", "release", "heartbeat"], "indexes");
  requireExactKeys(
    statesRecord,
    ["starting", "intentReady", "ready", "released", "failed"],
    "states",
  );
  requireExactKeys(
    sentinelsRecord,
    [
      "abort",
      "error",
      "intentReady",
      "ready",
      "release",
      "released",
      "workerError",
    ],
    "sentinels",
  );

  const protocol: LegacyQueueCutoverProtocol = {
    version: protocolInteger(root, "version", "contract"),
    command: protocolCommand(root),
    indexes: {
      state: protocolInteger(indexesRecord, "state", "indexes"),
      release: protocolInteger(indexesRecord, "release", "indexes"),
      heartbeat: protocolInteger(indexesRecord, "heartbeat", "indexes"),
    },
    states: {
      starting: protocolInteger(statesRecord, "starting", "states"),
      intentReady: protocolInteger(statesRecord, "intentReady", "states"),
      ready: protocolInteger(statesRecord, "ready", "states"),
      released: protocolInteger(statesRecord, "released", "states"),
      failed: protocolInteger(statesRecord, "failed", "states"),
    },
    sentinels: {
      abort: protocolSentinel(sentinelsRecord, "abort"),
      error: protocolSentinel(sentinelsRecord, "error"),
      intentReady: protocolSentinel(sentinelsRecord, "intentReady"),
      ready: protocolSentinel(sentinelsRecord, "ready"),
      release: protocolSentinel(sentinelsRecord, "release"),
      released: protocolSentinel(sentinelsRecord, "released"),
      workerError: protocolSentinel(sentinelsRecord, "workerError"),
    },
  };
  requireUniqueValues(Object.values(protocol.indexes), "indexes");
  requireUniqueValues(Object.values(protocol.states), "states");
  requireUniqueValues(Object.values(protocol.sentinels), "sentinels");
  const sortedIndexes = Object.values(protocol.indexes).sort(
    (left, right) => left - right,
  );
  if (sortedIndexes.some((value, index) => value !== index)) {
    throw new Error(
      "Legacy queue cutover protocol indexes must be contiguous from zero",
    );
  }
  if (
    !(
      protocol.states.starting < protocol.states.intentReady &&
      protocol.states.intentReady < protocol.states.ready &&
      protocol.states.ready < protocol.states.released
    )
  ) {
    throw new Error(
      "Legacy queue cutover protocol lifecycle states must be ordered",
    );
  }
  return protocol;
}

export const LEGACY_QUEUE_CUTOVER_WORKER = String.raw`
const { spawn } = require("node:child_process");
const {
  existsSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const protocol = workerData.protocol;
const states = protocol.states;
const indexes = protocol.indexes;
const sentinels = protocol.sentinels;
const sharedState = new Int32Array(workerData.sharedState);
const statePath = (name) => join(workerData.stateDirectory, name);
let finished = false;
let releaseSent = false;
let failurePublished = false;
let terminationRequestedAt;
let terminationSignalSentAt;
let timer;

function publishHeartbeat() {
  Atomics.add(sharedState, indexes.heartbeat, 1);
  Atomics.notify(sharedState, indexes.heartbeat);
}

function publishState(state) {
  if (finished && state !== states.failed) {
    return;
  }
  Atomics.store(sharedState, indexes.state, state);
  Atomics.notify(sharedState, indexes.state);
}

function finish() {
  finished = true;
  if (timer) {
    clearInterval(timer);
  }
  parentPort.close();
}

function publishFailure(message) {
  if (failurePublished) {
    return;
  }
  failurePublished = true;
  try {
    writeFileSync(statePath(sentinels.workerError), message, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {}
  publishState(states.failed);
}

function requestHelperTermination() {
  if (helper.exitCode === null && helper.signalCode === null) {
    if (terminationRequestedAt === undefined) {
      terminationRequestedAt = Date.now();
      return;
    }
    if (
      terminationSignalSentAt === undefined &&
      Date.now() - terminationRequestedAt >=
        workerData.terminationGraceMs
    ) {
      terminationSignalSentAt = Date.now();
      helper.kill("SIGTERM");
    } else if (
      terminationSignalSentAt !== undefined &&
      Date.now() - terminationSignalSentAt >=
        workerData.terminationGraceMs
    ) {
      helper.kill("SIGKILL");
    }
  }
}

function stateExists(name) {
  try {
    return existsSync(statePath(name));
  } catch (error) {
    publishFailure(
      "Legacy queue lease worker failed during " +
        phase() +
        ": could not inspect state " +
        name +
        ": " +
        error.message,
    );
    return false;
  }
}

function readState(name) {
  if (!stateExists(name)) {
    return null;
  }
  try {
    return readFileSync(statePath(name), "utf8");
  } catch (error) {
    publishFailure(
      "Legacy queue lease worker failed during " +
        phase() +
        ": could not read state " +
        name +
        ": " +
        error.message,
    );
    return null;
  }
}

function markReleased() {
  try {
    writeFileSync(statePath(sentinels.released), "", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") {
      publishFailure(
        "Could not publish legacy queue lease release: " + error.message,
      );
    }
  }
}

function phase() {
  const state = Atomics.load(sharedState, indexes.state);
  if (state < states.intentReady) {
    return "intent acquisition";
  }
  if (state < states.ready) {
    return "queue drain";
  }
  return "release acknowledgement";
}

function observeSentinels() {
  if (
    Atomics.load(sharedState, indexes.state) < states.intentReady &&
    stateExists(sentinels.intentReady)
  ) {
    publishState(states.intentReady);
  }
  if (
    Atomics.load(sharedState, indexes.state) < states.ready &&
    stateExists(sentinels.ready)
  ) {
    publishState(states.ready);
  }
}

const helper = spawn(
  workerData.python,
  [
    workerData.helperPath,
    protocol.command,
    workerData.originalsLibraryPath,
    workerData.stateDirectory,
    "--protocol",
    workerData.protocolArgument,
  ],
  { stdio: ["pipe", "ignore", "inherit"] },
);
publishHeartbeat();

helper.once("error", (error) => {
  publishFailure("Legacy queue lease helper failed to start: " + error.message);
});
helper.once("exit", (code, signal) => {
  const helperError = readState(sentinels.error);
  const released = stateExists(sentinels.released);
  const aborted = stateExists(sentinels.abort);
  if (helperError !== null) {
    publishFailure(helperError);
  } else if (!released && !aborted && !failurePublished) {
    observeSentinels();
    publishFailure(
      "Legacy queue lease helper exited during " +
        phase() +
        " (code " +
        String(code) +
        ", signal " +
        String(signal) +
        ")",
    );
  }
  markReleased();
  if (!failurePublished) {
    publishState(states.released);
  }
  finish();
});

timer = setInterval(() => {
  publishHeartbeat();
  const helperError = readState(sentinels.error);
  if (helperError !== null) {
    publishFailure(helperError);
    return;
  }
  observeSentinels();
  if (stateExists(sentinels.abort)) {
    requestHelperTermination();
  }
  if (
    !releaseSent &&
    Atomics.load(sharedState, indexes.release) === 1
  ) {
    releaseSent = true;
    try {
      writeFileSync(statePath(sentinels.release), "", {
        flag: "wx",
        mode: 0o600,
      });
      helper.stdin.end();
    } catch (error) {
      publishFailure(
        "Could not release the legacy queue lease: " + error.message,
      );
      return;
    }
  }
}, workerData.pollMs);
`;
