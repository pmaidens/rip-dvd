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

export interface LoadedLegacyQueueCutoverProtocol {
  argument: string;
  protocol: LegacyQueueCutoverProtocol;
}

function parseProtocolManifest(manifest: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of manifest.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("Legacy queue cutover protocol manifest is malformed");
    }
    const name = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    if (!value || name in fields) {
      throw new Error("Legacy queue cutover protocol manifest is malformed");
    }
    fields[name] = value;
  }
  return fields;
}

function protocolInteger(
  record: Record<string, string>,
  name: string,
): number {
  const rawValue = record[name];
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== rawValue) {
    throw new Error(
      `Legacy queue cutover protocol ${name} must be a non-negative integer`,
    );
  }
  return value;
}

function protocolSentinel(
  record: Record<string, string>,
  name: string,
): string {
  const path = `sentinels.${name}`;
  const value = record[path];
  if (!value || basename(value) !== value) {
    throw new Error(
      `Legacy queue cutover protocol ${path} must be a non-empty basename`,
    );
  }
  return value;
}

function protocolCommand(record: Record<string, string>): string {
  const value = record.command;
  if (!value) {
    throw new Error(
      "Legacy queue cutover protocol contract.command must be a non-empty string",
    );
  }
  return value;
}

function requireExactKeys(
  record: Record<string, string>,
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
): LoadedLegacyQueueCutoverProtocol {
  const argument = readFileSync(protocolPath, "utf8").trim();
  const fields = parseProtocolManifest(argument);
  requireExactKeys(
    fields,
    [
      "version",
      "command",
      "indexes.state",
      "indexes.release",
      "indexes.heartbeat",
      "states.starting",
      "states.intentReady",
      "states.ready",
      "states.released",
      "states.failed",
      "sentinels.abort",
      "sentinels.error",
      "sentinels.intentReady",
      "sentinels.ready",
      "sentinels.release",
      "sentinels.released",
      "sentinels.workerError",
    ],
    "manifest",
  );

  const protocol: LegacyQueueCutoverProtocol = {
    version: protocolInteger(fields, "version"),
    command: protocolCommand(fields),
    indexes: {
      state: protocolInteger(fields, "indexes.state"),
      release: protocolInteger(fields, "indexes.release"),
      heartbeat: protocolInteger(fields, "indexes.heartbeat"),
    },
    states: {
      starting: protocolInteger(fields, "states.starting"),
      intentReady: protocolInteger(fields, "states.intentReady"),
      ready: protocolInteger(fields, "states.ready"),
      released: protocolInteger(fields, "states.released"),
      failed: protocolInteger(fields, "states.failed"),
    },
    sentinels: {
      abort: protocolSentinel(fields, "abort"),
      error: protocolSentinel(fields, "error"),
      intentReady: protocolSentinel(fields, "intentReady"),
      ready: protocolSentinel(fields, "ready"),
      release: protocolSentinel(fields, "release"),
      released: protocolSentinel(fields, "released"),
      workerError: protocolSentinel(fields, "workerError"),
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
  return { argument, protocol };
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
