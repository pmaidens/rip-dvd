import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

import {
  createOperatorWorkflowFixture,
} from "./operator-workflow.test-support.js";

let current: ReturnType<typeof createOperatorWorkflowFixture>;

beforeEach(() => {
  current = createOperatorWorkflowFixture();
});

afterEach(() => {
  vi.useRealTimers();
  current.dispose();
});

it("diagnoses and recovers a failed fresh preservation before reviewed adoption and replacement", async () => {
  const fingerprint = `dvdmeta-sha256:${"f".repeat(64)}`;
  const archiveBytes = Buffer.alloc(4_096, 17);
  const freshBytes = Buffer.alloc(4_096, 29);
  const sourcePath = join(current.originalsLibraryPath, "source-generation.iso");
  const outputPath = join(current.mediaLibraryPath, "synthetic-feature.mkv");
  const discoveredDrive = {
    devicePath: "/dev/synthetic-parity-drive",
    displayName: "Synthetic parity drive",
    serialNumber: "SYNTHETIC-PARITY-DRIVE",
  };
  const scanData = {
    schemaVersion: 2 as const,
    contentId: fingerprint,
    titles: [{
      number: 1,
      durationSeconds: 5_400,
      chapters: 12,
      audioStreams: [],
      subtitles: [],
    }],
  };

  writeFileSync(sourcePath, archiveBytes);
  const setup = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  const drive = setup.catalog.reconcileOpticalDrives([{
    ...discoveredDrive,
    isConfiguredDevice: true,
  }])[0]!;
  const disc = setup.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    scanData,
    sizeBytes: archiveBytes.byteLength,
    volumeLabel: "SYNTHETIC_PARITY_DISC",
  });
  setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  setup.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const sourceArchive = setup.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: sourcePath,
    fingerprint,
    sizeBytes: archiveBytes.byteLength,
  });
  const mediaItem = setup.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic parity feature",
  });
  const sourceSelection = setup.catalog.createDiscSelection({
    originalDiscArchiveId: sourceArchive.id,
    mediaItemId: mediaItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: "Feature",
  });
  setup.catalog.completeCatalogReview(
    sourceArchive.id,
    setup.catalog.listOriginalDiscArchives({ ids: [sourceArchive.id] })[0]!
      .updatedAt,
    "reviewed_with_selections",
  );
  setup.close();

  const createdProfile = await current.run([
    "create-encoding-profile",
    "--key",
    "synthetic-parity-profile-key",
    "--profile-key",
    "synthetic-parity",
    "--display-name",
    "Synthetic parity",
    "--preset",
    "Fast 480p30",
  ]);
  expect(createdProfile.exitCode).toBe(0);
  const profileId = (createdProfile.result as { profile: { id: string } })
    .profile.id;
  const queuedSource = await current.run([
    "encode-enqueue",
    "--key",
    "synthetic-parity-encode-key",
    "--disc-selection-id",
    sourceSelection.id,
    "--encoding-profile-id",
    profileId,
    "--output-path",
    outputPath,
  ]);
  expect(queuedSource.exitCode).toBe(0);
  const sourceEncodeJobId = (queuedSource.result as { job: { id: string } })
    .job.id;

  const requestArgs = [
    "request-rearchive",
    "--key",
    "synthetic-parity-rearchive-key",
    "--source-archive-id",
    sourceArchive.id,
  ];
  const submitted = await current.run(requestArgs);
  expect(submitted.exitCode).toBe(0);
  expect((await current.run(requestArgs)).result).toEqual(submitted.result);
  const requestId = (submitted.result as {
    archiveRequest: { id: string };
  }).archiveRequest.id;

  const workerModulePath = fileURLToPath(
    new URL("../../archive-worker/src/archive-worker.ts", import.meta.url),
  );
  const recoveryModulePath = fileURLToPath(
    new URL(
      "../../archive-worker/src/dvd-recovery-contracts.ts",
      import.meta.url,
    ),
  );
  const workspaceLockModulePath = fileURLToPath(
    new URL(
      "../../archive-worker/src/dvd-rescue-workspace-lock.ts",
      import.meta.url,
    ),
  );
  const { pollArchiveWorker } = await import(workerModulePath) as {
    pollArchiveWorker(options: Record<string, unknown>): Promise<void>;
  };
  const { createCleanDvdRecoveryResult } = await import(recoveryModulePath) as {
    createCleanDvdRecoveryResult(sizeBytes: number): unknown;
  };
  const { createInProcessDvdRescueWorkspaceLock } = await import(
    workspaceLockModulePath
  ) as {
    createInProcessDvdRescueWorkspaceLock(): unknown;
  };
  const rescueWorkspaceLock = createInProcessDvdRescueWorkspaceLock();
  const workerLogs: string[] = [];
  let copyAttempt = 0;
  const copyRunner = {
    async copy({
      onBytesCopied,
      outputPath: freshPath,
      sizeBytes,
    }: {
      onBytesCopied(bytes: number): void;
      outputPath: string;
      sizeBytes: number;
    }) {
      copyAttempt += 1;
      if (copyAttempt === 1) {
        throw new Error("Synthetic fresh preservation failure");
      }
      writeFileSync(freshPath, freshBytes);
      onBytesCopied(freshBytes.byteLength);
      return createCleanDvdRecoveryResult(sizeBytes);
    },
    isActive: () => false,
    withDeviceInactive: async (
      _devicePath: string,
      mutation: () => void | Promise<void>,
    ) => mutation(),
    waitForInactive: async () => undefined,
  };
  const hardware = {
    discover: async () => [discoveredDrive],
    bindOpticalDrive: async (candidate: typeof discoveredDrive) => ({
      deviceInstanceToken: "synthetic-parity-instance",
      drive: candidate,
    }),
    confirmOpticalDrive: async () => undefined,
    observeMedia: async () => ({
      mediaGeneration: "synthetic-parity-generation",
      capacityBytes: archiveBytes.byteLength,
    }),
    observeMediaGeneration: async () => "synthetic-parity-generation",
    scanDvd: async () => ({
      fingerprint,
      scanData,
      sizeBytes: archiveBytes.byteLength,
      volumeLabel: "SYNTHETIC_PARITY_DISC",
    }),
  };
  const endpointProver = {
    async prove({
      authorizeProbe,
      firstExcludedLba,
    }: {
      authorizeProbe(): Promise<void>;
      firstExcludedLba: number;
    }) {
      for (let index = 0; index < 4; index += 1) {
        await authorizeProbe();
      }
      return {
        proofVersion: "dvd-normal-endpoint-proof-v1" as const,
        confirmationCount: 2 as const,
        firstExcludedLba,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2" as const,
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x70,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      };
    },
  };
  const runWorker = async () => {
    const access = current.openAccess();
    try {
      await pollArchiveWorker({
        access,
        configuredDevicePath: discoveredDrive.devicePath,
        copyRunner,
        endpointProver,
        geometryValidator: { validate: async () => undefined },
        hardware,
        log: (message: string) => workerLogs.push(message),
        originalsLibraryPath: current.originalsLibraryPath,
        rescueWorkspaceLock,
        signal: new AbortController().signal,
        waitForNextSettlingObservation: async (intervalMs: number) => {
          vi.advanceTimersByTime(intervalMs);
        },
        workerId: "synthetic-parity-worker",
      });
    } finally {
      access.close();
    }
  };

  vi.useFakeTimers({ toFake: ["Date"] });
  await runWorker();
  const diagnosed = await current.run([
    "inspect",
    "archive-requests",
    requestId,
  ]);
  expect(diagnosed.result).toMatchObject({
    item: {
      status: "needs_attention",
      archiveJobs: [expect.objectContaining({
        status: "failed",
        attemptOrdinal: 1,
        errorMessage: expect.stringContaining(
          "Synthetic fresh preservation failure",
        ),
      })],
      availableActions: expect.arrayContaining([
        expect.objectContaining({ name: "retry", eligible: true }),
      ]),
    },
  });
  expect(readFileSync(sourcePath)).toEqual(archiveBytes);

  const retried = await current.run([
    "retry-archive-request",
    "--key",
    "synthetic-parity-retry-key",
    "--archive-request-id",
    requestId,
  ]);
  expect(retried.result).toEqual({
    archiveRequest: { id: requestId, status: "pending" },
  });
  await runWorker();
  vi.useRealTimers();

  const fulfilled = await current.run([
    "wait",
    "archive-requests",
    requestId,
    "--timeout-ms",
    "0",
  ]);
  expect(fulfilled.exitCode).toBe(0);
  expect(fulfilled.result, workerLogs.join("\n")).toMatchObject({
    outcome: "settled",
    current: {
      status: "fulfilled",
      archiveJobs: expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          attemptOrdinal: 2,
          originalDiscArchiveId: expect.any(String),
        }),
        expect.objectContaining({ status: "failed", attemptOrdinal: 1 }),
      ]),
    },
  });
  const completedJob = (fulfilled.result as {
    current: {
      archiveJobs: Array<{
        originalDiscArchiveId: string | null;
        status: string;
      }>;
    };
  }).current.archiveJobs.find(({ status }) => status === "completed")!;
  const targetArchiveId = completedJob.originalDiscArchiveId!;

  const review = await current.run([
    "catalog-review",
    "show",
    targetArchiveId,
  ]);
  const proposal = (review.result as {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
      mappings: Array<{
        sourceDiscSelectionId: string;
        proposedMapping: {
          label: string | null;
          mediaItemId: string;
          sourceIdentity: { kind: "dvd_title"; titleNumber: number };
        };
      }>;
    };
  }).rearchiveProposal;
  const proposalInput = {
    action: "save_rearchive_mapping_proposal",
    catalogRevision: proposal.catalogRevision,
    sourceCatalogRevision: proposal.sourceCatalogRevision,
    mappings: proposal.mappings.map((mapping) => ({
      sourceDiscSelectionId: mapping.sourceDiscSelectionId,
      ...mapping.proposedMapping,
    })),
  };
  const saved = await current.run([
    "catalog-review",
    "save-rearchive-proposal",
    targetArchiveId,
    "--key",
    "synthetic-parity-proposal-key",
    "--json",
    JSON.stringify(proposalInput),
  ]);
  expect(saved.exitCode).toBe(0);
  const savedProposal = (saved.result as {
    proposal: { catalogRevision: string; sourceCatalogRevision: string };
  }).proposal;

  const acceptanceInput = {
    action: "accept_rearchive",
    catalogRevision: savedProposal.catalogRevision,
    sourceCatalogRevision: savedProposal.sourceCatalogRevision,
    replacementEncodes: [{
      predecessorEncodeJobId: sourceEncodeJobId,
      encodingProfileId: profileId,
      outputPath,
    }],
  };
  const preview = await current.run([
    "catalog-review",
    "preview-rearchive-acceptance",
    targetArchiveId,
    "--json",
    JSON.stringify(acceptanceInput),
  ]);
  expect(preview.result).toMatchObject({
    state: "available",
    sourceArchiveId: sourceArchive.id,
    targetArchiveId,
    affectedEncodeJobs: [{ id: sourceEncodeJobId, status: "queued" }],
    consequences: {
      replacementEncodeCount: 1,
      replacementEncodes: [{ predecessorEncodeJobId: sourceEncodeJobId }],
    },
  });
  const previewResult = preview.result as {
    catalogRevision: string;
    previewToken: string;
    sourceCatalogRevision: string;
  };
  const acceptanceArgs = [
    "catalog-review",
    "accept-rearchive",
    targetArchiveId,
    "--key",
    "synthetic-parity-acceptance-key",
    "--revision",
    previewResult.catalogRevision,
    "--source-revision",
    previewResult.sourceCatalogRevision,
    "--preview-token",
    previewResult.previewToken,
    "--acknowledge",
    "--json",
    JSON.stringify(acceptanceInput),
  ];
  const accepted = await current.run(acceptanceArgs);
  expect(accepted.exitCode).toBe(0);
  expect((await current.run(acceptanceArgs)).result).toEqual(accepted.result);
  expect(accepted.result).toMatchObject({
    message: "Re-archive accepted",
    affectedEncodeJobs: [{ id: sourceEncodeJobId, status: "cancelled" }],
    replacementEncodeJobs: [{
      predecessorEncodeJobId: sourceEncodeJobId,
      status: "queued",
    }],
    targetArchive: {
      id: targetArchiveId,
      catalogReviewOutcome: "reviewed_with_selections",
    },
  });

  expect((await current.run([
    "inspect",
    "original-disc-archives",
    sourceArchive.id,
  ])).result).toMatchObject({
    item: {
      id: sourceArchive.id,
      lineage: {
        newArchives: [expect.objectContaining({ id: targetArchiveId })],
      },
      references: {
        discSelections: [expect.objectContaining({
          id: sourceSelection.id,
          catalogStatus: "historical",
        })],
        encodeJobs: [expect.objectContaining({
          id: sourceEncodeJobId,
          status: "cancelled",
        })],
      },
    },
  });
  expect(readFileSync(sourcePath)).toEqual(archiveBytes);
});
