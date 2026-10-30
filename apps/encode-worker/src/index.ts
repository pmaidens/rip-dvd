import { runBrowserRenditionWorker } from "./browser-rendition-worker.js";
import { runDamagePreviewWorker } from "./damage-preview-worker.js";
import { randomUUID } from "node:crypto";

import { createDataAccess } from "@rip-dvd/data-access";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

import {
  createEncodePublicationMutationRecoveryLock,
  runEncodeWorker,
} from "./encode-worker.js";

await runConfiguredAsyncWorker(
  {
    readyMessage: (config) =>
      `Encode worker ready (concurrency: ${config.encodeWorkerConcurrency})`,
    workerName: "Encode",
  },
  async ({ config, log, signal }) => {
    const access = createDataAccess({
      databasePath: config.databasePath,
      originalsLibraryPath: config.originalsLibraryPath,
      publicationMutationRecoveryLock:
        createEncodePublicationMutationRecoveryLock(
          config.mediaLibraryPath,
        ),
    });
    const previewAccess = createDataAccess({ databasePath: config.databasePath, originalsLibraryPath: config.originalsLibraryPath });
    const renditionAccess = createDataAccess({ databasePath: config.databasePath, originalsLibraryPath: config.originalsLibraryPath });
    try {
      await Promise.all([runBrowserRenditionWorker({ access: renditionAccess, mediaLibraryPath: config.mediaLibraryPath, signal, pollIntervalMs: config.workerPollIntervalMs, log }), runDamagePreviewWorker({ access: previewAccess, originalsLibraryPath: config.originalsLibraryPath, mediaLibraryPath: config.mediaLibraryPath, signal, pollIntervalMs: config.workerPollIntervalMs, log }), runEncodeWorker({
        access,
        concurrency: config.encodeWorkerConcurrency,
        log,
        mediaLibraryPath: config.mediaLibraryPath,
        originalsLibraryPath: config.originalsLibraryPath,
        pollIntervalMs: config.workerPollIntervalMs,
        signal,
        workerId: `encode-worker:${process.pid}:${randomUUID()}`,
      })]);
    } finally {
      renditionAccess.close();
      previewAccess.close();
      access.close();
    }
  },
);
