import { parentPort, workerData } from "node:worker_threads";
import { claimNextEncodeJob } from "../../../packages/application/dist/index.js";
import { createDataAccessInternal } from "../../../packages/data-access/dist/internal/create-data-access.js";
import { createLegacySidecarImportAccess } from "../../../packages/data-access/dist/internal/legacy-sidecar-migration.js";

const { role, order, barrier, input, ...config } = workerData;
const access = createDataAccessInternal(config, { createAccess: createLegacySidecarImportAccess },
  { allowDvdRecoveryEvidenceEncodingForExclusionTest: true });
const gate = new Int32Array(barrier);
const hold = () => {
  parentPort.postMessage({ type: "held" });
  if (Atomics.wait(gate, 0, 0, 10_000) === "timed-out") throw new Error("Claim concurrency barrier timed out");
};
try {
  if (role === "withdraw") {
    parentPort.postMessage({ type: "attempt" });
    const withdrawn = access.catalog.withdrawDvdTitleDamageAcceptance(input);
    parentPort.postMessage({ type: "result", value: { outcome: withdrawn.decision } });
  } else {
    const claimNext = access.encodeJobs.claimNext;
    access.encodeJobs.claimNext = (id, options) => {
      if (order === "withdraw-first") hold();
      return claimNext(id, { ...options, snapshotSource(job) {
        const source = options.snapshotSource(job);
        if (order === "claim-first") hold();
        return source;
      } });
    };
    const claim = await claimNextEncodeJob(access, "synthetic-racing-worker", config.originalsLibraryPath);
    parentPort.postMessage({ type: "result", value: { outcome: claim === null ? "unclaimed" : "running", claimToken: claim?.claimToken } });
  }
} catch (error) {
  parentPort.postMessage({ type: "result", value: { outcome: "error", code: error.code ?? error.message } });
} finally { access.close(); }
