import { randomUUID } from "node:crypto";

import { createDataAccess } from "@rip-dvd/data-access";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

import { runArchiveWorker } from "./archive-worker.js";
import { nodeDvdCopyRunner } from "./dvd-archiver.js";
import { createLinuxOpticalDriveHardware } from "./optical-drive-hardware.js";

await runConfiguredAsyncWorker(
  {
    readyMessage: (config) =>
      `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
    workerName: "Archive",
  },
  async ({ config, log, signal }) => {
    const access = createDataAccess({ databasePath: config.databasePath });
    try {
      await runArchiveWorker({
        access,
        configuredDevicePath: config.archiveDevicePath,
        copyRunner: nodeDvdCopyRunner,
        hardware: createLinuxOpticalDriveHardware(),
        log,
        originalsLibraryPath: config.originalsLibraryPath,
        pollIntervalMs: config.workerPollIntervalMs,
        signal,
        workerId: `archive-worker:${process.pid}:${randomUUID()}`,
      });
    } finally {
      access.close();
    }
  },
);
