import { parentPort, workerData } from "node:worker_threads";

import {
  createDataAccess,
  DomainInvariantError,
} from "../dist/index.js";

const barrier = new Int32Array(workerData.barrier);
let access;

try {
  if (workerData.mode !== "open") {
    access = createDataAccess({ databasePath: workerData.databasePath });
  }

  parentPort.postMessage({ type: "ready" });
  Atomics.wait(barrier, 0, 0);

  if (workerData.mode === "open") {
    access = createDataAccess({ databasePath: workerData.databasePath });
    const health = access.checkHealth();
    parentPort.postMessage({ type: "result", value: health.status });
  } else if (workerData.mode === "claim") {
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
  } else if (workerData.operation === "enqueue") {
    try {
      const job = access.archiveJobs.enqueue({
        detectedDiscId: workerData.detectedDiscId,
      });
      parentPort.postMessage({
        type: "result",
        value: { outcome: "enqueued", id: job.id },
      });
    } catch (error) {
      if (!(error instanceof DomainInvariantError)) {
        throw error;
      }
      parentPort.postMessage({
        type: "result",
        value: { outcome: "rejected" },
      });
    }
  } else if (workerData.operation === "reject") {
    const disc = access.catalog.updateDetectedDiscStatus(
      workerData.detectedDiscId,
      "rejected",
    );
    parentPort.postMessage({
      type: "result",
      value: { outcome: "rejected", id: disc.id },
    });
  } else if (workerData.operation === "archive") {
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: workerData.detectedDiscId,
      discKind: workerData.discKind,
      archiveFormat: "iso",
      archivePath: workerData.archivePath,
      fingerprint: workerData.fingerprint,
    });
    parentPort.postMessage({
      type: "result",
      value: { outcome: "archived", id: archive.id },
    });
  } else {
    throw new Error(`Unknown concurrency operation: ${workerData.operation}`);
  }
} catch (error) {
  parentPort.postMessage({
    type: "failure",
    value: error instanceof Error ? error.message : String(error),
  });
} finally {
  access?.close();
}
