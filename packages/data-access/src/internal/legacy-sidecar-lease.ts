import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { isPathWithinDirectory } from "./path-containment.js";
import {
  LEGACY_QUEUE_CUTOVER_PROTOCOL_ARGUMENT,
  LEGACY_QUEUE_CUTOVER_PROTOCOL,
  LEGACY_QUEUE_CUTOVER_WORKER,
} from "./legacy-queue-cutover-protocol.js";

const LEGACY_QUEUE_LOCK_POLL_MS = 10;
const LEGACY_QUEUE_WORKER_STALL_MS = 2_000;
const LEGACY_QUEUE_RELEASE_ACKNOWLEDGEMENT_MS = 1_000;
const LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS = 250;
const LEGACY_QUEUE_HELPER_STATE = LEGACY_QUEUE_CUTOVER_PROTOCOL.states;
const LEGACY_QUEUE_HELPER_STATE_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.state;
const LEGACY_QUEUE_HELPER_RELEASE_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.release;
const LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.heartbeat;
const LEGACY_QUEUE_SUPERVISOR_ABORT =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.sentinels.abort;

export function acquireLegacyQueueCutoverLock(
  originalsLibraryPath: string,
): () => void {
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const repositoryRoot = realpathSync(
    resolve(dirname(modulePath), "..", "..", "..", ".."),
  );
  const expectedHelperPath = resolve(
    repositoryRoot,
    "rip_dvd",
    "legacy_queue_lease.py",
  );
  let helperPath: string;
  try {
    const expectedHelperStat = lstatSync(expectedHelperPath);
    helperPath = realpathSync(expectedHelperPath);
    if (
      !expectedHelperStat.isFile() ||
      expectedHelperStat.isSymbolicLink() ||
      !isPathWithinDirectory(repositoryRoot, helperPath)
    ) {
      throw new Error("helper is not a trusted regular file");
    }
  } catch (error) {
    throw new Error(
      `Could not locate the trusted legacy queue lease helper: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const python = process.env.RIP_DVD_PYTHON?.trim() || "python3";
  const pythonProbe = spawnSync(python, ["--version"], { stdio: "ignore" });
  if (pythonProbe.status !== 0) {
    throw new Error(`Could not run the legacy queue lease helper with ${python}`);
  }
  const stateDirectory = mkdtempSync(join(tmpdir(), "rip-dvd-cutover-"));
  const statePath = (name: string) => join(stateDirectory, name);
  const helperState = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(LEGACY_QUEUE_CUTOVER_WORKER, {
    eval: true,
    workerData: {
      helperPath,
      originalsLibraryPath,
      pollMs: LEGACY_QUEUE_LOCK_POLL_MS,
      protocol: LEGACY_QUEUE_CUTOVER_PROTOCOL,
      protocolArgument: LEGACY_QUEUE_CUTOVER_PROTOCOL_ARGUMENT,
      python,
      sharedState: helperState.buffer,
      stateDirectory,
      terminationGraceMs: LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS,
    },
  });
  let workerFailure: string | undefined;
  worker.on("error", (error) => {
    workerFailure = `Legacy queue lease worker failed: ${error.message}`;
  });
  worker.on("exit", (code) => {
    if (code !== 0 && !workerFailure) {
      workerFailure = `Legacy queue lease worker exited with code ${code}`;
    }
  });
  const helperFailure = () => {
    if (workerFailure) {
      return workerFailure;
    }
    for (const name of ["worker-error", "error"]) {
      if (existsSync(statePath(name))) {
        try {
          return readFileSync(statePath(name), "utf8");
        } catch (error) {
          return `Could not read the legacy queue lease failure record: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }
    return "Legacy queue lease helper terminated unexpectedly";
  };
  const waitPhase = (expectedState: number): string => {
    if (expectedState === LEGACY_QUEUE_HELPER_STATE.intentReady) {
      return "intent acquisition";
    }
    if (expectedState === LEGACY_QUEUE_HELPER_STATE.ready) {
      return "queue drain";
    }
    return "release acknowledgement";
  };
  const waitForState = (
    expectedState: number,
    maximumWaitMilliseconds?: number,
  ): void => {
    const phaseStartedAt = process.hrtime.bigint();
    let heartbeat = Atomics.load(
      helperState,
      LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX,
    );
    let heartbeatObservedAt = process.hrtime.bigint();
    while (true) {
      const state = Atomics.load(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
      );
      if (state === LEGACY_QUEUE_HELPER_STATE.failed) {
        throw new Error(helperFailure());
      }
      if (state >= expectedState) {
        return;
      }
      if (
        maximumWaitMilliseconds !== undefined &&
        Number(process.hrtime.bigint() - phaseStartedAt) / 1_000_000 >=
          maximumWaitMilliseconds
      ) {
        throw new Error(
          `Legacy queue lease helper did not complete ${waitPhase(expectedState)} within ${maximumWaitMilliseconds}ms`,
        );
      }
      const currentHeartbeat = Atomics.load(
        helperState,
        LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX,
      );
      if (currentHeartbeat !== heartbeat) {
        heartbeat = currentHeartbeat;
        heartbeatObservedAt = process.hrtime.bigint();
      } else {
        const stalledForMilliseconds = Number(
          process.hrtime.bigint() - heartbeatObservedAt,
        ) / 1_000_000;
        if (stalledForMilliseconds >= LEGACY_QUEUE_WORKER_STALL_MS) {
          throw new Error(
            `Legacy queue lease worker stopped responding during ${waitPhase(expectedState)}`,
          );
        }
      }
      Atomics.wait(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
        state,
        LEGACY_QUEUE_LOCK_POLL_MS,
      );
    }
  };
  const stopUnresponsiveWorker = (): boolean => {
    for (const name of ["release", LEGACY_QUEUE_SUPERVISOR_ABORT]) {
      if (existsSync(statePath(name))) {
        continue;
      }
      try {
        writeFileSync(statePath(name), "", { flag: "wx", mode: 0o600 });
      } catch {
        // The helper may have concurrently published or consumed the state.
      }
    }
    Atomics.store(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX, 1);
    Atomics.notify(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX);
    const deadline =
      process.hrtime.bigint() +
      BigInt(LEGACY_QUEUE_WORKER_STALL_MS) * 1_000_000n;
    while (
      !existsSync(statePath("released")) &&
      process.hrtime.bigint() < deadline
    ) {
      Atomics.wait(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
        Atomics.load(helperState, LEGACY_QUEUE_HELPER_STATE_INDEX),
        LEGACY_QUEUE_LOCK_POLL_MS,
      );
    }
    const helperReleased = existsSync(statePath("released"));
    void worker.terminate();
    return helperReleased;
  };
  const cleanUpUnresponsiveWorker = (): void => {
    const helperReleased = stopUnresponsiveWorker();
    if (helperReleased) {
      rmSync(stateDirectory, { force: true, recursive: true });
      return;
    }
    const cleanupTimer = setInterval(() => {
      if (!existsSync(statePath("released"))) {
        return;
      }
      clearInterval(cleanupTimer);
      rmSync(stateDirectory, { force: true, recursive: true });
    }, LEGACY_QUEUE_LOCK_POLL_MS);
    cleanupTimer.unref();
  };
  const cleanUpResponsiveWorker = (): void => {
    void worker.terminate();
    rmSync(stateDirectory, { force: true, recursive: true });
  };

  try {
    waitForState(LEGACY_QUEUE_HELPER_STATE.intentReady);
    waitForState(LEGACY_QUEUE_HELPER_STATE.ready);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      Atomics.store(
        helperState,
        LEGACY_QUEUE_HELPER_RELEASE_INDEX,
        1,
      );
      Atomics.notify(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX);
      try {
        waitForState(
          LEGACY_QUEUE_HELPER_STATE.released,
          LEGACY_QUEUE_RELEASE_ACKNOWLEDGEMENT_MS,
        );
      } catch (error) {
        cleanUpUnresponsiveWorker();
        throw error;
      }
      cleanUpResponsiveWorker();
    };
  } catch (error) {
    cleanUpUnresponsiveWorker();
    throw error;
  }
}
