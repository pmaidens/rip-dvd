import { parentPort, workerData } from "node:worker_threads";

import { createDataAccess } from "../dist/index.js";

const barrier = new Int32Array(workerData.barrier);
let access;

try {
  if (workerData.mode === "claim") {
    access = createDataAccess({ databasePath: workerData.databasePath });
  }

  parentPort.postMessage({ type: "ready" });
  Atomics.wait(barrier, 0, 0);

  if (workerData.mode === "open") {
    access = createDataAccess({ databasePath: workerData.databasePath });
    const health = access.checkHealth();
    parentPort.postMessage({ type: "result", value: health.status });
  } else {
    const queue =
      workerData.queue === "archive"
        ? access.archiveJobs
        : access.encodeJobs;
    const claim = queue.claimNext(workerData.workerId);
    parentPort.postMessage({
      type: "result",
      value: claim
        ? { id: claim.id, claimToken: claim.claimToken }
        : null,
    });
  }
} catch (error) {
  parentPort.postMessage({
    type: "failure",
    value: error instanceof Error ? error.message : String(error),
  });
} finally {
  access?.close();
}
