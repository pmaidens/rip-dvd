import { randomUUID } from "node:crypto";

import { createDataAccess } from "@rip-dvd/data-access";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

import { runArchiveWorker } from "./archive-worker.js";
import { runArchiveAuditWorker } from "./archive-audit-worker.js";
import { createNodeDvdCopyRunner } from "./dvd-archiver.js";
import { createNodeDvdCompletenessProver } from "./dvd-completeness-prover.js";
import { createNodeDvdGeometryValidator } from "./dvd-geometry-validator.js";
import { createNodeDvdEndpointProver } from "./dvd-endpoint-prover.js";
import { createLinuxOpticalDriveHardware } from "./optical-drive-hardware.js";
import { runFilesystemVerificationWorker } from "./filesystem-verification-worker.js";
import { createNodeDvdSalvageValidator } from "./dvd-salvage-validator.js";

await runConfiguredAsyncWorker(
  {
    readyMessage: (config) =>
      `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
    workerName: "Archive",
  },
  async ({ config, log, signal }) => {
    const access = createDataAccess({
      databasePath: config.databasePath,
      mediaLibraryPath: config.mediaLibraryPath,
      originalsLibraryPath: config.originalsLibraryPath,
    });
    const copyRunner = createNodeDvdCopyRunner({
      maxActiveCopies: config.archiveWorkerConcurrency,
      stallTimeoutMs: config.archiveCopyStallTimeoutMs,
    });
    const workers = new AbortController();
    const stopWorkers = () => workers.abort(signal.reason);
    signal.addEventListener("abort", stopWorkers, { once: true });
    if (signal.aborted) stopWorkers();
    const stopOnFailure = async (work: Promise<void>): Promise<void> => {
      try {
        await work;
      } catch (error) {
        workers.abort(error);
        throw error;
      }
    };
    try {
      const results = await Promise.allSettled([stopOnFailure(runArchiveWorker({
        access,
        concurrency: config.archiveWorkerConcurrency,
        configuredDevicePath: config.archiveDevicePath,
        completenessProver: createNodeDvdCompletenessProver(),
        copyRunner,
        endpointProver: createNodeDvdEndpointProver({ copyRunner }),
        hardware: createLinuxOpticalDriveHardware(),
        geometryValidator: createNodeDvdGeometryValidator(),
        log,
        originalsLibraryPath: config.originalsLibraryPath,
        salvageValidator: createNodeDvdSalvageValidator(),
        pollIntervalMs: config.workerPollIntervalMs,
        signal: workers.signal,
        workerId: `archive-worker:${process.pid}:${randomUUID()}`,
      })), stopOnFailure(runFilesystemVerificationWorker({
        access,
        intervalMs: config.workerPollIntervalMs,
        log,
        signal: workers.signal,
      })), stopOnFailure(runArchiveAuditWorker({
        access,
        databasePath: config.databasePath,
        originalsLibraryPath: config.originalsLibraryPath,
        intervalMs: config.workerPollIntervalMs,
        log,
        signal: workers.signal,
      }))]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      workers.abort();
      signal.removeEventListener("abort", stopWorkers);
      access.close();
    }
  },
);
