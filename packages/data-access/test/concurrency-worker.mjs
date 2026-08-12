import { parentPort, workerData } from "node:worker_threads";

import {
  createDataAccess,
  DomainInvariantError,
  InvalidStatusTransitionError,
} from "../dist/index.js";
import { createLegacySidecarDataAccess } from "../dist/legacy-sidecars.js";

const barrier = new Int32Array(workerData.barrier);
let access;

try {
  if (workerData.mode !== "open") {
    access = createLegacySidecarDataAccess({
      databasePath: workerData.databasePath,
    });
  }

  parentPort.postMessage({ type: "ready" });
  Atomics.wait(barrier, 0, 0);
  parentPort.postMessage({ type: "operation-started" });

  if (workerData.mode === "open") {
    access = createDataAccess({ databasePath: workerData.databasePath });
    const health = access.checkHealth();
    parentPort.postMessage({ type: "result", value: health.status });
  } else if (workerData.operation === "start-archive") {
    const job = access.archiveJobs.startForInspection(
      workerData.discInspectionId,
      workerData.workerId,
    );
    parentPort.postMessage({
      type: "result",
      value: job
        ? { outcome: "started", id: job.id }
        : { outcome: "skipped" },
    });
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
  } else if (workerData.operation === "create-profile-version") {
    const profile = access.encodingProfiles.createVersion({
      sourceProfileId: workerData.sourceProfileId,
      mediaDomain: "dvd_video",
      settings: { preset: workerData.preset, container: "mkv" },
    });
    parentPort.postMessage({
      type: "result",
      value: { outcome: "versioned", id: profile.id, version: profile.version },
    });
  } else if (workerData.operation === "activate-profile-version") {
    const profile = access.encodingProfiles.setActive({
      id: workerData.id,
      mediaDomain: "dvd_video",
      isActive: true,
    });
    parentPort.postMessage({
      type: "result",
      value: { outcome: "activated", id: profile.id },
    });
  } else if (workerData.operation === "enqueue-encode") {
    try {
      const job = access.encodeJobs.enqueue({
        discSelectionId: workerData.discSelectionId,
        encodingProfileId: workerData.encodingProfileId,
        outputPath: workerData.outputPath,
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
  } else if (workerData.operation === "cancel-encode") {
    try {
      const job = access.encodeJobs.cancelQueued(workerData.encodeJobId);
      parentPort.postMessage({
        type: "result",
        value: { outcome: "cancelled", id: job.id },
      });
    } catch (error) {
      if (!(error instanceof InvalidStatusTransitionError)) {
        throw error;
      }
      parentPort.postMessage({
        type: "result",
        value: { outcome: "rejected" },
      });
    }
  } else if (workerData.operation === "claim-encode") {
    const claim = access.encodeJobs.claimNext(workerData.workerId);
    parentPort.postMessage({
      type: "result",
      value: claim
        ? { outcome: "claimed", id: claim.id }
        : { outcome: "rejected" },
    });
  } else if (workerData.operation === "complete-catalog-review") {
    try {
      const archive = access.catalog.completeCatalogReview(
        workerData.originalDiscArchiveId,
        workerData.catalogRevision,
      );
      parentPort.postMessage({
        type: "result",
        value: { outcome: "reviewed", id: archive.id },
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
  } else if (workerData.operation === "create-media-item") {
    try {
      const item = access.catalog.createMediaItem({
        parentId: workerData.parentId,
        kind: "bonus_feature",
        title: workerData.title,
      });
      parentPort.postMessage({
        type: "result",
        value: { outcome: "created", id: item.id },
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
