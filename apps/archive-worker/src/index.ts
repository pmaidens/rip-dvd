import { randomUUID } from "node:crypto";

import { createDataAccess } from "@rip-dvd/data-access";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

import { runArchiveWorker } from "./archive-worker.js";
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
    try {
      await Promise.all([runArchiveWorker({
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
        signal,
        workerId: `archive-worker:${process.pid}:${randomUUID()}`,
      }), runFilesystemVerificationWorker({
        access,
        intervalMs: config.workerPollIntervalMs,
        log,
        signal,
      })]);
    } finally {
      access.close();
    }
  },
);
