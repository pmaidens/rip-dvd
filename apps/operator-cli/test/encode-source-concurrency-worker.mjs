import { parentPort, workerData } from "node:worker_threads";
import { createApplicationOperations } from "../../../packages/application/dist/index.js";
import { createDataAccessInternal } from "../../../packages/data-access/dist/internal/create-data-access.js";
import { createLegacySidecarImportAccess } from "../../../packages/data-access/dist/internal/legacy-sidecar-migration.js";

const { databasePath, mediaLibraryPath, originalsLibraryPath, role, order, operation, barrier, input } = workerData;
const access = createDataAccessInternal({ databasePath, mediaLibraryPath, originalsLibraryPath },
  { createAccess: createLegacySidecarImportAccess }, { allowDvdRecoveryEvidenceEncodingForExclusionTest: true });
const gate = new Int32Array(barrier);
try {
  if (role === "resume") {
    parentPort.postMessage({ type: "attempt" });
    const result = access.archiveRecoveryWork.requestResume(input);
    parentPort.postMessage({ type: "result", value: { outcome: "resumed", id: result.id } });
  } else {
    const hold = () => {
      parentPort.postMessage({ type: "held" });
      if (Atomics.wait(gate, 0, 0, 10_000) === "timed-out") throw new Error("Concurrency barrier timed out");
    };
    if (operation === "enqueue") {
      const enqueue = access.encodeJobs.enqueue;
      access.encodeJobs.enqueue = (value, assert) => {
        if (order === "resume-first") hold();
        return enqueue(value, () => {
          assert();
          if (order === "encode-first") hold();
        });
      };
    } else {
      const requeue = access.encodeJobs.requeue;
      access.encodeJobs.requeue = (id, options) => {
        if (order === "resume-first") hold();
        return requeue(id, { ...options, assertSourceDecision() {
          options.assertSourceDecision();
          if (order === "encode-first") hold();
        } });
      };
    }
    const operations = createApplicationOperations(access);
    const result = await (operation === "enqueue"
      ? operations.enqueueEncodeJob({ ...input, mediaLibraryPath, originalsLibraryPath })
      : operations.requeueEncodeJob({ ...input, mediaLibraryPath, originalsLibraryPath }));
    parentPort.postMessage({ type: "result", value: { outcome: "queued", id: result.id } });
  }
} catch (error) {
  parentPort.postMessage({ type: "result", value: { outcome: "rejected", code: error.code ?? error.name,
    reasons: error.blockingReasons?.map(({ code }) => code) ?? [] } });
} finally { access.close(); }
