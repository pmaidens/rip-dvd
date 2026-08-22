import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  type DiscoveredOpticalDrive,
  type DvdSalvageRejectionReason,
} from "@rip-dvd/data-access";
import { createRawDvdContentIdHasher } from "@rip-dvd/data-access/dvd-content-id";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker as pollArchiveWorkerWithDefaults,
  runArchiveWorker as runArchiveWorkerWithDefaults,
  type PollArchiveWorkerOptions,
  type RunArchiveWorkerOptions,
  type OpticalDriveHardware,
} from "./archive-worker.js";
import type { DvdCopyRunner } from "./dvd-archiver.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";
import {
  createInProcessDvdRescueWorkspaceLock,
  type DvdRescueWorkspaceLock,
} from "./dvd-rescue-workspace-lock.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import {
  createLinuxOpticalDriveHardware,
  type CommandRunner,
} from "./optical-drive-hardware.js";

const temporaryDirectories: string[] = [];
const testRescueWorkspaceLock = createInProcessDvdRescueWorkspaceLock();

function pollArchiveWorkerOnce(options: PollArchiveWorkerOptions): Promise<void> {
  return pollArchiveWorkerWithDefaults({
    ...options,
    rescueWorkspaceLock:
      options.rescueWorkspaceLock ?? testRescueWorkspaceLock,
  });
}

async function pollArchiveWorker(options: PollArchiveWorkerOptions): Promise<void> {
  const alreadyUsingFakeTimers = vi.isFakeTimers();
  if (!alreadyUsingFakeTimers) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  try {
    await pollArchiveWorkerOnce(options);
    for (const elapsedMs of [2_500, 5_000]) {
      const isSettling = options.access.discInspections
        .list({ currentOnly: true })
        .some((inspection) =>
          inspection.status === "running" && inspection.phase === "settling"
        );
      if (!isSettling) {
        return;
      }
      vi.setSystemTime(new Date(firstObservationAt + elapsedMs));
      await pollArchiveWorkerOnce(options);
    }
  } finally {
    if (!alreadyUsingFakeTimers) {
      vi.useRealTimers();
    }
  }
}

function runArchiveWorker(options: RunArchiveWorkerOptions): Promise<void> {
  return runArchiveWorkerWithDefaults({
    ...options,
    rescueWorkspaceLock:
      options.rescueWorkspaceLock ?? testRescueWorkspaceLock,
  });
}

const salvageFailureCases: readonly ({
  description: string;
  name: string;
  reason: DvdSalvageRejectionReason;
} | {
  errorMessage: string;
  name: string;
})[] = [
  ...(Object.keys(
    DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  ) as DvdSalvageRejectionReason[]).map((reason) => ({
    description: DVD_SALVAGE_REJECTION_DESCRIPTIONS[reason],
    name: reason,
    reason,
  })),
  {
    name: "decoder timeout",
    errorMessage: "DVD title playback validation failed",
  },
  {
    name: "decoder crash",
    errorMessage: "DVD title playback validation failed",
  },
];

function openTestDataAccess() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-worker-"));
  temporaryDirectories.push(directory);
  return createLegacySidecarDataAccess({
    databasePath: join(directory, "rip-dvd.sqlite"),
  });
}

function stableDeviceBinding() {
  return {
    bindOpticalDrive: vi.fn(
      async (drive: DiscoveredOpticalDrive, signal: AbortSignal) => {
        signal.throwIfAborted();
        return { deviceInstanceToken: "test-device-instance", drive };
      },
    ),
    confirmOpticalDrive: vi.fn(
      async (_binding: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
      },
    ),
    observeMedia: vi.fn(async () => ({
      mediaGeneration: "test-media-generation",
      capacityBytes: 2_048,
    })),
    observeMediaGeneration: vi.fn(async () => "test-media-generation"),
  };
}

function beginSettledDiscInspection(
  access: ReturnType<typeof openTestDataAccess>,
  input: Parameters<
    ReturnType<typeof openTestDataAccess>["discInspections"]["beginOrResume"]
  >[0],
) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 2_500));
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 5_000));
  const settled = access.discInspections.beginOrResume(input);
  if (settled.claim === null) {
    throw new Error("Expected a settled Disc Inspection claim");
  }
  return settled;
}

function beginNearlySettledDiscInspection(
  access: ReturnType<typeof openTestDataAccess>,
  input: Parameters<
    ReturnType<typeof openTestDataAccess>["discInspections"]["beginOrResume"]
  >[0],
) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 2_500));
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 5_000));
}

async function exerciseWatchabilityWorkerScenario({
  beforePoll,
  ranges,
  titleCount = 1,
  validation,
}: {
  beforePoll?: (
    access: ReturnType<typeof openTestDataAccess>,
    originalsLibraryPath: string,
    fingerprint: string,
  ) => void;
  ranges: readonly { sectorCount: number; startLba: number }[];
  titleCount?: number;
  validation:
    | {
      badSectorCountsByTitle: readonly {
        badSectorCount: number;
        titleNumber: number;
      }[];
      outcome: "accepted";
    }
    | { outcome: "rejected"; reason: DvdSalvageRejectionReason };
}) {
  const access = openTestDataAccess();
  const originalsLibraryPath = mkdtempSync(
    join(tmpdir(), "rip-dvd-originals-policy-integration-"),
  );
  temporaryDirectories.push(originalsLibraryPath);
  const fingerprint = `dvdmeta-sha256:${"9".repeat(64)}`;
  const scanData = {
    schemaVersion: 2 as const,
    contentId: fingerprint,
    titles: Array.from({ length: titleCount }, (_, index) => ({
      number: index + 1,
      durationSeconds: 3_600,
      chapters: 10,
      audioStreams: [],
      subtitles: [],
    })),
  };
  const discoveredDrive = {
    devicePath: "/dev/sr0",
    displayName: "Policy integration drive",
    vendor: "Pioneer",
    product: "DVD-RW",
    serialNumber: "ARCHIVE-POLICY-INTEGRATION-001",
  };
  const drive = access.catalog.reconcileOpticalDrives([
    { ...discoveredDrive, isConfiguredDevice: true },
  ])[0]!;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    scanData,
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const request = access.archiveRequests.create({ detectedDiscId: disc.id });
  const highestEndLba = ranges.reduce(
    (highest, range) =>
      Math.max(highest, range.startLba + range.sectorCount),
    0,
  );
  const sizeBytes = Math.max(4, highestEndLba + 1) * 2_048;
  const rescuedImage = Buffer.alloc(sizeBytes, 5);
  for (const range of ranges) {
    rescuedImage.fill(
      0,
      range.startLba * 2_048,
      (range.startLba + range.sectorCount) * 2_048,
    );
  }
  let rescuedPartialPath: string | undefined;
  const copyRunner: DvdCopyRunner = {
    copy: vi.fn(async ({ outputPath }) => {
      rescuedPartialPath = outputPath;
      writeFileSync(outputPath, rescuedImage);
      return createDamagedDvdRecoveryResult(sizeBytes, ranges);
    }),
    isActive: () => false,
    withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
    waitForInactive: vi.fn(async () => undefined),
  };
  const salvageValidator = { validate: vi.fn().mockResolvedValue(validation) };
  beforePoll?.(access, originalsLibraryPath, fingerprint);

  await pollArchiveWorker({
    access,
    configuredDevicePath: "/dev/sr0",
    copyRunner,
    hardware: {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes,
      }),
    },
    log: vi.fn(),
    originalsLibraryPath,
    salvageValidator,
    signal: new AbortController().signal,
    workerId: "archive-worker-policy-integration-test",
  });

  return {
    access,
    drive,
    fingerprint,
    originalsLibraryPath,
    request,
    rescuedImage,
    rescuedPartialPath,
    scanData,
    salvageValidator,
    sizeBytes,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("archive worker polling", () => {
  it("persists metadata findings without hashing the full disc", async () => {
    const access = openTestDataAccess();
    const fingerprint = `sha256:${"7".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 600,
        chapters: 4,
        audioStreams: [{ id: 128, language: "English", format: "ac3", channels: 2 }],
        subtitles: [],
      }],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "INSPECTION-PROGRESS-001",
    };
    const observedAfterMetadata: unknown[] = [];
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn(async (_binding, _signal, options) => {
        options?.onPhase?.("reading_metadata");
        options?.onMetadata?.({
          audioStreamCount: 1,
          chapterCount: 4,
          subtitleStreamCount: 0,
          titleCount: 1,
          totalBytes: 1_000,
          volumeLabel: "PROGRESS_DISC",
        });
        observedAfterMetadata.push(
          access.discInspections.list({ currentOnly: true })[0],
        );
        options?.onPhase?.("confirming_media");
        return { fingerprint, scanData, sizeBytes: 1_000, volumeLabel: "PROGRESS_DISC" };
      }),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(observedAfterMetadata).toEqual([
      expect.objectContaining({
        phase: "confirming_media",
        volumeLabel: "PROGRESS_DISC",
        titleCount: 1,
        bytesHashed: null,
        status: "running",
      }),
    ]);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        bytesHashed: null,
        detectedDiscId: expect.any(String),
        status: "completed",
      }),
    ]);
  });

  it("aborts without consuming retry budget when the medium changes after metadata", async () => {
    const access = openTestDataAccess();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "HASH-REMOVAL-001",
    };
    const observeMediaGeneration = vi
      .fn()
      .mockResolvedValueOnce("insertion-a")
      .mockResolvedValue("insertion-b");
    const scanDvd = vi.fn(async (_binding, _signal, options) => {
      options?.onPhase?.("reading_metadata");
      options?.onMetadata?.({
        audioStreamCount: 0,
        chapterCount: 1,
        subtitleStreamCount: 0,
        titleCount: 1,
        totalBytes: 1_000,
        volumeLabel: "REMOVED_AFTER_METADATA",
      });
      throw new Error("DVD medium changed after metadata");
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        observeMediaGeneration,
        scanDvd,
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(observeMediaGeneration).toHaveBeenCalledTimes(1);
    const abortedInspections = access.discInspections.list();
    expect(abortedInspections).toEqual([
      expect.objectContaining({
        status: "aborted",
        reasonCode: "media_changed",
        consecutiveFailureCount: 0,
        retryAt: null,
      }),
    ]);
    expect(access.discInspections.listAttempts(
      abortedInspections[0]!.id,
    )).toEqual([
      expect.objectContaining({
        outcome: "aborted",
        reasonCode: "media_changed",
      }),
    ]);
  });

  it.each([
    ["reading metadata", "metadata_read_failed"],
    ["acquiring content size", "content_size_failed"],
    ["confirming media", "drive_not_ready"],
  ] as const)(
    "aborts without retrying when the medium changes while %s",
    async (boundary, reasonCode) => {
      const access = openTestDataAccess();
      const discoveredDrive = {
        devicePath: "/dev/sr0",
        serialNumber: `PHASE-REMOVAL-${reasonCode}`,
      };
      const observeMediaGeneration = vi
        .fn()
        .mockResolvedValueOnce("insertion-a")
        .mockResolvedValue("insertion-b");
      const scanDvd = vi.fn(async (_binding, _signal, options) => {
        options?.onPhase?.("reading_metadata");
        if (boundary === "confirming media") {
          options?.onMetadata?.({
            audioStreamCount: 0,
            chapterCount: 1,
            subtitleStreamCount: 0,
            titleCount: 1,
            totalBytes: 1_000,
            volumeLabel: "REMOVED_DISC",
          });
          options?.onPhase?.("confirming_media");
        }
        throw new DiscInspectionError(
          "retry",
          reasonCode,
          `DVD medium disappeared while ${boundary}`,
        );
      });

      await pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockResolvedValue([discoveredDrive]),
          observeMediaGeneration,
          scanDvd,
        },
        log: vi.fn(),
        signal: new AbortController().signal,
      });

      expect(observeMediaGeneration).toHaveBeenCalledTimes(1);
      const [inspection] = access.discInspections.list();
      expect(inspection).toMatchObject({
        status: "aborted",
        reasonCode: "media_changed",
        consecutiveFailureCount: 0,
        retryAt: null,
        ...(boundary === "confirming media"
          ? { phase: "confirming_media", bytesHashed: null }
          : { phase: "reading_metadata" }),
      });
      expect(access.discInspections.listAttempts(inspection!.id)).toEqual([
        expect.objectContaining({
          outcome: "aborted",
          reasonCode: "media_changed",
        }),
      ]);
    },
  );

  it("matches requested work, streams progress, and publishes the archive atomically", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint =
      "sha256:e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 5_711,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    let scanCount = 0;
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockImplementation(async () => {
        scanCount += 1;
        if (scanCount === 1) {
          expect(access.archiveJobs.list()).toEqual([]);
        }
        return {
          fingerprint,
          scanData,
          sizeBytes: 9,
          volumeLabel: "EXAMPLE_DISC",
        };
      }),
    };
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        onBytesCopied(4);
        writeFileSync(outputPath, "dvd-image");
        onBytesCopied(9);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: "archive-worker-test",
    });

    const completed = access.archiveJobs.list(["completed"]);
    expect(completed).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        status: "completed",
        progressPhase: "finalizing",
        progressPercent: 100,
        originalDiscArchiveId: expect.any(String),
      }),
    ]);
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      detectedDiscId: disc.id,
      fingerprint,
      sizeBytes: 9,
      integrity: "clean_read",
      integrityPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(readFileSync(archive.archivePath, "utf8")).toBe("dvd-image");
    expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
  });

  it.each(salvageFailureCases)(
    "retains a rescued image after $name",
    async (failureCase) => {
      const access = openTestDataAccess();
      const originalsLibraryPath = mkdtempSync(
        join(tmpdir(), "rip-dvd-originals-rescue-"),
      );
      temporaryDirectories.push(originalsLibraryPath);
      const fingerprint = `dvdmeta-sha256:${"7".repeat(64)}`;
      const scanData = {
        schemaVersion: 2 as const,
        contentId: fingerprint,
        titles: [
          {
            number: 1,
            durationSeconds: 3_600,
            chapters: 10,
            audioStreams: [],
            subtitles: [],
          },
        ],
      };
      const discoveredDrive = {
        devicePath: "/dev/sr0",
        displayName: "Rescue drive",
        vendor: "Pioneer",
        product: "DVD-RW",
        serialNumber: "ARCHIVE-RESCUE-001",
      };
      const drive = access.catalog.reconcileOpticalDrives([
        { ...discoveredDrive, isConfiguredDevice: true },
      ])[0]!;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        scanData,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const request = access.archiveRequests.create({
        detectedDiscId: disc.id,
      });
      const sizeBytes = 4 * 2_048;
      const rescuedImage = Buffer.alloc(sizeBytes, 5);
      rescuedImage.fill(0, 2_048, 4_096);
      let rescuedPartialPath: string | undefined;
      const copyRunner: DvdCopyRunner = {
        copy: vi.fn(async ({ outputPath }) => {
          rescuedPartialPath = outputPath;
          writeFileSync(outputPath, rescuedImage);
          return createDamagedDvdRecoveryResult(sizeBytes, [
            { startLba: 1, sectorCount: 1 },
          ]);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      };

      await pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        copyRunner,
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockResolvedValue([discoveredDrive]),
          scanDvd: vi.fn().mockResolvedValue({
            fingerprint,
            scanData,
            sizeBytes,
          }),
        },
        log: vi.fn(),
        originalsLibraryPath,
        salvageValidator: {
          validate: vi.fn(async () => {
            if (!("reason" in failureCase)) {
              throw new Error(failureCase.errorMessage);
            }
            return {
              outcome: "rejected" as const,
              reason: failureCase.reason,
            };
          }),
        },
        signal: new AbortController().signal,
        workerId: "archive-worker-rescue-test",
      });

      const failure = access.archiveJobs.list(["failed"])[0]!;
      const expectedErrorMessage = "reason" in failureCase
        ? `DVD salvage rejected: unreadable sectors affect ${failureCase.description}; 1 sector in 1 area; LBAs 1`
        : failureCase.errorMessage;
      expect(failure).toMatchObject({
        archiveRequestId: request.id,
        status: "failed",
        progressPhase: "verifying",
        progressPercent: 99,
        errorMessage: expectedErrorMessage,
        originalDiscArchiveId: null,
      });
      expect(failure.errorMessage).not.toContain(originalsLibraryPath);
      expect(failure.errorMessage).not.toContain(discoveredDrive.devicePath);
      expect(access.archiveRequests.list(["needs_attention"])).toEqual([
        expect.objectContaining({ id: request.id }),
      ]);
      expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
      const rescuePaths = dvdRescueWorkspacePaths(
        realpathSync(originalsLibraryPath),
        request.id,
      );
      expect(existsSync(rescuedPartialPath!)).toBe(false);
      expect(existsSync(`${rescuedPartialPath}.failed`)).toBe(false);
      expect(readFileSync(rescuePaths.imagePath)).toEqual(rescuedImage);
      expect(existsSync(rescuePaths.mapPath)).toBe(true);
    },
  );

  it("publishes rescued damage that validation proves is unused space", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-unused-salvage-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"8".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Salvage drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-SALVAGE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const sizeBytes = 4 * 2_048;
    const rescuedImage = Buffer.alloc(sizeBytes, 5);
    rescuedImage.fill(0, 2_048, 4_096);
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, rescuedImage);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [],
          outcome: "accepted",
        }),
      },
      signal: new AbortController().signal,
      workerId: "archive-worker-unused-salvage-test",
    });

    expect(access.archiveJobs.list(["completed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        status: "completed",
        progressPhase: "finalizing",
        progressPercent: 100,
        originalDiscArchiveId: expect.any(String),
      }),
    ]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      detectedDiscId: disc.id,
      integrity: "watchable_salvage",
      integrityPolicyVersion: "dvd-watchable-salvage-v2",
      badSectorCount: 1,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 1, sectorCount: 1 }],
      badSectorCountsByTitle: [],
    });
    expect(readFileSync(archive.archivePath)).toEqual(rescuedImage);
    expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it.each([
    {
      name: "a one-sector bad run",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted" as const,
      },
    },
    {
      name: "a two-sector bad run",
      ranges: [{ startLba: 1, sectorCount: 2 }],
      validation: {
        outcome: "rejected" as const,
        reason: "consecutive_damage" as const,
      },
    },
    {
      name: "16 bad sectors in one title",
      ranges: Array.from({ length: 16 }, (_, index) => ({
        startLba: index * 2 + 1,
        sectorCount: 1,
      })),
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 16, titleNumber: 1 }],
        outcome: "accepted" as const,
      },
    },
    {
      name: "17 bad sectors in one title",
      ranges: Array.from({ length: 17 }, (_, index) => ({
        startLba: index * 2 + 1,
        sectorCount: 1,
      })),
      validation: {
        outcome: "rejected" as const,
        reason: "policy_limit" as const,
      },
    },
    {
      name: "32 bad sectors across the disc",
      ranges: Array.from({ length: 32 }, (_, index) => ({
        startLba: index * 2 + 1,
        sectorCount: 1,
      })),
      validation: {
        badSectorCountsByTitle: [],
        outcome: "accepted" as const,
      },
    },
    {
      name: "33 bad sectors across the disc",
      ranges: Array.from({ length: 33 }, (_, index) => ({
        startLba: index * 2 + 1,
        sectorCount: 1,
      })),
      validation: {
        outcome: "rejected" as const,
        reason: "policy_limit" as const,
      },
    },
    {
      name: "a shared VOB referenced by two titles",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      titleCount: 2,
      validation: {
        badSectorCountsByTitle: [
          { badSectorCount: 1, titleNumber: 1 },
          { badSectorCount: 1, titleNumber: 2 },
        ],
        outcome: "accepted" as const,
      },
    },
    {
      name: "combined unused-space and payload damage",
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 3, sectorCount: 1 },
        { startLba: 5, sectorCount: 1 },
      ],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 2, titleNumber: 1 }],
        outcome: "accepted" as const,
      },
    },
    {
      name: "an indeterminate DVD layout",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        outcome: "rejected" as const,
        reason: "ambiguous" as const,
      },
    },
    {
      name: "a decoder exactly one second short",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted" as const,
      },
    },
    {
      name: "a decoder more than one second short",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        outcome: "rejected" as const,
        reason: "decoder_duration" as const,
      },
    },
    {
      name: "a decoder at the 0.0001 failure-rate limit",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted" as const,
      },
    },
    {
      name: "a decoder above the 0.0001 failure-rate limit",
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        outcome: "rejected" as const,
        reason: "decoder_rate" as const,
      },
    },
  ])(
    "drives an Archive Job through the complete policy for $name",
    async ({ ranges, titleCount, validation }) => {
      const scenario = await exerciseWatchabilityWorkerScenario({
        ranges,
        titleCount,
        validation,
      });

      expect(scenario.salvageValidator.validate).toHaveBeenCalledOnce();
      if (validation.outcome === "accepted") {
        expect(scenario.access.archiveJobs.list(["completed"])).toHaveLength(1);
        expect(scenario.access.archiveRequests.list(["fulfilled"])).toEqual([
          expect.objectContaining({ id: scenario.request.id }),
        ]);
        const archive = scenario.access.catalog.listOriginalDiscArchives()[0]!;
        expect(archive).toMatchObject({
          integrity: "watchable_salvage",
          integrityPolicyVersion: "dvd-watchable-salvage-v2",
          badSectorCount: ranges.reduce(
            (total, range) => total + range.sectorCount,
            0,
          ),
          badAreaCount: ranges.length,
          badSectorRanges: ranges,
          badSectorCountsByTitle: validation.badSectorCountsByTitle,
        });
        expect(readFileSync(archive.archivePath)).toEqual(
          scenario.rescuedImage,
        );
        expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
      } else {
        expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
          expect.objectContaining({
            archiveRequestId: scenario.request.id,
            originalDiscArchiveId: null,
            progressPhase: "verifying",
          }),
        ]);
        expect(
          scenario.access.archiveRequests.list(["needs_attention"]),
        ).toEqual([expect.objectContaining({ id: scenario.request.id })]);
        expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
        expect(scenario.rescuedPartialPath).toBeDefined();
        expect(existsSync(scenario.rescuedPartialPath!)).toBe(false);
        const rescuePaths = dvdRescueWorkspacePaths(
          realpathSync(scenario.originalsLibraryPath),
          scenario.request.id,
        );
        expect(readFileSync(rescuePaths.imagePath)).toEqual(
          scenario.rescuedImage,
        );
        expect(existsSync(rescuePaths.mapPath)).toBe(true);
      }
    },
  );

  it("quarantines worker publication when atomic catalog publication fails", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      beforePoll(access) {
        vi.spyOn(access.archiveJobs, "publish").mockImplementation(() => {
          throw new Error("catalog publication failed");
        });
      },
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted",
      },
    });

    expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: scenario.request.id,
        errorMessage: "catalog publication failed",
        originalDiscArchiveId: null,
        progressPhase: "finalizing",
      }),
    ]);
    expect(scenario.access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    const entries = readdirSync(scenario.originalsLibraryPath).sort();
    expect(entries).toHaveLength(3);
    expect(entries.filter((name) => name.endsWith(".rip-dvd-rescue.iso")))
      .toHaveLength(1);
    expect(entries.filter((name) => name.endsWith(".rip-dvd-rescue.json")))
      .toHaveLength(1);
    expect(entries).toContain(`dvdmeta-${"9".repeat(64)}.iso.failed`);
    expect(readFileSync(
      join(
        scenario.originalsLibraryPath,
        `dvdmeta-${"9".repeat(64)}.iso.failed`,
      ),
    )).toEqual(scenario.rescuedImage);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(scenario.originalsLibraryPath),
      scenario.request.id,
    );
    expect(readFileSync(rescuePaths.imagePath)).toEqual(scenario.rescuedImage);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
  });

  it("does not quarantine a successor fingerprint after rollback authority is lost", async () => {
    const successorImage = Buffer.alloc(4 * 2_048, 13);
    let archivePath: string | undefined;
    const staleClaim = new Error("Stale Archive Job rollback attempt");
    const scenario = await exerciseWatchabilityWorkerScenario({
      beforePoll(access, originalsLibraryPath, fingerprint) {
        archivePath = join(
          realpathSync(originalsLibraryPath),
          `dvdmeta-${fingerprint.slice(fingerprint.lastIndexOf(":") + 1)}.iso`,
        );
        const renewClaim = access.archiveJobs.renewClaim.bind(
          access.archiveJobs,
        );
        let rollbackAuthorityLost = false;
        vi.spyOn(access.archiveJobs, "renewClaim").mockImplementation((claim) => {
          if (rollbackAuthorityLost) {
            throw staleClaim;
          }
          return renewClaim(claim);
        });
        vi.spyOn(access.archiveJobs, "publish").mockImplementation(() => {
          unlinkSync(archivePath!);
          writeFileSync(archivePath!, successorImage);
          rollbackAuthorityLost = true;
          throw new Error("catalog publication lost to successor");
        });
      },
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: {
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted",
      },
    });

    expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: scenario.request.id,
        errorMessage: "catalog publication lost to successor",
      }),
    ]);
    expect(readFileSync(archivePath!)).toEqual(successorImage);
    expect(existsSync(`${archivePath}.failed`)).toBe(false);
  });

  it("resumes retained rescue work after a worker restart and publishes a clean read", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-rescue-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"7".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Rescue drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-RESCUE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const sizeBytes = 4 * 2_048;
    const rescuedImage = Buffer.alloc(sizeBytes, 5);
    rescuedImage.fill(0, 2_048, 4_096);
    rescuedImage.fill(0, 3 * 2_048, 4 * 2_048);
    let initialAttemptPath: string | undefined;
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
      { startLba: 3, sectorCount: 1 },
    ]);
    const firstCopyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart, outputPath, resumeFrom }) => {
        expect(resumeFrom).toBeUndefined();
        await authorizeStart?.();
        initialAttemptPath = outputPath;
        writeFileSync(outputPath, rescuedImage);
        return damagedRecovery;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes,
      }),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: firstCopyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-rescue-test",
    });

    const failure = access.archiveJobs.list(["failed"])[0]!;
    expect(failure).toMatchObject({
      archiveRequestId: request.id,
      status: "failed",
      progressPhase: "verifying",
      progressPercent: 99,
      errorMessage:
        "DVD rescue requires validation: 2 unreadable sectors in 2 areas; LBAs 1, 3",
      originalDiscArchiveId: null,
    });
    expect(failure.errorMessage).not.toContain(originalsLibraryPath);
    expect(failure.errorMessage).not.toContain(discoveredDrive.devicePath);
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(existsSync(initialAttemptPath!)).toBe(false);
    const rescueImageName = readdirSync(originalsLibraryPath).find((name) =>
      name.endsWith(".rip-dvd-rescue.iso"),
    );
    expect(rescueImageName).toBeDefined();
    const rescueImagePath = join(
      realpathSync(originalsLibraryPath),
      rescueImageName!,
    );
    expect(readFileSync(rescueImagePath)).toEqual(rescuedImage);

    access.archiveRequests.retry(request.id);
    const partiallyRecoveredImage = Buffer.from(rescuedImage);
    partiallyRecoveredImage.fill(5, 2_048, 4_096);
    const persistentRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 3, sectorCount: 1 },
    ]);
    const secondCopyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({
        authorizeStart,
        outputPath,
        resumeFrom,
        onBytesCopied,
      }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(resumeFrom).toEqual(damagedRecovery);
        await authorizeStart?.();
        expect(readFileSync(outputPath)).toEqual(rescuedImage);
        writeFileSync(outputPath, partiallyRecoveredImage);
        onBytesCopied(sizeBytes);
        return persistentRecovery;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: secondCopyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-rescue-restart-test",
    });

    expect(secondCopyRunner.copy).toHaveBeenCalledOnce();
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(
      access.archiveJobs
        .list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 2),
    ).toMatchObject({
      attemptOrdinal: 2,
      errorMessage:
        "DVD rescue requires validation: 1 unreadable sector in 1 area; LBAs 3",
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(readFileSync(rescueImagePath)).toEqual(partiallyRecoveredImage);

    access.archiveRequests.retry(request.id);
    const recoveredImage = Buffer.alloc(sizeBytes, 5);
    const archivePath = join(
      realpathSync(originalsLibraryPath),
      `dvdmeta-${fingerprint.slice(fingerprint.lastIndexOf(":") + 1)}.iso`,
    );
    const successorImage = Buffer.alloc(sizeBytes, 9);
    const finalCopyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({
        authorizeStart,
        outputPath,
        resumeFrom,
        onBytesCopied,
      }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(resumeFrom).toEqual(persistentRecovery);
        await authorizeStart?.();
        expect(readFileSync(outputPath)).toEqual(partiallyRecoveredImage);
        writeFileSync(outputPath, recoveredImage);
        onBytesCopied(sizeBytes);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    vi.spyOn(access.archiveJobs, "publish")
      .mockImplementationOnce(() => {
        throw new Error("catalog publication failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("catalog publication failed again");
      });
    mkdirSync(`${archivePath}.failed`);
    const publicationFailureWorkspaceLock: DvdRescueWorkspaceLock = {
      async withLock(options) {
        try {
          return await testRescueWorkspaceLock.withLock(options);
        } catch (error) {
          // Model a successor becoming eligible immediately after the lock is
          // released. Cleanup by the failed owner must not retry after this.
          rmSync(`${archivePath}.failed`, { recursive: true });
          unlinkSync(archivePath);
          writeFileSync(archivePath, successorImage);
          throw error;
        }
      },
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: finalCopyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: publicationFailureWorkspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-rescue-final-test",
    });

    expect(finalCopyRunner.copy).toHaveBeenCalledOnce();
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(
      access.archiveJobs
        .list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 3),
    ).toMatchObject({
      attemptOrdinal: 3,
      errorMessage: "catalog publication failed",
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(readFileSync(rescueImagePath)).toEqual(recoveredImage);
    expect(readFileSync(archivePath)).toEqual(successorImage);
    expect(existsSync(`${archivePath}.failed`)).toBe(false);
    unlinkSync(archivePath);

    access.archiveRequests.retry(request.id);
    const publicationRetryCopy = vi.fn();
    const publicationRetryRunner: DvdCopyRunner = {
      copy: publicationRetryCopy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: publicationRetryRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-rescue-publication-retry-test",
    });

    expect(publicationRetryCopy).not.toHaveBeenCalled();
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(
      access.archiveJobs
        .list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 4),
    ).toMatchObject({
      attemptOrdinal: 4,
      errorMessage: "catalog publication failed again",
    });
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(`${archivePath}.failed`)).toEqual(recoveredImage);
    expect(readFileSync(rescueImagePath)).toEqual(recoveredImage);

    access.archiveRequests.retry(request.id);
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: publicationRetryRunner,
      hardware,
      log(message) {
        throw new Error(message);
      },
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-rescue-publication-final-retry-test",
    });

    expect(publicationRetryCopy).not.toHaveBeenCalled();
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(
      access.archiveJobs
        .list()
        .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal),
    ).toEqual([
      expect.objectContaining({ status: "failed", attemptOrdinal: 1 }),
      expect.objectContaining({ status: "failed", attemptOrdinal: 2 }),
      expect.objectContaining({ status: "failed", attemptOrdinal: 3 }),
      expect.objectContaining({ status: "failed", attemptOrdinal: 4 }),
      expect.objectContaining({ status: "completed", attemptOrdinal: 5 }),
    ]);
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      integrity: "clean_read",
      integrityPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(readFileSync(archive.archivePath)).toEqual(recoveredImage);
    expect(existsSync(rescueImagePath)).toBe(false);
  });

  it("combines rescue progress from another matching Optical Drive", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 3, sectorCount: 1 },
      ],
      validation: { outcome: "rejected", reason: "ambiguous" },
    });
    const {
      access,
      drive: initialDrive,
      fingerprint,
      originalsLibraryPath,
      request,
      rescuedImage: initialImage,
      scanData,
      sizeBytes,
    } = scenario;
    const initialRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
      { startLba: 3, sectorCount: 1 },
    ]);
    const partiallyImprovedRecovery = createDamagedDvdRecoveryResult(
      sizeBytes,
      [{ startLba: 3, sectorCount: 1 }],
    );
    const partiallyImprovedImage = Buffer.from(initialImage);
    partiallyImprovedImage.fill(7, 2_048, 4_096);
    const recoveredImage = Buffer.alloc(sizeBytes, 7);
    const workspaceLock = createInProcessDvdRescueWorkspaceLock();
    const alternateDrive = {
      devicePath: "/dev/sr1",
      displayName: "Alternate rescue drive",
      serialNumber: "ALTERNATE-RESCUE-002",
    };
    const persistedAlternateDrive = access.catalog.upsertOpticalDrive({
      ...alternateDrive,
      isEnabled: true,
      isPresent: true,
    });
    access.archiveRequests.retry(request.id);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    const alternateCopy = vi.fn(async ({
      authorizeStart,
      devicePath,
      outputPath,
      resumeFrom,
    }: Parameters<DvdCopyRunner["copy"]>[0]) => {
      expect(devicePath).toBe(alternateDrive.devicePath);
      expect(outputPath).toBe(rescuePaths.imagePath);
      expect(resumeFrom).toEqual(initialRecovery);
      expect(readFileSync(outputPath)).toEqual(initialImage);
      await authorizeStart?.();
      writeFileSync(outputPath, partiallyImprovedImage);
      return partiallyImprovedRecovery;
    });
    const alternateHardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([alternateDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes,
      }),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: alternateCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware: alternateHardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-alternate-drive-partial",
    });

    expect(alternateCopy).toHaveBeenCalledOnce();
    expect(
      access.archiveJobs
        .list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 2),
    ).toMatchObject({
      archiveRequestId: request.id,
      attemptOrdinal: 2,
      errorMessage:
        "DVD rescue requires validation: 1 unreadable sector in 1 area; LBAs 3",
    });
    expect(readFileSync(rescuePaths.imagePath)).toEqual(partiallyImprovedImage);

    access.archiveRequests.retry(request.id);
    const finalCopy = vi.fn(async ({
      authorizeStart,
      devicePath,
      outputPath,
      resumeFrom,
    }: Parameters<DvdCopyRunner["copy"]>[0]) => {
      expect(devicePath).toBe(alternateDrive.devicePath);
      expect(outputPath).toBe(rescuePaths.imagePath);
      expect(resumeFrom).toEqual(partiallyImprovedRecovery);
      expect(readFileSync(outputPath)).toEqual(partiallyImprovedImage);
      await authorizeStart?.();
      writeFileSync(outputPath, recoveredImage);
      return createCleanDvdRecoveryResult(sizeBytes);
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: finalCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware: alternateHardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-alternate-drive-complete",
    });

    expect(finalCopy).toHaveBeenCalledOnce();
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      integrity: "clean_read",
    });
    expect(readFileSync(archive.archivePath)).toEqual(recoveredImage);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);

    const attempts = access.archiveJobs
      .list()
      .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
    expect(archive.detectedDiscId).toBe(attempts.at(-1)!.detectedDiscId);
    const observedDiscs = access.catalog.listDetectedDiscs(undefined, {
      ids: attempts.map(({ detectedDiscId }) => detectedDiscId),
    });
    const driveByDiscId = new Map(
      observedDiscs.map((disc) => [disc.id, disc.opticalDriveId]),
    );
    expect(
      attempts.map(({ attemptOrdinal, detectedDiscId }) => ({
        attemptOrdinal,
        opticalDriveId: driveByDiscId.get(detectedDiscId),
      })),
    ).toEqual([
      { attemptOrdinal: 1, opticalDriveId: initialDrive.id },
      { attemptOrdinal: 2, opticalDriveId: persistedAlternateDrive.id },
      { attemptOrdinal: 3, opticalDriveId: persistedAlternateDrive.id },
    ]);
    expect(JSON.stringify(attempts)).not.toContain("/dev/sr");
  });

  it.each(["missing", "mismatched"] as const)(
    "preserves rescue state when alternate-drive identity is %s",
    async (identityCase) => {
      const scenario = await exerciseWatchabilityWorkerScenario({
        ranges: [{ startLba: 1, sectorCount: 1 }],
        validation: { outcome: "rejected", reason: "ambiguous" },
      });
      scenario.access.archiveRequests.retry(scenario.request.id);
      const rescuePaths = dvdRescueWorkspacePaths(
        realpathSync(scenario.originalsLibraryPath),
        scenario.request.id,
      );
      const originalImage = readFileSync(rescuePaths.imagePath);
      const originalMap = readFileSync(rescuePaths.mapPath);
      const alternateDrive = {
        devicePath: "/dev/sr1",
        displayName: "Unproven alternate drive",
        serialNumber: `UNPROVEN-ALTERNATE-${identityCase}`,
      };
      scenario.access.catalog.upsertOpticalDrive({
        ...alternateDrive,
        isEnabled: true,
        isPresent: true,
      });
      const copy = vi.fn();
      const otherFingerprint = `dvdmeta-sha256:${"8".repeat(64)}`;
      const scanData = {
        schemaVersion: 2 as const,
        contentId: otherFingerprint,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      };

      await pollArchiveWorker({
        access: scenario.access,
        configuredDevicePath: "/dev/sr0",
        copyRunner: {
          copy,
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockResolvedValue([alternateDrive]),
          scanDvd: vi.fn().mockResolvedValue(
            identityCase === "missing"
              ? null
              : {
                  fingerprint: otherFingerprint,
                  scanData,
                  sizeBytes: originalImage.byteLength,
                },
          ),
        },
        log: vi.fn(),
        originalsLibraryPath: scenario.originalsLibraryPath,
        rescueWorkspaceLock: createInProcessDvdRescueWorkspaceLock(),
        signal: new AbortController().signal,
        workerId: `archive-worker-unproven-${identityCase}`,
      });

      expect(copy).not.toHaveBeenCalled();
      expect(readFileSync(rescuePaths.imagePath)).toEqual(originalImage);
      expect(readFileSync(rescuePaths.mapPath)).toEqual(originalMap);
      expect(scenario.access.archiveJobs.list()).toHaveLength(1);
      expect(scenario.access.archiveRequests.list(["pending"])).toEqual([
        expect.objectContaining({ id: scenario.request.id }),
      ]);
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it("cancels an alternate-drive rescue without changing saved state", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: { outcome: "rejected", reason: "ambiguous" },
    });
    scenario.access.archiveRequests.retry(scenario.request.id);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(scenario.originalsLibraryPath),
      scenario.request.id,
    );
    const originalImage = readFileSync(rescuePaths.imagePath);
    const originalMap = readFileSync(rescuePaths.mapPath);
    const alternateDrive = {
      devicePath: "/dev/sr1",
      displayName: "Cancellation alternate drive",
      serialNumber: "ALTERNATE-CANCEL-001",
    };
    scenario.access.catalog.upsertOpticalDrive({
      ...alternateDrive,
      isEnabled: true,
      isPresent: true,
    });
    const scanData = {
      schemaVersion: 2 as const,
      contentId: scenario.fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    vi.useFakeTimers();
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    let copyActive = false;
    let confirmCopyClosed!: () => void;
    const copyClosed = new Promise<void>((resolve) => {
      confirmCopyClosed = () => {
        copyActive = false;
        resolve();
      };
    });
    const copyRunner: DvdCopyRunner = {
      isActive: () => copyActive,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => copyClosed),
      copy: vi.fn(({ devicePath, outputPath, resumeFrom, signal }) => {
        expect(devicePath).toBe(alternateDrive.devicePath);
        expect(outputPath).toBe(rescuePaths.imagePath);
        expect(resumeFrom).toBeDefined();
        copyActive = true;
        copyStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    };
    const log = vi.fn();
    const polling = pollArchiveWorker({
      access: scenario.access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([alternateDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint: scenario.fingerprint,
          scanData,
          sizeBytes: originalImage.byteLength,
        }),
      },
      log,
      originalsLibraryPath: scenario.originalsLibraryPath,
      rescueWorkspaceLock: createInProcessDvdRescueWorkspaceLock(),
      signal: new AbortController().signal,
      workerId: "archive-worker-alternate-cancellation",
    });
    await started;

    expect(
      scenario.access.archiveRequests.cancel(scenario.request.id).status,
    ).toBe("cancellation_requested");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(copyRunner.waitForInactive).toHaveBeenCalledOnce();
    });
    confirmCopyClosed();
    await polling;

    expect(scenario.access.archiveJobs.list(["aborted"])).toEqual([
      expect.objectContaining({
        attemptOrdinal: 2,
        errorMessage: "Archive cancelled by operator",
      }),
    ]);
    expect(scenario.access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(originalImage);
    expect(readFileSync(rescuePaths.mapPath)).toEqual(originalMap);
    expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      `DVD archive cancelled for ${alternateDrive.devicePath}`,
    );
  });

  it("rejects mismatched rescue state before a later Archive Job reads the disc", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-stale-rescue-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"8".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "ARCHIVE-STALE-RESCUE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const sizeBytes = 2 * 2_048;
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes,
      }),
    };
    const firstCopyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart, outputPath }) => {
        await authorizeStart?.();
        const image = Buffer.alloc(sizeBytes, 6);
        image.fill(0, 2_048);
        writeFileSync(outputPath, image);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: firstCopyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-stale-rescue-first-test",
    });

    const root = realpathSync(originalsLibraryPath);
    const rescueMapName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.json"),
    );
    expect(rescueMapName).toBeDefined();
    const rescueMapPath = join(root, rescueMapName!);
    const rescueMap = JSON.parse(readFileSync(rescueMapPath, "utf8")) as {
      fingerprint: string;
    };
    rescueMap.fingerprint = `dvdmeta-sha256:${"9".repeat(64)}`;
    writeFileSync(rescueMapPath, `${JSON.stringify(rescueMap)}\n`);
    access.archiveRequests.retry(request.id);
    const copy = vi.fn();
    const laterCopyRunner: DvdCopyRunner = {
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: laterCopyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-stale-rescue-later-test",
    });

    expect(copy).not.toHaveBeenCalled();
    expect(
      access.archiveJobs
        .list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 2),
    ).toMatchObject({
      attemptOrdinal: 2,
      errorMessage: "DVD rescue state does not match the Archive Request",
    });
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(
      readdirSync(root).filter((name) => name.includes(".invalid-")),
    ).toHaveLength(2);
  });


  it("copies requested work on different drives within configured concurrency", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-copy-admission-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const discoveredDrives = [
      { devicePath: "/dev/sr0", serialNumber: "COPY-ADMISSION-001" },
      { devicePath: "/dev/sr1", serialNumber: "COPY-ADMISSION-002" },
    ];
    const contents = ["dvd-one", "dvd-two"];
    const fingerprints = contents.map((content) => {
      const bytes = Buffer.from(content);
      const hasher = createRawDvdContentIdHasher(bytes.byteLength);
      hasher.update(bytes);
      return hasher.digest();
    });
    const drives = discoveredDrives.map((drive) =>
      access.catalog.upsertOpticalDrive({
        ...drive,
        isEnabled: true,
        isPresent: true,
      }),
    );
    const requests = drives.map((drive, index) => {
      const fingerprint = fingerprints[index]!;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        scanData: {
          schemaVersion: 2,
          contentId: fingerprint,
          titles: [
            {
              number: 1,
              durationSeconds: 600,
              chapters: 4,
              audioStreams: [],
              subtitles: [],
            },
          ],
        },
        sizeBytes: 7,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      return access.archiveRequests.create({ detectedDiscId: disc.id });
    });
    let releaseCopies!: () => void;
    const copiesMayFinish = new Promise<void>((resolve) => {
      releaseCopies = resolve;
    });
    let activeCopies = 0;
    let maximumActiveCopies = 0;
    const copy = vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
      activeCopies += 1;
      maximumActiveCopies = Math.max(maximumActiveCopies, activeCopies);
      try {
        await copiesMayFinish;
        const contentIndex = fingerprints.findIndex((fingerprint) =>
          outputPath.includes(fingerprint.slice("sha256:".length)),
        );
        writeFileSync(outputPath, contents[contentIndex]!);
        onBytesCopied(7);
      } finally {
        activeCopies -= 1;
      }
      return createCleanDvdRecoveryResult(sizeBytes);
    });
    const copyRunner: DvdCopyRunner = {
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const pollOptions = {
      access,
      concurrency: 2,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue(discoveredDrives),
        scanDvd: vi.fn(async (binding: { drive: DiscoveredOpticalDrive }) => {
          const index = discoveredDrives.findIndex(
            (drive) => drive.devicePath === binding.drive.devicePath,
          );
          const fingerprint = fingerprints[index]!;
          return {
            fingerprint,
            scanData: {
              schemaVersion: 2 as const,
              contentId: fingerprint,
              titles: [
                {
                  number: 1,
                  durationSeconds: 600,
                  chapters: 4,
                  audioStreams: [],
                  subtitles: [],
                },
              ],
            },
            sizeBytes: 7,
          };
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
    };
    for (const drive of drives) {
      beginNearlySettledDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: "test-media-generation",
        mediaCapacityBytes: 2_048,
      });
    }
    const poll = pollArchiveWorkerOnce(pollOptions);

    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
    expect(maximumActiveCopies).toBe(2);
    expect(access.archiveJobs.list(["running"])).toHaveLength(2);
    expect(access.archiveJobs.list(["failed"])).toEqual([]);
    expect(access.archiveRequests.list(["pending"])).toEqual([]);

    releaseCopies();
    await poll;

    expect(access.archiveJobs.list(["failed"])).toEqual([]);
    expect(access.archiveJobs.list(["completed"])).toHaveLength(2);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual(
      expect.arrayContaining(
        requests.map((request) => expect.objectContaining({ id: request.id })),
      ),
    );
  });

  it("admits completed inspections in Archive Request priority order", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-priority-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const discoveredDrives = [
      { devicePath: "/dev/sr0", serialNumber: "PRIORITY-LOW" },
      { devicePath: "/dev/sr1", serialNumber: "PRIORITY-HIGH" },
    ];
    const contents = ["low-dvd", "high-dvd"];
    const fingerprints = contents.map((content) => {
      const bytes = Buffer.from(content);
      const hasher = createRawDvdContentIdHasher(bytes.byteLength);
      hasher.update(bytes);
      return hasher.digest();
    });
    const drives = discoveredDrives.map((drive) =>
      access.catalog.upsertOpticalDrive({
        ...drive,
        isEnabled: true,
        isPresent: true,
      }),
    );
    const requests = drives.map((drive, index) => {
      const fingerprint = fingerprints[index]!;
      const content = contents[index]!;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        scanData: {
          schemaVersion: 2,
          contentId: fingerprint,
          titles: [{
            number: 1,
            durationSeconds: 600,
            chapters: 4,
            audioStreams: [],
            subtitles: [],
          }],
        },
        sizeBytes: Buffer.byteLength(content),
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const started = beginSettledDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: "test-media-generation",
        mediaCapacityBytes: 2_048,
      });
      access.discInspections.record(started.claim!, {
        type: "metadata",
        audioStreamCount: 0,
        chapterCount: 4,
        subtitleStreamCount: 0,
        titleCount: 1,
        totalBytes: Buffer.byteLength(content),
        volumeLabel: null,
      });
      access.discInspections.record(started.claim!, {
        type: "complete",
        detectedDiscId: disc.id,
      });
      return access.archiveRequests.create({
        detectedDiscId: disc.id,
        priority: index === 0 ? 0 : 100,
      });
    });
    const copiedFingerprints: string[] = [];
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        const contentIndex = fingerprints.findIndex((fingerprint) =>
          outputPath.includes(fingerprint.slice("sha256:".length)),
        );
        copiedFingerprints.push(fingerprints[contentIndex]!);
        writeFileSync(outputPath, contents[contentIndex]!);
        onBytesCopied(Buffer.byteLength(contents[contentIndex]!));
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      concurrency: 1,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue(discoveredDrives),
        scanDvd: vi.fn(() => {
          throw new Error("Completed Disc Inspection should be reused");
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
    });

    expect(copiedFingerprints).toEqual([fingerprints[1], fingerprints[0]]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual(
      expect.arrayContaining(
        requests.map((request) => expect.objectContaining({ id: request.id })),
      ),
    );
  });

  it("starts requested archive work promptly while another drive inspection is slow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-start-latency-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const controller = new AbortController();
    const fingerprint =
      "sha256:e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const fastDiscoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "START-LATENCY-001",
    };
    const slowDiscoveredDrive = {
      devicePath: "/dev/sr1",
      isConfiguredDevice: false,
      serialNumber: "SLOW-SCAN-001",
    };
    const [fastDrive] = access.catalog.reconcileOpticalDrives([
      { ...fastDiscoveredDrive, isConfiguredDevice: true },
      slowDiscoveredDrive,
    ]);
    const slowDrive = access.catalog.upsertOpticalDrive({
      devicePath: slowDiscoveredDrive.devicePath,
      isEnabled: true,
      isPresent: true,
      serialNumber: slowDiscoveredDrive.serialNumber,
    });
    const started = beginSettledDiscInspection(access, {
      opticalDriveId: fastDrive!.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: 2_048,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: fastDrive!.id,
      discKind: "dvd",
      fingerprint,
      scanData,
      sizeBytes: 9,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.discInspections.record(started.claim!, {
      type: "metadata",
      audioStreamCount: 0,
      chapterCount: 10,
      subtitleStreamCount: 0,
      titleCount: 1,
      totalBytes: 9,
      volumeLabel: "START_LATENCY",
    });
    access.discInspections.record(started.claim!, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    beginNearlySettledDiscInspection(access, {
      opticalDriveId: slowDrive.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: 2_048,
    });
    const startForInspectionSpy = vi.spyOn(
      access.archiveJobs,
      "startForInspection",
    );
    const waitForShutdown = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return await new Promise<null>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const scanDvd = vi.fn(
      async (
        binding: { drive: DiscoveredOpticalDrive },
        signal: AbortSignal,
      ) => {
        if (binding.drive.devicePath === slowDiscoveredDrive.devicePath) {
          return await waitForShutdown(signal);
        }
        throw new Error("Completed Disc Inspection should be reused");
      },
    );
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        onBytesCopied(9);
        writeFileSync(outputPath, "dvd-image");
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const log = vi.fn();
    const polling = runArchiveWorker({
      access,
      concurrency: 2,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi
          .fn()
          .mockResolvedValue([fastDiscoveredDrive, slowDiscoveredDrive]),
        scanDvd,
      },
      log,
      originalsLibraryPath,
      pollIntervalMs: 60_000,
      signal: controller.signal,
      waitForNextPoll: async (intervalMs, signal) =>
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, intervalMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      workerId: "archive-worker-start-latency-test",
    });

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(
        scanDvd.mock.calls.some(
          ([binding]) =>
            binding.drive.devicePath === slowDiscoveredDrive.devicePath,
        ),
      ).toBe(true);
      expect(startForInspectionSpy).not.toHaveBeenCalled();
      const request = access.archiveRequests.create({
        detectedDiscId: disc.id,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(startForInspectionSpy).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([]);
      await vi.waitFor(() => expect(copyRunner.copy).toHaveBeenCalledTimes(1));
      const [job] = access.archiveJobs.list();
      expect(job).toEqual(
        expect.objectContaining({
          archiveRequestId: request.id,
          detectedDiscId: disc.id,
        }),
      );
      expect(
        job!.startedAt!.getTime() - request.createdAt.getTime(),
      ).toBeLessThan(10_000);
    } finally {
      controller.abort(new Error("test complete"));
      await polling;
    }
  });

  it("reacquires the same insertion after an expired inspection lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const access = openTestDataAccess();
    const drive = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "INTERRUPTED-INSPECTION-001",
        isConfiguredDevice: true,
      },
    ])[0]!;
    const original = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: 2_048,
    });

    const pollOptions = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "INTERRUPTED-INSPECTION-001",
        }]),
        scanDvd: vi.fn().mockResolvedValue(null),
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    };

    vi.advanceTimersByTime(DISC_INSPECTION_LEASE_DURATION_MS + 1);
    await pollArchiveWorker(pollOptions);

    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        id: original.inspection.id,
        attemptCount: 2,
        status: "aborted",
        reasonCode: "no_medium",
      }),
    ]);
    expect(access.discInspections.listAttempts(original.inspection.id)).toEqual([
      expect.objectContaining({ outcome: "interrupted" }),
      expect.objectContaining({ outcome: "aborted", reasonCode: "no_medium" }),
    ]);
  });

  it("aborts an in-flight scan when inspection lease renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T13:00:00.000Z"));
    const access = openTestDataAccess();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "INSPECTION-LEASE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    let scanSignal: AbortSignal | undefined;
    const scanDvd = vi.fn(
      async (_binding: unknown, activeSignal: AbortSignal) => {
        scanSignal = activeSignal;
        return await new Promise<null>((_resolve, reject) => {
          activeSignal.addEventListener(
            "abort",
            () => reject(activeSignal.reason),
            { once: true },
          );
        });
      },
    );
    const log = vi.fn();

    beginNearlySettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: 2_048,
    });
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd,
      },
      log,
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(scanDvd).toHaveBeenCalledOnce());
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({ status: "running", attemptCount: 1 }),
    ]);
    vi.spyOn(access.discInspections, "renew").mockImplementation(() => {
      throw new Error("Stale disc inspection attempt");
    });

    await vi.advanceTimersByTimeAsync(
      Math.floor(DISC_INSPECTION_LEASE_DURATION_MS / 3),
    );
    await polling;

    expect(scanSignal?.aborted).toBe(true);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        status: "running",
        phase: "retry_wait",
        consecutiveFailureCount: 1,
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("DVD scan failed"),
    );
  });

  it("persists recoverable failure state and leaves no completed archive", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-failure-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const digest = "f".repeat(64);
    const fingerprint = `sha256:${digest}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-FAILURE-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 9,
      }),
    };
    let failedPartialPath: string | undefined;
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        failedPartialPath = outputPath;
        onBytesCopied(4);
        writeFileSync(outputPath, "partial");
        throw new Error("dd read failed");
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
      workerId: "archive-worker-failure-test",
    });

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        status: "failed",
        progressPhase: "copying",
        progressPercent: 44,
        errorMessage: "dd read failed",
        originalDiscArchiveId: null,
      }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);
    const root = realpathSync(originalsLibraryPath);
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
    expect(readFileSync(`${failedPartialPath}.failed`, "utf8")).toBe(
      "partial",
    );
  });

  it("persists an interrupted archive as a recoverable failure", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-interrupted-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const digest = "e".repeat(64);
    const fingerprint = `sha256:${digest}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-INTERRUPTED-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const controller = new AbortController();
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 9,
      }),
    };
    const interruption = new Error("worker shutdown");
    let interruptedPartialPath: string | undefined;
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        interruptedPartialPath = outputPath;
        writeFileSync(outputPath, "partial");
        onBytesCopied(4);
        controller.abort(interruption);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(
      pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        copyRunner,
        hardware,
        log: vi.fn(),
        originalsLibraryPath,
        signal: controller.signal,
        workerId: "archive-worker-interrupted-test",
      }),
    ).rejects.toBe(interruption);

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        status: "failed",
        progressPercent: 44,
        errorMessage: "Archive interrupted",
        originalDiscArchiveId: null,
      }),
    ]);
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    const root = realpathSync(originalsLibraryPath);
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
    expect(readFileSync(`${interruptedPartialPath}.failed`, "utf8")).toBe(
      "partial",
    );
  });

  it("renews the owned Archive Job lease throughout a long copy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-heartbeat-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const digest = "d".repeat(64);
    const fingerprint = `sha256:${digest}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "ARCHIVE-HEARTBEAT-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const controller = new AbortController();
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 9,
      }),
    };
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(({ signal }) => {
        copyStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              try {
                signal.throwIfAborted();
              } catch (error) {
                reject(error);
              }
            },
            { once: true },
          );
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const polling = pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal: controller.signal,
      workerId: "archive-worker-heartbeat-test",
    });
    await started;

    await vi.advanceTimersByTimeAsync(ARCHIVE_JOB_LEASE_DURATION_MS * 2);
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([]);
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ archiveRequestId: request.id }),
    ]);

    const interruption = new Error("worker shutdown");
    controller.abort(interruption);
    await expect(polling).rejects.toBe(interruption);
  });

  it("fences a stale rescue owner before its successor uses the workspace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T20:00:00.000Z"));
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-stale-owner-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const digest = "6".repeat(64);
    const fingerprint = `dvdmeta-sha256:${digest}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "ARCHIVE-STALE-OWNER-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const sizeBytes = 2 * 2_048;
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes,
      }),
    };
    const workspaceLock = createInProcessDvdRescueWorkspaceLock();
    const damagedImage = Buffer.alloc(sizeBytes, 4);
    damagedImage.fill(0, 2_048);
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: vi.fn(async ({ authorizeStart, outputPath }) => {
          await authorizeStart?.();
          writeFileSync(outputPath, damagedImage);
          return damagedRecovery;
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-stale-owner-seed",
    });

    access.archiveRequests.retry(request.id);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    let staleCopyStarted!: () => void;
    const staleStarted = new Promise<void>((resolve) => {
      staleCopyStarted = resolve;
    });
    let finishStaleCopy!: () => void;
    const staleCopyGate = new Promise<void>((resolve) => {
      finishStaleCopy = resolve;
    });
    const staleRecoveredImage = Buffer.alloc(sizeBytes, 7);
    const staleRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart, outputPath, resumeFrom }) => {
        expect(resumeFrom).toEqual(damagedRecovery);
        await authorizeStart?.();
        writeFileSync(outputPath, staleRecoveredImage);
        staleCopyStarted();
        await staleCopyGate;
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const originalRenewClaim = access.archiveJobs.renewClaim.bind(
      access.archiveJobs,
    );
    let suppressHeartbeatRenewal = false;
    vi.spyOn(access.archiveJobs, "renewClaim").mockImplementation((claim) =>
      suppressHeartbeatRenewal ? claim : originalRenewClaim(claim)
    );
    const stalePoll = pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: staleRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-stale-owner",
    });
    await staleStarted;

    suppressHeartbeatRenewal = true;
    await vi.advanceTimersByTimeAsync(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(1);
    suppressHeartbeatRenewal = false;
    access.archiveRequests.retry(request.id);

    const excludedSuccessorCopy = vi.fn();
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: excludedSuccessorCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-excluded-successor",
    });
    expect(excludedSuccessorCopy).not.toHaveBeenCalled();
    expect(access.archiveJobs.list(["failed"]).at(-1)).toMatchObject({
      attemptOrdinal: 3,
      errorMessage: "DVD rescue workspace is already active",
    });

    finishStaleCopy();
    await stalePoll;
    expect(
      existsSync(join(realpathSync(originalsLibraryPath), `dvdmeta-${digest}.iso`)),
    ).toBe(false);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(staleRecoveredImage);

    access.archiveRequests.retry(request.id);
    const successorImage = Buffer.alloc(sizeBytes, 8);
    const successorCopy = vi.fn(async ({
      authorizeStart,
      outputPath,
      resumeFrom,
    }) => {
      expect(resumeFrom).toEqual(damagedRecovery);
      await authorizeStart?.();
      writeFileSync(outputPath, successorImage);
      return createCleanDvdRecoveryResult(sizeBytes);
    });
    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: successorCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      rescueWorkspaceLock: workspaceLock,
      signal: new AbortController().signal,
      workerId: "archive-worker-current-successor",
    });

    expect(successorCopy).toHaveBeenCalledOnce();
    expect(
      access.archiveJobs.list()
        .map(({ attemptOrdinal, status }) => ({ attemptOrdinal, status }))
        .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal),
    ).toEqual([
      { attemptOrdinal: 1, status: "failed" },
      { attemptOrdinal: 2, status: "failed" },
      { attemptOrdinal: 3, status: "failed" },
      { attemptOrdinal: 4, status: "completed" },
    ]);
    expect(readFileSync(
      access.catalog.listOriginalDiscArchives()[0]!.archivePath,
    )).toEqual(successorImage);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("does not finalize cancellation until the copy helper is closed", async () => {
    vi.useFakeTimers();
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(join(tmpdir(), "rip-dvd-cancel-"));
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 600,
        chapters: 4,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "ARCHIVE-CANCEL-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ])[0]!;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      scanDvd: vi.fn().mockResolvedValue({ fingerprint, scanData, sizeBytes: 9 }),
    };
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    let copyActive = false;
    let confirmCopyClosed!: () => void;
    const copyClosed = new Promise<void>((resolve) => {
      confirmCopyClosed = () => {
        copyActive = false;
        resolve();
      };
    });
    const copyRunner: DvdCopyRunner = {
      isActive: () => copyActive,
      withDeviceInactive: vi.fn(async (_path, mutation) => {
        if (copyActive) {
          throw new Error("DVD archive copy is still active");
        }
        return mutation();
      }),
      waitForInactive: vi.fn(async () => copyClosed),
      copy: vi.fn(({ signal }) => {
        copyActive = true;
        copyStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    };
    const log = vi.fn();
    const polling = pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log,
      originalsLibraryPath,
      signal: new AbortController().signal,
    });
    await started;

    expect(access.archiveRequests.cancel(request.id).status).toBe("cancellation_requested");
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(copyRunner.waitForInactive).toHaveBeenCalledOnce();
    });
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ archiveRequestId: request.id }),
    ]);
    expect(access.archiveRequests.list(["cancellation_requested"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);

    confirmCopyClosed();
    await polling;

    expect(access.archiveJobs.list(["aborted"])).toEqual([
      expect.objectContaining({ errorMessage: "Archive cancelled by operator" }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(log).toHaveBeenCalledWith("DVD archive cancelled for /dev/sr0");
  });

  it("recovers an expired cancellation only after archive work is proven inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T07:00:00.000Z"));
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-cancel-recovery-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const drive = access.catalog.reconcileOpticalDrives([{
      devicePath: "/dev/sr0",
      serialNumber: "ARCHIVE-CANCEL-RECOVERY-001",
      isConfiguredDevice: true,
    }])[0]!;
    const started = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "cancelled-worker-insertion",
      mediaCapacityBytes: 2_048,
    });
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const inspection = access.discInspections.record(started.claim!, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const request = access.archiveRequests.list(["pending"])[0]!;
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-that-exited",
    )!;
    access.archiveRequests.cancel(request.id);
    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);

    let active = true;
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(),
      isActive: vi.fn(() => false),
      withDeviceInactive: vi.fn(async (_path, mutation) => {
        if (active) {
          throw new Error("DVD archive copy is still active");
        }
        return mutation();
      }),
      waitForInactive: vi.fn(async () => undefined),
    };
    const log = vi.fn();
    const pollOptions = {
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([]),
        scanDvd: vi.fn().mockResolvedValue(null),
      },
      log,
      originalsLibraryPath,
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(pollOptions);
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: claim.id }),
    ]);
    expect(access.archiveRequests.list(["cancellation_requested"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("DVD archive copy is still active"),
    );

    active = false;
    await pollArchiveWorker(pollOptions);
    expect(access.archiveJobs.list(["aborted"])).toEqual([
      expect.objectContaining({
        id: claim.id,
        errorMessage: "Archive cancelled after worker recovery",
      }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
  });

  it("discovers an enabled Optical Drive and stores its scanned Detected Disc", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDataAccess();
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([
        {
          devicePath: "/dev/sr0",
          displayName: "Kitchen USB drive",
          vendor: "Pioneer",
          product: "DVD-RW",
          serialNumber: "DRIVE-001",
        },
      ]),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint:
          "sha256:88f29ef28f93bb183060ae0fd252ad660ab4f00e68a44ecb4006f20d223c5470",
        volumeLabel: "EXAMPLE_DISC",
        scanData: {
          schemaVersion: 2,
          contentId:
            "sha256:88f29ef28f93bb183060ae0fd252ad660ab4f00e68a44ecb4006f20d223c5470",
          titles: [
            {
              number: 1,
              durationSeconds: 5_711,
              chapters: 12,
              audioStreams: [
                {
                  id: 128,
                  language: "English",
                  format: "ac3",
                  channels: 6,
                },
              ],
              subtitles: [{ id: 32, language: "English", content: "Normal" }],
            },
          ],
        },
      }),
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        devicePath: "/dev/sr0",
        displayName: "Kitchen USB drive",
        isEnabled: true,
        isPresent: true,
        lastSeenAt: new Date("2026-07-26T18:00:05.000Z"),
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({
        discKind: "dvd",
        fingerprint:
          "sha256:88f29ef28f93bb183060ae0fd252ad660ab4f00e68a44ecb4006f20d223c5470",
        volumeLabel: "EXAMPLE_DISC",
        status: "scanned",
        scanData: {
          schemaVersion: 2,
          contentId:
            "sha256:88f29ef28f93bb183060ae0fd252ad660ab4f00e68a44ecb4006f20d223c5470",
          titles: [
            {
              number: 1,
              durationSeconds: 5_711,
              chapters: 12,
              audioStreams: [
                {
                  id: 128,
                  language: "English",
                  format: "ac3",
                  channels: 6,
                },
              ],
              subtitles: [{ id: 32, language: "English", content: "Normal" }],
            },
          ],
        },
      }),
    ]);
    expect(access.archiveJobs.list()).toEqual([]);
    access.close();
  });

  it("settles three matching media observations over five seconds before scanning", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-22T18:00:00.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDataAccess();
    const mediaCapacityBytes = 4_700_372_992;
    const run = vi.fn(async (executable: string) => {
      if (executable === "lsblk") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            blockdevices: [{
              path: "/dev/sr0",
              type: "rom",
              vendor: "Pioneer",
              model: "DVD-RW",
              serial: "SETTLING-001",
            }],
          }),
          stderr: "",
        };
      }
      if (executable === "blockdev") {
        return {
          exitCode: 0,
          stdout: `${mediaCapacityBytes}\n`,
          stderr: "",
        };
      }
      if (executable === "rip-dvd-lsdvd") {
        expect(access.discInspections.list({ currentOnly: true })).toEqual([
          expect.objectContaining({
            phase: "reading_metadata",
            mediaGeneration: "test-media-generation",
            mediaCapacityBytes,
            stableObservationCount: 3,
            settlingQuietWindowStartedAt: startedAt,
            settlingStartedAt: startedAt,
            settlingResetCount: 0,
          }),
        ]);
        return {
          exitCode: 0,
          stdout: [
            "Disc Title: SETTLED_DISC",
            "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${executable}`);
    });
    const runner: CommandRunner = { run };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("test-media-generation"),
      },
    });
    const poll = () => pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    await poll();
    const inspectionId = access.discInspections.list({ currentOnly: true })[0]!.id;
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: inspectionId,
        phase: "settling",
        mediaGeneration: "test-media-generation",
        mediaCapacityBytes,
        stableObservationCount: 1,
        settlingQuietWindowStartedAt: startedAt,
        settlingStartedAt: startedAt,
        settlingResetCount: 0,
        totalBytes: null,
        bytesPerSecond: null,
        etaSeconds: null,
      }),
    ]);
    expect(
      run.mock.calls.filter(([executable]) =>
        executable === "rip-dvd-lsdvd"
      ),
    ).toHaveLength(0);

    vi.advanceTimersByTime(2_500);
    await poll();
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: inspectionId,
        phase: "settling",
        stableObservationCount: 2,
      }),
    ]);
    expect(
      run.mock.calls.filter(([executable]) =>
        executable === "rip-dvd-lsdvd"
      ),
    ).toHaveLength(0);

    vi.advanceTimersByTime(2_500);
    await poll();

    expect(
      run.mock.calls.filter(([executable]) =>
        executable === "rip-dvd-lsdvd"
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(([executable]) => executable === "blockdev"),
    ).toHaveLength(3);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: inspectionId,
        status: "completed",
        mediaGeneration: "test-media-generation",
        mediaCapacityBytes,
        stableObservationCount: 3,
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({
        fingerprint: expect.stringMatching(/^dvdmeta-sha256:/),
        volumeLabel: "SETTLED_DISC",
      }),
    ]);
    access.close();
  });

  it("keeps three matching observations inside five seconds in settling", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-22T19:00:00.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDataAccess();
    const scanDvd = vi.fn();
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([{
        devicePath: "/dev/sr0",
        displayName: "Settling drive",
        serialNumber: "SETTLING-002",
      }]),
      observeMedia: vi.fn().mockResolvedValue({
        mediaGeneration: "test-media-generation",
        capacityBytes: 4_700_372_992,
      }),
      scanDvd,
    };
    const poll = () => pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    await poll();
    vi.advanceTimersByTime(2_000);
    await poll();
    vi.advanceTimersByTime(2_000);
    await poll();

    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        phase: "settling",
        stableObservationCount: 3,
        settlingQuietWindowStartedAt: startedAt,
        settlingStartedAt: startedAt,
      }),
    ]);
    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("does not persist a disc when authorized hardware is replaced during scanning", async () => {
    const access = openTestDataAccess();
    const log = vi.fn();
    let dvdMetadataRead = false;
    const runner: CommandRunner = {
      run: vi.fn(async (executable) => {
        if (executable === "lsblk") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              blockdevices: [
                {
                  path: "/dev/sr0",
                  type: "rom",
                  vendor: "Pioneer",
                  model: "DVD-RW",
                  serial: dvdMetadataRead ? "NEW-DRIVE" : "OLD-DRIVE",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (executable === "rip-dvd-lsdvd") {
          dvdMetadataRead = true;
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: REPLACEMENT_DISC",
              "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        if (executable === "blockdev") {
          return { exitCode: 0, stdout: "2048\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("1"),
      },
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log,
      signal: new AbortController().signal,
    });

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        devicePath: "/dev/sr0",
        isEnabled: false,
        serialNumber: "NEW-DRIVE",
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(runner.run).toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      ["-Oh", "-a", "-c", "-s", "/dev/sr0"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: Optical Drive identity changed before DVD persistence",
    );
    access.close();
  });

  it("scans when a matching serial proves continuity across model-text changes", async () => {
    const access = openTestDataAccess();
    const fingerprint =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const initialDrive = {
      devicePath: "/dev/sr0",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "STABLE-SERIAL",
    };
    const updatedDrive = {
      ...initialDrive,
      vendor: "HL-DT-ST",
      product: "DVDRAM",
    };
    const discover = vi
      .fn()
      .mockResolvedValueOnce([initialDrive])
      .mockResolvedValue([updatedDrive]);
    const scanDvd = vi.fn().mockResolvedValue({
      fingerprint,
      volumeLabel: "MODEL_TEXT_CHANGED",
      scanData: {
        schemaVersion: 2,
        contentId: fingerprint,
        titles: [
          {
            number: 1,
            durationSeconds: 60,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: { ...stableDeviceBinding(), discover, scanDvd },
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(scanDvd).toHaveBeenCalledOnce();
    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        devicePath: "/dev/sr0",
        vendor: "HL-DT-ST",
        product: "DVDRAM",
        serialNumber: "STABLE-SERIAL",
        isEnabled: true,
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({
        fingerprint,
        volumeLabel: "MODEL_TEXT_CHANGED",
        status: "scanned",
      }),
    ]);
    access.close();
  });

  it("fails closed when same-path hardware has no serial continuity evidence", async () => {
    const access = openTestDataAccess();
    const log = vi.fn();
    const scanDvd = vi.fn().mockResolvedValue({
      fingerprint:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      volumeLabel: "UNPROVEN_DISC",
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        titles: [
          {
            number: 1,
            durationSeconds: 60,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([
          {
            devicePath: "/dev/sr0",
            vendor: "Pioneer",
            product: "DVD-RW",
          },
        ]),
        scanDvd,
      },
      log,
      signal: new AbortController().signal,
    });

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        devicePath: "/dev/sr0",
        isEnabled: false,
        serialNumber: null,
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(scanDvd).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: Optical Drive identity changed before DVD scanning",
    );
    access.close();
  });

  it("does not open replacement hardware that takes the authorized path before scanning", async () => {
    const access = openTestDataAccess();
    const log = vi.fn();
    let discoveryCount = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (executable) => {
        if (executable === "lsblk") {
          discoveryCount += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              blockdevices: [
                {
                  path: "/dev/sr0",
                  type: "rom",
                  vendor: "Pioneer",
                  model: "DVD-RW",
                  serial:
                    discoveryCount <= 2 ? "DRIVE-001" : "REPLACEMENT-002",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (executable === "rip-dvd-lsdvd") {
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: REPLACEMENT_DISC",
              "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        if (executable === "blockdev") {
          return { exitCode: 0, stdout: "2048\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardwareOptions = {
      platform: "linux" as NodeJS.Platform,
      runner,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("7"),
      },
      deviceInstanceObserver: {
        observe: vi.fn().mockResolvedValue("42"),
      },
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: createLinuxOpticalDriveHardware(hardwareOptions),
      log,
      signal: new AbortController().signal,
    });

    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        isEnabled: false,
        serialNumber: "REPLACEMENT-002",
      }),
    ]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: Optical Drive identity changed before DVD scanning",
    );
    access.close();
  });

  it("does not persist a replacement scan across an A-to-B-to-A device swap", async () => {
    const access = openTestDataAccess();
    const log = vi.fn();
    const runner: CommandRunner = {
      run: vi.fn(async (executable) => {
        if (executable === "lsblk") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              blockdevices: [
                {
                  path: "/dev/sr0",
                  type: "rom",
                  vendor: "Pioneer",
                  model: "DVD-RW",
                  serial: "DRIVE-001",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (executable === "rip-dvd-lsdvd") {
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: TRANSIENT_REPLACEMENT",
              "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        if (executable === "blockdev") {
          return { exitCode: 0, stdout: "2048\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    let deviceObservationCount = 0;
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("7"),
      },
      deviceInstanceObserver: {
        observe: vi.fn(async () => {
          deviceObservationCount += 1;
          return deviceObservationCount <= 6 ? "41" : "43";
        }),
      },
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log,
      signal: new AbortController().signal,
    });

    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: Optical Drive instance changed before DVD scanning",
    );
    access.close();
  });

  it("enables a newly discovered Optical Drive configured through a device alias", async () => {
    const deviceDirectory = mkdtempSync(join(tmpdir(), "rip-dvd-device-alias-"));
    temporaryDirectories.push(deviceDirectory);
    const canonicalDevicePath = join(deviceDirectory, "sr0");
    const configuredAliasPath = join(deviceDirectory, "dvd");
    writeFileSync(canonicalDevicePath, "");
    symlinkSync(canonicalDevicePath, configuredAliasPath);
    const discoveredDevicePath = realpathSync(canonicalDevicePath);
    const access = openTestDataAccess();
    const scanDvd = vi.fn().mockResolvedValue(null);

    await pollArchiveWorker({
      access,
      configuredDevicePath: configuredAliasPath,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([
          {
            devicePath: discoveredDevicePath,
            displayName: "Aliased drive",
            serialNumber: "ALIAS-001",
          },
        ]),
        scanDvd,
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        devicePath: discoveredDevicePath,
        isEnabled: true,
      }),
    ]);
    expect(scanDvd).toHaveBeenCalledWith(
      expect.objectContaining({
        drive: expect.objectContaining({ devicePath: discoveredDevicePath }),
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    access.close();
  });

  it("enables a known Optical Drive when its configured alias appears later", async () => {
    const deviceDirectory = mkdtempSync(join(tmpdir(), "rip-dvd-late-alias-"));
    temporaryDirectories.push(deviceDirectory);
    const canonicalDevicePath = join(deviceDirectory, "sr0");
    const configuredAliasPath = join(deviceDirectory, "dvd");
    writeFileSync(canonicalDevicePath, "");
    const discoveredDevicePath = realpathSync(canonicalDevicePath);
    const access = openTestDataAccess();
    const scanDvd = vi.fn().mockResolvedValue(null);
    const options = {
      access,
      configuredDevicePath: configuredAliasPath,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([
          {
            devicePath: discoveredDevicePath,
            displayName: "Late aliased drive",
            serialNumber: "STABLE-ALIAS-DRIVE",
          },
        ]),
        scanDvd,
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(options);
    const initialDrive = access.catalog.listOpticalDrives()[0]!;
    expect(initialDrive).toMatchObject({
      devicePath: discoveredDevicePath,
      isEnabled: false,
      isPresent: true,
    });
    expect(initialDrive).not.toHaveProperty("configurationDefaultResolved");
    expect(scanDvd).not.toHaveBeenCalled();

    symlinkSync(canonicalDevicePath, configuredAliasPath);
    await pollArchiveWorker(options);
    await pollArchiveWorker(options);

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        id: initialDrive.id,
        devicePath: discoveredDevicePath,
        isEnabled: true,
        isPresent: true,
      }),
    ]);
    expect(scanDvd).toHaveBeenCalledTimes(2);
    expect(scanDvd).toHaveBeenLastCalledWith(
      expect.objectContaining({
        drive: expect.objectContaining({ devicePath: discoveredDevicePath }),
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    access.close();
  });

  it(
    "does not authorize a pre-discovered disabled drive when a configured alias retargets",
    async () => {
      const deviceDirectory = mkdtempSync(
        join(tmpdir(), "rip-dvd-retargeted-alias-"),
      );
      temporaryDirectories.push(deviceDirectory);
      const originalPath = join(deviceDirectory, "sr0");
      const replacementPath = join(deviceDirectory, "sr1");
      const configuredAliasPath = join(deviceDirectory, "dvd");
      writeFileSync(originalPath, "");
      writeFileSync(replacementPath, "");
      symlinkSync(originalPath, configuredAliasPath);
      const originalDevicePath = realpathSync(originalPath);
      const replacementDevicePath = realpathSync(replacementPath);
      const access = openTestDataAccess();
      const discover = vi.fn().mockResolvedValue([
          { devicePath: originalDevicePath, serialNumber: "OLD-001" },
          { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
        ]);
      const scanDvd = vi.fn().mockResolvedValue(null);
      const options = {
        access,
        configuredDevicePath: configuredAliasPath,
        hardware: { ...stableDeviceBinding(), discover, scanDvd },
        log: vi.fn(),
        signal: new AbortController().signal,
      };

      await pollArchiveWorker(options);
      unlinkSync(configuredAliasPath);
      symlinkSync(replacementPath, configuredAliasPath);
      discover.mockResolvedValue([
        { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
      ]);
      await pollArchiveWorker(options);
      await pollArchiveWorker(options);

      expect(access.catalog.listOpticalDrives()).toEqual([
        expect.objectContaining({
          devicePath: originalDevicePath,
          isEnabled: true,
          isPresent: false,
        }),
        expect.objectContaining({
          devicePath: replacementDevicePath,
          isEnabled: false,
          isPresent: true,
        }),
      ]);
      expect(scanDvd).toHaveBeenCalledTimes(1);
      expect(scanDvd).toHaveBeenCalledWith(
        expect.objectContaining({
          drive: expect.objectContaining({ devicePath: originalDevicePath }),
        }),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      access.close();
    },
  );

  it("keeps repeated polls idempotent and marks disappeared drives missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDataAccess();
    const discover = vi.fn().mockResolvedValue([
      {
        devicePath: "/dev/sr0",
        displayName: "Archive drive",
        serialNumber: "ARCHIVE-001",
      },
    ]);
    const scanDvd = vi.fn().mockResolvedValue({
      fingerprint:
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      volumeLabel: "REPEAT_DISC",
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        titles: [
          {
            number: 1,
            durationSeconds: 3_600,
            chapters: 10,
            audioStreams: [{ id: 128, format: "ac3", channels: 2 }],
            subtitles: [],
          },
        ],
      },
    });
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: { ...stableDeviceBinding(), discover, scanDvd },
      log: vi.fn(),
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(options);
    const firstDrive = access.catalog.listOpticalDrives()[0];
    const firstDisc = access.catalog.listDetectedDiscs()[0];
    vi.setSystemTime(new Date("2026-07-26T18:05:00.000Z"));
    await pollArchiveWorker(options);
    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        id: firstDrive.id,
        isPresent: true,
        lastSeenAt: new Date("2026-07-26T18:05:00.000Z"),
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ id: firstDisc.id, status: "scanned" }),
    ]);

    discover.mockResolvedValue([]);
    vi.setSystemTime(new Date("2026-07-26T18:10:00.000Z"));
    await pollArchiveWorker(options);
    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        id: firstDrive.id,
        isPresent: false,
        lastSeenAt: new Date("2026-07-26T18:05:00.000Z"),
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toHaveLength(1);
    access.close();
  });

  it("returns an identical archived disc to bounded history after reinsertion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDataAccess();
    const attachedDrive = [{ devicePath: "/dev/sr0", serialNumber: "DRIVE-1" }];
    const discover = vi.fn().mockResolvedValue(attachedDrive);
    const scanDvd = vi.fn().mockResolvedValue({
      fingerprint:
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      isNewMediumObservation: true,
      volumeLabel: "RETURNING_DISC",
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        titles: [
          {
            number: 1,
            durationSeconds: 3_600,
            chapters: 10,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    });
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: { ...stableDeviceBinding(), discover, scanDvd },
      log: vi.fn(),
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(options);
    const returningDisc = access.catalog.listDetectedDiscs()[0];
    access.catalog.updateDetectedDiscStatus(returningDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: returningDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Returning Disc.iso",
      fingerprint: returningDisc.fingerprint,
    });
    vi.setSystemTime(new Date("2026-07-27T18:00:00.000Z"));
    for (let index = 0; index < 25; index += 1) {
      const terminal = access.catalog.registerDetectedDisc({
        opticalDriveId: returningDisc.opticalDriveId,
        discKind: "dvd",
        fingerprint: `newer-terminal-${index}`,
      });
      access.catalog.updateDetectedDiscStatus(terminal.id, "rejected");
    }
    expect(
      access.catalog.listDetectedDiscs(undefined, {
        policy: {
          mode: "active-and-history",
          activeLimit: 100,
          historyLimit: 20,
        },
      }),
    ).not.toContainEqual(expect.objectContaining({ id: returningDisc.id }));

    vi.setSystemTime(new Date("2026-07-28T18:00:00.000Z"));
    discover.mockResolvedValueOnce([]);
    await pollArchiveWorker(options);
    vi.setSystemTime(new Date("2026-07-29T18:00:00.000Z"));
    discover.mockResolvedValue(attachedDrive);
    await pollArchiveWorker(options);

    expect(
      access.catalog.listDetectedDiscs(undefined, {
        policy: {
          mode: "active-and-history",
          activeLimit: 100,
          historyLimit: 20,
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        id: returningDisc.id,
        status: "archived",
        detectedAt: new Date("2026-07-29T18:00:05.000Z"),
      }),
    );
    expect(access.archiveJobs.list()).toEqual([]);
    access.close();
  });

  it("tolerates empty drives and isolates scanner errors", async () => {
    const access = openTestDataAccess();
    const log = vi.fn();
    const discover = vi.fn().mockResolvedValue([
      {
        devicePath: "/dev/sr0",
        displayName: "Enabled drive",
        serialNumber: "ENABLED-001",
      },
      {
        devicePath: "/dev/sr1",
        displayName: "Disabled drive",
        serialNumber: "DISABLED-002",
      },
    ]);
    const scanDvd = vi.fn().mockResolvedValueOnce(null);
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: { ...stableDeviceBinding(), discover, scanDvd },
      log,
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(options);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(scanDvd).toHaveBeenCalledTimes(1);

    scanDvd.mockRejectedValueOnce(new Error("malformed lsdvd output"));
    await expect(pollArchiveWorker(options)).resolves.toBeUndefined();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: malformed lsdvd output",
    );
    access.close();
  });

  it("does not mark known drives missing when discovery fails", async () => {
    const access = openTestDataAccess();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });

    await expect(
      pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockRejectedValue(new Error("malformed lsblk")),
          scanDvd: vi.fn(),
        },
        log: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("malformed lsblk");

    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({ id: drive.id, isPresent: true }),
    ]);
    access.close();
  });

  it("marks a matching archived fingerprint without queueing duplicate work", async () => {
    const access = openTestDataAccess();
    const sourceDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const sourceDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: sourceDrive.id,
      discKind: "dvd",
      fingerprint:
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      volumeLabel: "ARCHIVED_DISC",
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        titles: [
          {
            number: 1,
            durationSeconds: 4_200,
            chapters: 12,
            audioStreams: [{ id: 128, format: "ac3", channels: 6 }],
            subtitles: [],
          },
        ],
      },
    });
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: sourceDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Archived Disc.iso",
      fingerprint:
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr1",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([
          {
            devicePath: "/dev/sr1",
            displayName: "Second drive",
            serialNumber: "SECOND-001",
          },
        ]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint:
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
          volumeLabel: "ARCHIVED_DISC",
          scanData: {
            schemaVersion: 2,
            contentId:
              "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            titles: [
              {
                number: 1,
                durationSeconds: 4_200,
                chapters: 12,
                audioStreams: [{ id: 128, format: "ac3", channels: 6 }],
                subtitles: [{ id: 32, language: "English" }],
              },
            ],
          },
        }),
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual([
      expect.objectContaining({ id: sourceDisc.id }),
      expect.objectContaining({
        opticalDriveId: access.catalog
          .listOpticalDrives()
          .find((drive) => drive.devicePath === "/dev/sr1")?.id,
        fingerprint:
          "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      }),
    ]);
    expect(access.archiveJobs.list()).toEqual([]);
    access.close();
  });

  it("does not suppress a structurally identical disc with a different content identity", async () => {
    const access = openTestDataAccess();
    const sourceDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const sourceDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: sourceDrive.id,
      discKind: "dvd",
      fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      volumeLabel: "GENERIC_DISC",
    });
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: sourceDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Generic Disc.iso",
      fingerprint: sourceDisc.fingerprint,
    });

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr1",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi
          .fn()
          .mockResolvedValue([
            { devicePath: "/dev/sr1", serialNumber: "SECOND-001" },
          ]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          volumeLabel: "GENERIC_DISC",
          scanData: {
            schemaVersion: 2,
            contentId:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            titles: [
              {
                number: 1,
                durationSeconds: 4_200,
                chapters: 12,
                audioStreams: [{ id: 128, format: "ac3", channels: 6 }],
                subtitles: [],
              },
            ],
          },
        }),
      },
      log: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ id: sourceDisc.id, status: "archived" }),
      expect.objectContaining({
        fingerprint:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "scanned",
      }),
    ]);
    expect(access.archiveJobs.list()).toEqual([]);
    access.close();
  });

  it.each([
    { concurrency: undefined, expectedConcurrency: 1, label: "default" },
    { concurrency: 2, expectedConcurrency: 2, label: "configured" },
  ])(
    "limits concurrent drive work to the $label archive-worker concurrency",
    async ({ concurrency, expectedConcurrency }) => {
      const access = openTestDataAccess();
      const discoveredDrives = Array.from({ length: 3 }, (_, index) => ({
        devicePath: `/dev/sr${index}`,
        serialNumber: `CONCURRENT-${index}`,
      }));
      for (const drive of discoveredDrives) {
        access.catalog.upsertOpticalDrive({
          ...drive,
          isEnabled: true,
          isPresent: true,
        });
      }
      let releaseScans!: () => void;
      const scansMayFinish = new Promise<void>((resolve) => {
        releaseScans = resolve;
      });
      let activeScans = 0;
      let maximumActiveScans = 0;
      const scanDvd = vi.fn(async () => {
        activeScans += 1;
        maximumActiveScans = Math.max(maximumActiveScans, activeScans);
        await scansMayFinish;
        activeScans -= 1;
        return null;
      });
      for (const drive of access.catalog.listOpticalDrives()) {
        beginNearlySettledDiscInspection(access, {
          opticalDriveId: drive.id,
          mediaGeneration: "test-media-generation",
          mediaCapacityBytes: 2_048,
        });
      }
      const polling = pollArchiveWorkerOnce({
        access,
        ...(concurrency === undefined ? {} : { concurrency }),
        configuredDevicePath: "/dev/sr0",
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockResolvedValue(discoveredDrives),
          scanDvd,
        },
        log: vi.fn(),
        signal: new AbortController().signal,
      });

      try {
        await vi.waitFor(() =>
          expect(scanDvd).toHaveBeenCalledTimes(expectedConcurrency),
        );
        expect(maximumActiveScans).toBe(expectedConcurrency);
      } finally {
        releaseScans();
        try {
          await polling;
        } finally {
          access.close();
        }
      }

      expect(scanDvd).toHaveBeenCalledTimes(3);
      expect(maximumActiveScans).toBe(expectedConcurrency);
    },
  );

  it("cancels an in-flight scan and stops polling during shutdown", async () => {
    const access = openTestDataAccess();
    const controller = new AbortController();
    const drive = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "CANCEL-001",
        isConfiguredDevice: true,
      },
    ])[0]!;
    beginNearlySettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: 2_048,
    });
    const scanDvd = vi.fn(
      async (_binding: unknown, signal: AbortSignal) => {
        controller.abort(new Error("worker shutdown"));
        signal.throwIfAborted();
        return null;
      },
    );
    const waitForNextPoll = vi.fn(
      async (_intervalMs: number, signal: AbortSignal) => {
        if (signal.aborted) {
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    await expect(
      runArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware: {
          ...stableDeviceBinding(),
          discover: vi
            .fn()
            .mockResolvedValue([
              { devicePath: "/dev/sr0", serialNumber: "CANCEL-001" },
            ]),
          scanDvd,
        },
        log: vi.fn(),
        pollIntervalMs: 5_000,
        signal: controller.signal,
        waitForNextPoll,
      }),
    ).resolves.toBeUndefined();

    expect(scanDvd).toHaveBeenCalledTimes(1);
    expect(waitForNextPoll).toHaveBeenCalledTimes(1);
    access.close();
  });
});
