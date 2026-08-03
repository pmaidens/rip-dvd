export const LEGACY_QUEUE_CUTOVER_PROTOCOL = {
  version: 1,
  indexes: {
    state: 0,
    release: 1,
    heartbeat: 2,
  },
  states: {
    starting: 0,
    intentReady: 1,
    ready: 2,
    released: 3,
    failed: 4,
  },
  sentinels: {
    abort: "supervisor-abort",
    error: "error",
    intentReady: "intent-ready",
    ready: "ready",
    release: "release",
    released: "released",
    workerError: "worker-error",
  },
} as const;

export const LEGACY_QUEUE_CUTOVER_PROTOCOL_ARGUMENT = [
  String(LEGACY_QUEUE_CUTOVER_PROTOCOL.version),
  ...Object.entries(LEGACY_QUEUE_CUTOVER_PROTOCOL.sentinels).map(
    ([name, value]) => `${name}=${value}`,
  ),
].join("|");

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
    "hold-cutover",
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
