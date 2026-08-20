import { randomUUID } from "node:crypto";

import { createDataAccess } from "@rip-dvd/data-access";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

import { runArchiveWorker } from "./archive-worker.js";
import { createNodeDvdCopyRunner } from "./dvd-archiver.js";
import { createLinuxOpticalDriveHardware } from "./optical-drive-hardware.js";
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
      originalsLibraryPath: config.originalsLibraryPath,
    });
    try {
      await runArchiveWorker({
        access,
        concurrency: config.archiveWorkerConcurrency,
        configuredDevicePath: config.archiveDevicePath,
        copyRunner: createNodeDvdCopyRunner({
          maxActiveCopies: config.archiveWorkerConcurrency,
          stallTimeoutMs: config.archiveCopyStallTimeoutMs,
        }),
        hardware: createLinuxOpticalDriveHardware(),
        log,
        originalsLibraryPath: config.originalsLibraryPath,
        salvageValidator: createNodeDvdSalvageValidator(),
        pollIntervalMs: config.workerPollIntervalMs,
        signal,
        workerId: `archive-worker:${process.pid}:${randomUUID()}`,
      });
    } finally {
      access.close();
    }
  },
);
