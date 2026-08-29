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
  DISC_INSPECTION_SETTLING_TIMEOUT_MS,
  archiveBoundaryEvidenceFromRecord,
  type DiscInspectionId,
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  type ArchiveReadFailureCategory,
  type DiscoveredOpticalDrive,
  type DvdSalvageRejectionReason,
} from "@rip-dvd/data-access";
import { createRawDvdContentIdHasher } from "@rip-dvd/data-access/dvd-content-id";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import {
  beginSettledDiscInspectionForTest,
} from "@rip-dvd/data-access/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker as pollArchiveWorkerWithDefaults,
  runArchiveWorker as runArchiveWorkerWithDefaults,
  type PollArchiveWorkerOptions,
  type RunArchiveWorkerOptions,
  type OpticalDriveHardware,
} from "./archive-worker.js";
import {
  preserveDvdArchive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";
import type { DvdCompletenessProver } from "./dvd-completeness-prover.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
  DvdReadFailureError,
  type NonBoundaryDvdReadFailureResult,
  type UnknownDvdReadFailureResult,
} from "./dvd-recovery-contracts.js";
import {
  createOutOfRangeDvdReadFailure,
  createOutOfRangeDvdReadFailureResult,
} from "./dvd-read-failure.test-support.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";
import {
  createInProcessDvdRescueWorkspaceLock,
  type DvdRescueWorkspaceLock,
} from "./dvd-rescue-workspace-lock.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import {
  createLinuxOpticalDriveHardware,
  createNodeMediaGenerationObserver,
  type CommandResult,
  type CommandRunner,
  type MediaGenerationObserver,
  type MediaGenerationProbeLauncher,
} from "./optical-drive-hardware.js";

const temporaryDirectories: string[] = [];
const testRescueWorkspaceLock = createInProcessDvdRescueWorkspaceLock();
const supportsLinuxWriterOwnership = existsSync("/proc/self/fd");

type DvdReadFailureCategory = NonBoundaryDvdReadFailureResult["category"];

const readinessReadFailureCases = [
  {
    category: "not_ready",
    senseResponseCode: 0x70,
    senseKey: 0x02,
    asc: 0x04,
    ascq: 0x01,
  },
  {
    category: "unit_attention",
    senseResponseCode: 0x72,
    senseKey: 0x06,
    asc: 0x28,
    ascq: 0x00,
  },
] as const;

const terminalReadFailureCategories = [
  "unknown",
  "not_ready",
  "unit_attention",
  "hardware_error",
  "transport_error",
  "protection_error",
] as const satisfies readonly ArchiveReadFailureCategory[];

function dvdReadFailure(
  categoryOrOverrides:
    | DvdReadFailureCategory
    | Partial<NonBoundaryDvdReadFailureResult> = "unknown",
  overrides: Partial<NonBoundaryDvdReadFailureResult> = {},
) {
  const category = typeof categoryOrOverrides === "string"
    ? categoryOrOverrides
    : categoryOrOverrides.category ?? "unknown";
  const mergedOverrides = typeof categoryOrOverrides === "string"
    ? overrides
    : categoryOrOverrides;
  const decoded = category === "not_ready"
    ? { senseResponseCode: 0x70, senseKey: 0x02, asc: 0x04, ascq: 0x01 }
    : category === "unit_attention"
      ? { senseResponseCode: 0x72, senseKey: 0x06, asc: 0x28, ascq: 0x00 }
      : category === "hardware_error"
        ? { senseResponseCode: 0x70, senseKey: 0x04, asc: 0x44, ascq: 0x00 }
        : category === "transport_error"
          ? {
              senseResponseCode: 0x70,
              senseKey: 0x03,
              asc: 0x11,
              ascq: 0x00,
              hostStatus: 0x07,
              driverStatus: 0,
            }
          : category === "protection_error"
            ? {
                senseResponseCode: 0x72,
                senseKey: 0x05,
                asc: 0x6f,
                ascq: 0x04,
              }
            : {
                senseResponseCode: 0x70,
                senseKey: 0x05,
                asc: 0x20,
                ascq: 0x00,
              };
  return new DvdReadFailureError({
    protocolVersion: 1,
    classifierVersion: "scsi-read-classifier-v2",
    category,
    scsiStatus: 2,
    hostStatus: 0,
    driverStatus: 8,
    ...decoded,
    informationLba: 1,
    requestedLba: 0,
    requestedBlockCount: 4,
    retryOrdinal: 2,
    ...mergedOverrides,
  });
}

function unknownDvdReadFailure(
  overrides: Partial<UnknownDvdReadFailureResult> = {},
) {
  return dvdReadFailure("unknown", overrides);
}

const dvdReadFailureCases = [
  {
    category: "unknown",
    evidence: {
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 0x70,
      senseKey: 5,
      asc: 32,
      ascq: 0,
    },
  },
  {
    category: "hardware_error",
    evidence: {
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 0x70,
      senseKey: 4,
      asc: 68,
      ascq: 0,
    },
  },
  {
    category: "transport_error",
    evidence: {
      scsiStatus: 2,
      hostStatus: 7,
      driverStatus: 0,
      senseResponseCode: 0x70,
      senseKey: 3,
      asc: 17,
      ascq: 0,
    },
  },
  {
    category: "protection_error",
    evidence: {
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 0x72,
      senseKey: 5,
      asc: 111,
      ascq: 4,
    },
  },
] as const satisfies readonly {
  category: ArchiveReadFailureCategory;
  evidence: Partial<ConstructorParameters<typeof DvdReadFailureError>[0]>;
}[];

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
  const startedAt = Date.now();
  let elapsedMs = 0;
  try {
    await pollArchiveWorkerOnce({
      ...options,
      waitForNextSettlingObservation:
        options.waitForNextSettlingObservation ??
        (async (intervalMs, signal) => {
          signal.throwIfAborted();
          elapsedMs += intervalMs;
          vi.setSystemTime(new Date(startedAt + elapsedMs));
        }),
    });
  } finally {
    if (alreadyUsingFakeTimers) {
      vi.setSystemTime(new Date(startedAt));
    } else {
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

function openTestDataAccess(originalsLibraryPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-worker-"));
  temporaryDirectories.push(directory);
  return createLegacySidecarDataAccess({
    databasePath: join(directory, "rip-dvd.sqlite"),
    ...(originalsLibraryPath === undefined
      ? {}
      : { originalsLibraryPath }),
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

interface SimulatedLinuxOpticalDrive extends DiscoveredOpticalDrive {
  transport?: string;
}

function createLinuxSettlingHardware({
  capacityResult,
  deviceInstanceObserver,
  drives,
  mediaGeneration,
  mediaGenerationObserver,
}: {
  capacityResult(
    devicePath: string,
    signal: AbortSignal,
  ): CommandResult | Promise<CommandResult>;
  deviceInstanceObserver?: MediaGenerationObserver;
  drives(): readonly SimulatedLinuxOpticalDrive[];
  mediaGeneration: string | (() => string);
  mediaGenerationObserver?: MediaGenerationObserver;
}) {
  const runner: CommandRunner = {
    run: vi.fn(async (executable, arguments_, options) => {
      if (executable === "lsblk") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            blockdevices: drives().map((drive) => ({
              path: drive.devicePath,
              type: "rom",
              tran: drive.transport,
              vendor: drive.vendor,
              model: drive.product,
              serial: drive.serialNumber,
            })),
          }),
          stderr: "",
        };
      }
      if (executable === "blockdev") {
        return await capacityResult(arguments_[1]!, options.signal);
      }
      throw new Error(`Unexpected command: ${executable}`);
    }),
  };
  return {
    hardware: createLinuxOpticalDriveHardware({
      deviceInstanceObserver: deviceInstanceObserver ?? {
        observe: vi.fn(async (devicePath) => `${devicePath}-instance`),
      },
      mediaGenerationObserver: mediaGenerationObserver ?? {
        observe: vi.fn(async () =>
          typeof mediaGeneration === "function"
            ? mediaGeneration()
            : mediaGeneration
        ),
      },
      platform: "linux",
      runner,
    }),
    runner,
  };
}

function beginSettledDiscInspection(
  access: ReturnType<typeof openTestDataAccess>,
  input: Parameters<
    ReturnType<typeof openTestDataAccess>["discInspections"]["beginOrResume"]
  >[0],
) {
  return beginSettledDiscInspectionForTest(access, input);
}

function createControlledSettlingWaits() {
  const pending: Array<{ release(): void }> = [];
  const wait = vi.fn(
    async (_intervalMs: number, signal: AbortSignal) =>
      await new Promise<void>((resolve, reject) => {
        const entry = {
          release() {
            const index = pending.indexOf(entry);
            if (index !== -1) {
              pending.splice(index, 1);
            }
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          const index = pending.indexOf(entry);
          if (index !== -1) {
            pending.splice(index, 1);
          }
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.push(entry);
      }),
  );
  return {
    wait,
    async waitUntilPending(count = 1) {
      await vi.waitFor(() => expect(pending).toHaveLength(count));
    },
    releaseNext(elapsedMs = 2_500) {
      const next = pending[0];
      if (next === undefined) {
        throw new Error("No settling wait is pending");
      }
      vi.setSystemTime(new Date(Date.now() + elapsedMs));
      next.release();
    },
  };
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
    discoveredDrive,
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

type WatchabilityWorkerScenario = Awaited<
  ReturnType<typeof exerciseWatchabilityWorkerScenario>
>;

async function prepareMatchingOpticalDriveRescueContinuation(
  scenario: WatchabilityWorkerScenario,
  {
    displayName,
    serialNumber,
    workerId,
  }: {
    displayName: string;
    serialNumber: string;
    workerId: string;
  },
) {
  const discoveredDrive = {
    devicePath: "/dev/sr1",
    displayName,
    serialNumber,
  };
  const opticalDrive = scenario.access.catalog.upsertOpticalDrive({
    ...discoveredDrive,
    isEnabled: true,
    isPresent: true,
  });
  const scanOnlyCopy = vi.fn();
  const hardware: OpticalDriveHardware = {
    ...stableDeviceBinding(),
    discover: vi.fn().mockResolvedValue([discoveredDrive]),
    scanDvd: vi.fn().mockResolvedValue({
      fingerprint: scenario.fingerprint,
      scanData: scenario.scanData,
      sizeBytes: scenario.sizeBytes,
    }),
  };

  await pollArchiveWorker({
    access: scenario.access,
    configuredDevicePath: "/dev/sr0",
    copyRunner: {
      copy: scanOnlyCopy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    },
    hardware,
    log: vi.fn(),
    originalsLibraryPath: scenario.originalsLibraryPath,
    rescueWorkspaceLock: createInProcessDvdRescueWorkspaceLock(),
    signal: new AbortController().signal,
    workerId,
  });

  const detectedDisc = scenario.access.catalog.listDetectedDiscs()
    .find(({ opticalDriveId }) => opticalDriveId === opticalDrive.id)!;
  const archiveRequest = scenario.access.archiveRequests.create({
    detectedDiscId: detectedDisc.id,
  });
  return {
    archiveRequest,
    detectedDisc,
    discoveredDrive,
    hardware,
    scanOnlyCopy,
  };
}

async function exerciseReadFailureFence({
  beforeFailure,
  beforeReadFailurePersistence,
  expectedPollError,
  observeMediaGeneration,
  rescueWorkspaceLock,
  readFailure = unknownDvdReadFailure(),
  signal = new AbortController().signal,
}: {
  beforeFailure?: (
    access: ReturnType<typeof openTestDataAccess>,
    requestId: ReturnType<
      ReturnType<typeof openTestDataAccess>["archiveRequests"]["create"]
    >["id"],
  ) => void;
  beforeReadFailurePersistence?: (
    access: ReturnType<typeof openTestDataAccess>,
    requestId: ReturnType<
      ReturnType<typeof openTestDataAccess>["archiveRequests"]["create"]
    >["id"],
  ) => void;
  expectedPollError?: Error;
  observeMediaGeneration?: () => Promise<string>;
  rescueWorkspaceLock?: DvdRescueWorkspaceLock;
  readFailure?: DvdReadFailureError;
  signal?: AbortSignal;
} = {}) {
  const access = openTestDataAccess();
  const originalsLibraryPath = mkdtempSync(
    join(tmpdir(), "rip-dvd-originals-read-fence-"),
  );
  temporaryDirectories.push(originalsLibraryPath);
  const fingerprint = `dvdmeta-sha256:${"3".repeat(64)}`;
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
    vendor: "Pioneer",
    product: "DVD-RW",
    serialNumber: "READ-FENCE-001",
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
  const binding = stableDeviceBinding();
  const log = vi.fn();
  const copyRunner: DvdCopyRunner = {
    copy: vi.fn(async ({ authorizeStart }) => {
      await authorizeStart?.();
      beforeFailure?.(access, request.id);
      throw readFailure;
    }),
    isActive: () => false,
    withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
    waitForInactive: vi.fn(async () => undefined),
  };
  if (beforeReadFailurePersistence !== undefined) {
    const persistReadFailure =
      access.archiveJobs.failWithReadFailure.bind(access.archiveJobs);
    vi.spyOn(access.archiveJobs, "failWithReadFailure").mockImplementation(
      (claim, evidence) => {
        beforeReadFailurePersistence(access, request.id);
        return persistReadFailure(claim, evidence);
      },
    );
  }

  let pollError: unknown;
  try {
    await pollArchiveWorker({
      access,
      configuredDevicePath: discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...binding,
        ...(observeMediaGeneration === undefined
          ? {}
          : { observeMediaGeneration }),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes: 4 * 2_048,
        }),
      },
      log,
      originalsLibraryPath,
      ...(rescueWorkspaceLock === undefined ? {} : { rescueWorkspaceLock }),
      signal,
      workerId: "archive-worker-read-fence",
    });
  } catch (error) {
    pollError = error;
  }
  if (expectedPollError === undefined) {
    if (pollError !== undefined) {
      throw pollError;
    }
  } else if (pollError !== expectedPollError) {
    throw new Error("Archive worker did not propagate the expected failure");
  }

  return { access, log, originalsLibraryPath, request };
}

async function exerciseReadinessResume(
  failureCase: (typeof readinessReadFailureCases)[number],
  sourceChanges: boolean,
) {
  const scenario = await exerciseWatchabilityWorkerScenario({
    ranges: [{ startLba: 1, sectorCount: 1 }],
    validation: { outcome: "rejected", reason: "referenced_content" },
  });
  scenario.access.archiveRequests.retry(scenario.request.id);
  let failureObserved = false;
  const copyRunner: DvdCopyRunner = {
    copy: vi.fn(async ({ authorizeStart, continuation }) => {
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: createDamagedDvdRecoveryResult(scenario.sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]),
      });
      await authorizeStart?.();
      failureObserved = true;
      throw dvdReadFailure(failureCase.category, {
        informationLba: null,
        requestedLba: 1,
        requestedBlockCount: 1,
        retryOrdinal: 0,
        senseResponseCode: failureCase.senseResponseCode,
        senseKey: failureCase.senseKey,
        asc: failureCase.asc,
        ascq: failureCase.ascq,
      });
    }),
    isActive: () => false,
    withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
    waitForInactive: vi.fn(async () => undefined),
  };
  const salvageValidator = { validate: vi.fn() };

  await pollArchiveWorker({
    access: scenario.access,
    configuredDevicePath: scenario.discoveredDrive.devicePath,
    copyRunner,
    hardware: {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([scenario.discoveredDrive]),
      observeMediaGeneration: vi.fn(async () =>
        sourceChanges && failureObserved
          ? "replacement-media-generation"
          : "test-media-generation"
      ),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint: scenario.fingerprint,
        scanData: scenario.scanData,
        sizeBytes: scenario.sizeBytes,
      }),
    },
    log: vi.fn(),
    originalsLibraryPath: scenario.originalsLibraryPath,
    salvageValidator,
    signal: new AbortController().signal,
    workerId: `archive-worker-${failureCase.category}-resumed-read`,
  });

  return { copyRunner, salvageValidator, scenario };
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
    const completenessProver = { prove: vi.fn() };

    await pollArchiveWorker({
      access,
      completenessProver,
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
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 9,
      boundaryPublishedSizeBytes: 9,
      boundaryExcludedSectorCount: 0,
      integrity: "clean_read",
      integrityPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(readFileSync(archive.archivePath, "utf8")).toBe("dvd-image");
    expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    expect(completenessProver.prove).not.toHaveBeenCalled();
  });

  it.each(dvdReadFailureCases)("persists one $category diagnosis for the initial Archive Job attempt", async ({
    category,
    evidence,
  }) => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), `rip-dvd-originals-${category}-`),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"2".repeat(64)}`;
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
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: `READ-FAILURE-${category}`,
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
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart }) => {
        await authorizeStart?.();
        throw dvdReadFailure({ category, ...evidence });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access,
      configuredDevicePath: discoveredDrive.devicePath,
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
      workerId: `archive-worker-${category}`,
    });

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        originalDiscArchiveId: null,
        readFailureStage: "initial_copy",
        readFailureCategory: category,
        readFailureClassifierVersion: "scsi-read-classifier-v2",
        readFailureLba: 1,
        readFailureRequestedBlockCount: 4,
        readFailureRetryCount: 2,
        readFailureScsiStatus: evidence.scsiStatus,
        readFailureHostStatus: evidence.hostStatus,
        readFailureDriverStatus: evidence.driverStatus,
        readFailureSenseKey: evidence.senseKey,
        readFailureAsc: evidence.asc,
        readFailureAscq: evidence.ascq,
      }),
    ]);
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    expect(readdirSync(originalsLibraryPath)).toEqual([]);
  });

  it.each(readinessReadFailureCases)(
    "persists a stable $category diagnosis for the initial Archive Job attempt",
    async (failureCase) => {
      const scenario = await exerciseReadFailureFence({
        readFailure: dvdReadFailure(failureCase.category, {
          informationLba: null,
          requestedLba: 1,
          requestedBlockCount: 1,
          retryOrdinal: 0,
          senseResponseCode: failureCase.senseResponseCode,
          senseKey: failureCase.senseKey,
          asc: failureCase.asc,
          ascq: failureCase.ascq,
        }),
      });

      expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
        expect.objectContaining({
          archiveRequestId: scenario.request.id,
          originalDiscArchiveId: null,
          readFailureStage: "initial_copy",
          readFailureCategory: failureCase.category,
          readFailureLba: 1,
          readFailureRequestedBlockCount: 1,
          readFailureRetryCount: 0,
          readFailureSenseKey: failureCase.senseKey,
          readFailureAsc: failureCase.asc,
          readFailureAscq: failureCase.ascq,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["needs_attention"]))
        .toEqual([expect.objectContaining({ id: scenario.request.id })]);
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it("retains an out-of-range prefix and records a boundary diagnosis", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-out-of-range-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"6".repeat(64)}`;
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
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "OUT-OF-RANGE-001",
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
    const retainedPrefix = Buffer.alloc(2 * 2_048, 47);
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeProbe, authorizeStart, outputPath }) => {
        await authorizeStart?.();
        await authorizeProbe?.();
        await authorizeProbe?.();
        writeFileSync(outputPath, retainedPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access,
      configuredDevicePath: discoveredDrive.devicePath,
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
      workerId: "archive-worker-out-of-range",
    });

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        originalDiscArchiveId: null,
        readFailureStage: "initial_copy",
        readFailureCategory: "out_of_range",
        readFailureClassifierVersion: "scsi-read-classifier-v2",
        readFailureLba: 2,
        readFailureRequestedBlockCount: 4,
        readFailureRetryCount: 0,
        readFailureScsiStatus: 2,
        readFailureHostStatus: 0,
        readFailureDriverStatus: 8,
        readFailureSenseKey: 5,
        readFailureAsc: 33,
        readFailureAscq: 0,
      }),
    ]);
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    expect(readFileSync(rescuePaths.imagePath)).toEqual(retainedPrefix);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      declaredByteCount: sizeBytes,
      imageByteCount: retainedPrefix.byteLength,
      recoveryProtocol: null,
      boundaryFailureProtocol: expect.objectContaining({
        category: "out_of_range",
        declaredByteCount: sizeBytes,
        firstFailingLba: 2,
      }),
    });

    access.archiveRequests.retry(request.id);
    const extendedPrefix = Buffer.concat([
      retainedPrefix,
      Buffer.alloc(2_048, 53),
    ]);
    const retryCopyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart, continuation, outputPath }) => {
        expect(continuation).toMatchObject({
          kind: "boundary",
          imageByteCount: retainedPrefix.byteLength,
        });
        await authorizeStart?.();
        writeFileSync(outputPath, extendedPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 3,
          requestedBlockCount: 2,
          requestedLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    await pollArchiveWorker({
      access,
      configuredDevicePath: discoveredDrive.devicePath,
      copyRunner: retryCopyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({ fingerprint, scanData, sizeBytes }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: "archive-worker-out-of-range-retry",
    });
    expect(
      access.archiveJobs.list(["failed"])
        .find(({ attemptOrdinal }) => attemptOrdinal === 2),
    ).toMatchObject({
      archiveRequestId: request.id,
      readFailureStage: "rescue_resume",
      readFailureCategory: "out_of_range",
      readFailureLba: 3,
    });
    expect(readFileSync(rescuePaths.imagePath)).toEqual(extendedPrefix);
  });

  it("publishes a clean retained prefix only after both boundary proofs agree", async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-corrected-boundary-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const access = openTestDataAccess(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"7".repeat(64)}`;
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
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "CORRECTED-BOUNDARY-001",
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
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 47);
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const prove = vi.fn<DvdCompletenessProver["prove"]>(async (proof) => {
      expect(proof.candidateBoundaryLba).toBe(firstExcludedLba);
      expect(proof.expectedTitleMap).toEqual(scanData);
      expect(readFileSync(proof.imagePath)).toEqual(retainedPrefix);
      return { maximumReferencedLba: firstExcludedLba - 1 };
    });
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access,
      completenessProver: { prove },
      configuredDevicePath: discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes: reportedSizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: "archive-worker-corrected-boundary",
    });

    expect(prove).toHaveBeenCalledOnce();
    expect(access.archiveJobs.list(["completed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        originalDiscArchiveId: expect.any(String),
        status: "completed",
      }),
    ]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      sizeBytes: retainedPrefix.byteLength,
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: reportedSizeBytes,
      boundaryPublishedSizeBytes: retainedPrefix.byteLength,
      boundaryExcludedSectorCount: 2,
      boundaryFirstExcludedLba: firstExcludedLba,
      boundaryMaximumReferencedLba: firstExcludedLba - 1,
      boundaryReadFailureClassifierVersion: "scsi-read-classifier-v2",
      boundaryReadFailureScsiStatus: 2,
      boundaryReadFailureHostStatus: 0,
      boundaryReadFailureDriverStatus: 8,
      boundaryReadFailureSenseResponseCode: 0x70,
      boundaryReadFailureSenseKey: 0x05,
      boundaryReadFailureAsc: 0x21,
      boundaryReadFailureAscq: 0,
      integrity: "clean_read",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(readFileSync(archive.archivePath)).toEqual(retainedPrefix);
    expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
    const catalogProjection = access.catalog.listCatalogReviewArchives({
      view: "needs_review",
      limit: 10,
    })[0]!;
    expect(archiveBoundaryEvidenceFromRecord(catalogProjection)).toMatchObject({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes,
      publishedSizeBytes: retainedPrefix.byteLength,
      excludedSectorCount: 2,
      firstExcludedLba,
      maximumReferencedLba: firstExcludedLba - 1,
    });
    const verifiedArchive =
      await access.filesystemVerification.verifyOriginalDiscArchive(archive.id);
    expect(verifiedArchive).toMatchObject({
      sizeBytes: retainedPrefix.byteLength,
      verificationStatus: "accessible",
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Corrected boundary integration",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "corrected-boundary-integration",
      displayName: "Corrected boundary integration",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    const encodeJob = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: join(originalsLibraryPath, "corrected-boundary.mkv"),
    });
    const encodeSource = access.readConsistentSnapshot((snapshot) => {
      const admittedSelection = snapshot.catalog.listDiscSelections({
        ids: [encodeJob.discSelectionId],
        encodeEligibleOnly: true,
      })[0]!;
      return snapshot.catalog.listOriginalDiscArchives({
        ids: [admittedSelection.originalDiscArchiveId],
      })[0]!;
    });
    expect(encodeSource).toMatchObject({
      archivePath: archive.archivePath,
      sizeBytes: retainedPrefix.byteLength,
    });
    expect(readFileSync(encodeSource.archivePath).byteLength)
      .toBe(encodeSource.sizeBytes);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("publishes only genuine retained damage after accepting a legacy rescue boundary", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 7, sectorCount: 1 },
      ],
      validation: { outcome: "rejected", reason: "policy_limit" },
    });
    scenario.access.archiveRequests.retry(scenario.request.id);
    const firstExcludedLba = 6;
    const publishedSizeBytes = firstExcludedLba * 2_048;
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: scenario.sizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const retainedRecovery = createDamagedDvdRecoveryResult(
      scenario.sizeBytes,
      [{ startLba: 1, sectorCount: 1 }],
    );
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: createDamagedDvdRecoveryResult(
            scenario.sizeBytes,
            [
              { startLba: 1, sectorCount: 1 },
              { startLba: 7, sectorCount: 1 },
            ],
          ),
        });
        throw new DvdReadFailureError(boundaryFailure, retainedRecovery);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const prove = vi.fn<DvdCompletenessProver["prove"]>(async ({
      candidateBoundaryLba,
      imagePath,
    }) => {
      expect(candidateBoundaryLba).toBe(firstExcludedLba);
      expect(readFileSync(imagePath)).toEqual(scenario.rescuedImage);
      return { maximumReferencedLba: firstExcludedLba - 1 };
    });
    const salvageValidator = {
      validate: vi.fn(async ({ imagePath, recoveryResult }) => {
        expect(readFileSync(imagePath)).toEqual(
          scenario.rescuedImage.subarray(0, publishedSizeBytes),
        );
        expect(recoveryResult).toEqual(
          createDamagedDvdRecoveryResult(publishedSizeBytes, [
            { startLba: 1, sectorCount: 1 },
          ]),
        );
        return {
          badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
          outcome: "accepted" as const,
        };
      }),
    };

    await pollArchiveWorker({
      access: scenario.access,
      completenessProver: { prove },
      configuredDevicePath: scenario.discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([scenario.discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint: scenario.fingerprint,
          scanData: scenario.scanData,
          sizeBytes: scenario.sizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath: scenario.originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: "archive-worker-corrected-salvage",
    });

    expect(prove).toHaveBeenCalledOnce();
    expect(salvageValidator.validate).toHaveBeenCalledOnce();
    expect(scenario.access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    const archive = scenario.access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      sizeBytes: publishedSizeBytes,
      boundaryReportedSizeBytes: scenario.sizeBytes,
      boundaryPublishedSizeBytes: publishedSizeBytes,
      boundaryExcludedSectorCount:
        scenario.sizeBytes / 2_048 - firstExcludedLba,
      boundaryFirstExcludedLba: firstExcludedLba,
      integrity: "watchable_salvage",
      badSectorCount: 1,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 1, sectorCount: 1 }],
      badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
    });
    expect(readFileSync(archive.archivePath)).toEqual(
      scenario.rescuedImage.subarray(0, publishedSizeBytes),
    );
  });

  it("preserves legacy suffix damage when boundary proof fails", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 7, sectorCount: 1 },
      ],
      validation: { outcome: "rejected", reason: "policy_limit" },
    });
    scenario.access.archiveRequests.retry(scenario.request.id);
    const firstExcludedLba = 6;
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: scenario.sizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const retainedRecovery = createDamagedDvdRecoveryResult(
      scenario.sizeBytes,
      [{ startLba: 1, sectorCount: 1 }],
    );
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(scenario.originalsLibraryPath),
      scenario.request.id,
    );
    const rescueMapBeforeProof = readFileSync(rescuePaths.mapPath, "utf8");
    const proofFailure = new Error(
      "DVD completeness proof rejected the legacy rescue boundary",
    );

    await pollArchiveWorker({
      access: scenario.access,
      completenessProver: {
        prove: vi.fn().mockRejectedValue(proofFailure),
      },
      configuredDevicePath: scenario.discoveredDrive.devicePath,
      copyRunner: {
        copy: vi.fn(async ({ continuation }) => {
          expect(continuation).toMatchObject({
            kind: "damaged",
            recoveryResult: createDamagedDvdRecoveryResult(
              scenario.sizeBytes,
              [
                { startLba: 1, sectorCount: 1 },
                { startLba: 7, sectorCount: 1 },
              ],
            ),
          });
          throw new DvdReadFailureError(boundaryFailure, retainedRecovery);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([scenario.discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint: scenario.fingerprint,
          scanData: scenario.scanData,
          sizeBytes: scenario.sizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath: scenario.originalsLibraryPath,
      salvageValidator: { validate: vi.fn() },
      signal: new AbortController().signal,
      workerId: "archive-worker-rejected-legacy-boundary",
    });

    expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(scenario.access.archiveJobs.list(["failed"]))
      .toContainEqual(expect.objectContaining({
        archiveRequestId: scenario.request.id,
        errorMessage: proofFailure.message,
        originalDiscArchiveId: null,
      }));
    expect(readFileSync(rescuePaths.imagePath)).toEqual(scenario.rescuedImage);
    expect(readFileSync(rescuePaths.mapPath, "utf8"))
      .toBe(rescueMapBeforeProof);
  });

  it("publishes clean when legacy prefix damage recovers before the boundary", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 7, sectorCount: 1 },
      ],
      validation: { outcome: "rejected", reason: "policy_limit" },
    });
    scenario.access.archiveRequests.retry(scenario.request.id);
    const firstExcludedLba = 6;
    const publishedSizeBytes = firstExcludedLba * 2_048;
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: scenario.sizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation }) => {
        expect(continuation).toMatchObject({ kind: "damaged" });
        throw new DvdReadFailureError(
          boundaryFailure,
          createCleanDvdRecoveryResult(scenario.sizeBytes),
        );
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access: scenario.access,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      configuredDevicePath: scenario.discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([scenario.discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint: scenario.fingerprint,
          scanData: scenario.scanData,
          sizeBytes: scenario.sizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath: scenario.originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: "archive-worker-corrected-clean-recovery",
    });

    expect(salvageValidator.validate).not.toHaveBeenCalled();
    const archive = scenario.access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      sizeBytes: publishedSizeBytes,
      boundaryReportedSizeBytes: scenario.sizeBytes,
      boundaryPublishedSizeBytes: publishedSizeBytes,
      integrity: "clean_read",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    });
    expect(readFileSync(archive.archivePath)).toEqual(
      scenario.rescuedImage.subarray(0, publishedSizeBytes),
    );
  });

  it("keeps a proven boundary prefix retryable when completeness proof fails", async () => {
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-originals-rejected-boundary-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const fingerprint = `dvdmeta-sha256:${"8".repeat(64)}`;
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
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "REJECTED-BOUNDARY-001",
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
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 53);
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const proofFailure = new Error(
      "DVD completeness proof found a referenced extent past the boundary",
    );

    await pollArchiveWorker({
      access,
      completenessProver: {
        prove: vi.fn().mockRejectedValue(proofFailure),
      },
      configuredDevicePath: discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes: reportedSizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      salvageValidator: { validate: vi.fn() },
      signal: new AbortController().signal,
      workerId: "archive-worker-rejected-boundary",
    });

    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: request.id,
        errorMessage: proofFailure.message,
        originalDiscArchiveId: null,
        readFailureCategory: null,
      }),
    ]);
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    expect(readFileSync(rescuePaths.imagePath)).toEqual(retainedPrefix);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
      .toMatchObject({
        boundaryFailureProtocol: expect.objectContaining({
          boundaryProofVersion: "dvd-sector-boundary-proof-v1",
          firstFailingLba: firstExcludedLba,
        }),
      });
    expect(access.archiveRequests.retry(request.id)).toMatchObject({
      id: request.id,
      status: "pending",
    });
  });

  it("persists boundary evidence when prefix retention itself fails", async () => {
    const sizeBytes = 4 * 2_048;
    const scenario = await exerciseReadFailureFence({
      readFailure: createOutOfRangeDvdReadFailure({
        declaredByteCount: sizeBytes,
        firstFailingLba: 2,
      }),
    });

    expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        archiveRequestId: scenario.request.id,
        readFailureStage: "initial_copy",
        readFailureCategory: "out_of_range",
        readFailureLba: 2,
        readFailureSenseKey: 5,
        readFailureAsc: 33,
        readFailureAscq: 0,
      }),
    ]);
    expect(scenario.access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(scenario.originalsLibraryPath),
      scenario.request.id,
    );
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
  });

  it.each(dvdReadFailureCases)("records $category on only the resumed Archive Job attempt", async ({
    category,
    evidence,
  }) => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: { outcome: "rejected", reason: "referenced_content" },
    });
    scenario.access.archiveRequests.retry(scenario.request.id);
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ authorizeStart, continuation }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: createDamagedDvdRecoveryResult(scenario.sizeBytes, [
            { startLba: 1, sectorCount: 1 },
          ]),
        });
        await authorizeStart?.();
        throw dvdReadFailure({
          category,
          ...evidence,
          informationLba: null,
          requestedLba: 1,
          requestedBlockCount: 1,
          retryOrdinal: 3,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = { validate: vi.fn() };

    await pollArchiveWorker({
      access: scenario.access,
      configuredDevicePath: scenario.discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([scenario.discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint: scenario.fingerprint,
          scanData: scenario.scanData,
          sizeBytes: scenario.sizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath: scenario.originalsLibraryPath,
      salvageValidator,
      signal: new AbortController().signal,
      workerId: `archive-worker-${category}-resumed-read`,
    });

    expect(copyRunner.copy).toHaveBeenCalledOnce();
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    const failedAttempts = scenario.access.archiveJobs.list(["failed"]);
    expect(failedAttempts).toHaveLength(2);
    expect(failedAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attemptOrdinal: 1,
        readFailureCategory: null,
      }),
      expect.objectContaining({
        attemptOrdinal: 2,
        readFailureStage: "rescue_resume",
        readFailureCategory: category,
        readFailureLba: 1,
        readFailureRequestedBlockCount: 1,
        readFailureRetryCount: 3,
        readFailureScsiStatus: evidence.scsiStatus,
        readFailureHostStatus: evidence.hostStatus,
        readFailureDriverStatus: evidence.driverStatus,
        readFailureSenseKey: evidence.senseKey,
        readFailureAsc: evidence.asc,
        readFailureAscq: evidence.ascq,
      }),
    ]));
    expect(scenario.access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
  });

  it.each(readinessReadFailureCases)(
    "persists a stable $category diagnosis during rescue resume",
    async (failureCase) => {
      const { copyRunner, salvageValidator, scenario } =
        await exerciseReadinessResume(failureCase, false);

      expect(copyRunner.copy).toHaveBeenCalledOnce();
      expect(salvageValidator.validate).not.toHaveBeenCalled();
      expect(scenario.access.archiveJobs.list(["failed"])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptOrdinal: 1,
            readFailureCategory: null,
          }),
          expect.objectContaining({
            attemptOrdinal: 2,
            readFailureStage: "rescue_resume",
            readFailureCategory: failureCase.category,
            readFailureLba: 1,
            readFailureRequestedBlockCount: 1,
            readFailureRetryCount: 0,
            readFailureSenseKey: failureCase.senseKey,
            readFailureAsc: failureCase.asc,
            readFailureAscq: failureCase.ascq,
          }),
        ]),
      );
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it.each(readinessReadFailureCases)(
    "lets a source change win over $category during rescue resume",
    async (failureCase) => {
      const { salvageValidator, scenario } = await exerciseReadinessResume(
        failureCase,
        true,
      );

      expect(salvageValidator.validate).not.toHaveBeenCalled();
      expect(scenario.access.archiveJobs.list(["failed"])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attemptOrdinal: 2,
            errorMessage: "DVD medium changed during archiving",
            readFailureStage: null,
            readFailureCategory: null,
            readFailureClassifierVersion: null,
          }),
        ]),
      );
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it.each(terminalReadFailureCategories)(
    "does not persist %s evidence when cancellation wins the terminal race",
    async (category) => {
      const scenario = await exerciseReadFailureFence({
        beforeFailure(access, requestId) {
          access.archiveRequests.cancel(requestId);
        },
        readFailure: dvdReadFailure(category),
      });

      expect(scenario.access.archiveJobs.list()).toEqual([
        expect.objectContaining({
          status: "aborted",
          readFailureStage: null,
          readFailureCategory: null,
          readFailureClassifierVersion: null,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["cancelled"])).toEqual([
        expect.objectContaining({ id: scenario.request.id }),
      ]);
    },
  );

  it.each(terminalReadFailureCategories)(
    "reports cancellation when it wins the %s persistence race",
    async (category) => {
      const scenario = await exerciseReadFailureFence({
        beforeReadFailurePersistence(access, requestId) {
          access.archiveRequests.cancel(requestId);
        },
        readFailure: dvdReadFailure(category),
      });

      expect(scenario.access.archiveJobs.list()).toEqual([
        expect.objectContaining({
          status: "aborted",
          readFailureStage: null,
          readFailureCategory: null,
          readFailureClassifierVersion: null,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["cancelled"])).toEqual([
        expect.objectContaining({ id: scenario.request.id }),
      ]);
      expect(scenario.log).toHaveBeenCalledWith(
        "DVD archive cancelled for /dev/sr0",
      );
    },
  );

  it("does not persist read evidence after source replacement", async () => {
    let failureObserved = false;
    const scenario = await exerciseReadFailureFence({
      beforeFailure() {
        failureObserved = true;
      },
      observeMediaGeneration: vi.fn(async () =>
        failureObserved
          ? "replacement-media-generation"
          : "test-media-generation"
      ),
    });

    expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        errorMessage: "DVD medium changed during archiving",
        readFailureStage: null,
        readFailureCategory: null,
        readFailureClassifierVersion: null,
      }),
    ]);
    expect(scenario.access.archiveRequests.list(["needs_attention"]))
      .toEqual([expect.objectContaining({ id: scenario.request.id })]);
  });

  it.each(readinessReadFailureCases)(
    "lets a source change win over $category during initial copy",
    async (failureCase) => {
      let failureObserved = false;
      const scenario = await exerciseReadFailureFence({
        beforeFailure() {
          failureObserved = true;
        },
        readFailure: dvdReadFailure(failureCase.category, {
          informationLba: null,
          requestedLba: 1,
          requestedBlockCount: 1,
          retryOrdinal: 0,
          senseResponseCode: failureCase.senseResponseCode,
          senseKey: failureCase.senseKey,
          asc: failureCase.asc,
          ascq: failureCase.ascq,
        }),
        observeMediaGeneration: vi.fn(async () =>
          failureObserved
            ? "replacement-media-generation"
            : "test-media-generation"
        ),
      });

      expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
        expect.objectContaining({
          errorMessage: "DVD medium changed during archiving",
          readFailureStage: null,
          readFailureCategory: null,
          readFailureClassifierVersion: null,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["needs_attention"]))
        .toEqual([expect.objectContaining({ id: scenario.request.id })]);
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it.each(terminalReadFailureCategories)(
    "does not persist %s evidence when shutdown wins before final revalidation",
    async (category) => {
      const controller = new AbortController();
      const workerStopping = new Error("Archive worker stopping");
      const rescueWorkspaceLock: DvdRescueWorkspaceLock = {
        async withLock({ task }) {
          try {
            return await task();
          } catch (error) {
            controller.abort(workerStopping);
            throw error;
          }
        },
      };
      const scenario = await exerciseReadFailureFence({
        expectedPollError: workerStopping,
        readFailure: dvdReadFailure(category),
        rescueWorkspaceLock,
        signal: controller.signal,
      });

      expect(scenario.access.archiveJobs.list(["failed"])).toEqual([
        expect.objectContaining({
          errorMessage: "Archive interrupted",
          readFailureStage: null,
          readFailureCategory: null,
          readFailureClassifierVersion: null,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["needs_attention"]))
        .toEqual([expect.objectContaining({ id: scenario.request.id })]);
    },
  );

  it.each(terminalReadFailureCategories)(
    "does not persist %s evidence after the Archive Job claim expires",
    async (category) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
      let claimExpiredAt: Date | undefined;
      const scenario = await exerciseReadFailureFence({
        beforeFailure() {
          claimExpiredAt = new Date(
            Date.now() + ARCHIVE_JOB_LEASE_DURATION_MS + 1,
          );
          vi.setSystemTime(claimExpiredAt);
        },
        readFailure: dvdReadFailure(category),
      });

      expect(scenario.access.archiveJobs.list(["running"])).toEqual([
        expect.objectContaining({
          readFailureStage: null,
          readFailureCategory: null,
          readFailureClassifierVersion: null,
        }),
      ]);
      vi.setSystemTime(claimExpiredAt!);
      expect(scenario.access.archiveJobs.recoverExpiredClaims()).toEqual([
        expect.objectContaining({
          errorMessage: "Archive worker lease expired",
          readFailureStage: null,
          readFailureCategory: null,
        }),
      ]);
      expect(scenario.access.archiveRequests.list(["needs_attention"]))
        .toEqual([expect.objectContaining({ id: scenario.request.id })]);
    },
  );

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
      copy: vi.fn(async ({ authorizeStart, continuation, outputPath }) => {
        expect(continuation).toBeUndefined();
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
        continuation,
        onBytesCopied,
      }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damagedRecovery,
        });
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
        continuation,
        onBytesCopied,
      }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: persistentRecovery,
        });
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

  it("finishes one rescue on a second matching Optical Drive", async () => {
    const scenario = await exerciseWatchabilityWorkerScenario({
      ranges: [{ startLba: 1, sectorCount: 1 }],
      validation: { outcome: "rejected", reason: "ambiguous" },
    });
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(scenario.originalsLibraryPath),
      scenario.request.id,
    );
    const firstAttemptImage = readFileSync(rescuePaths.imagePath);
    const firstAttemptMap = readFileSync(rescuePaths.mapPath);
    const {
      archiveRequest: continuedRequest,
      detectedDisc: secondDisc,
      discoveredDrive: secondDrive,
      hardware,
      scanOnlyCopy,
    } = await prepareMatchingOpticalDriveRescueContinuation(scenario, {
      displayName: "Second matching rescue drive",
      serialNumber: "MATCHING-RESCUE-002",
      workerId: "archive-worker-second-drive-scan",
    });

    expect(scanOnlyCopy).not.toHaveBeenCalled();
    expect(continuedRequest).toMatchObject({
      id: scenario.request.id,
      detectedDiscId: scenario.request.detectedDiscId,
      status: "pending",
    });
    expect(readFileSync(rescuePaths.imagePath)).toEqual(firstAttemptImage);
    expect(readFileSync(rescuePaths.mapPath)).toEqual(firstAttemptMap);

    const recoveredImage = Buffer.alloc(scenario.sizeBytes, 7);
    const secondCopy = vi.fn(async ({
      authorizeStart,
      continuation,
      devicePath,
      outputPath,
    }: Parameters<DvdCopyRunner["copy"]>[0]) => {
      expect(devicePath).toBe(secondDrive.devicePath);
      expect(outputPath).toBe(rescuePaths.imagePath);
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: createDamagedDvdRecoveryResult(
          scenario.sizeBytes,
          [{ startLba: 1, sectorCount: 1 }],
        ),
      });
      expect(readFileSync(outputPath)).toEqual(firstAttemptImage);
      await authorizeStart?.();
      writeFileSync(outputPath, recoveredImage);
      return createCleanDvdRecoveryResult(scenario.sizeBytes);
    });

    await pollArchiveWorker({
      access: scenario.access,
      configuredDevicePath: "/dev/sr0",
      copyRunner: {
        copy: secondCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      hardware,
      log: vi.fn(),
      originalsLibraryPath: scenario.originalsLibraryPath,
      rescueWorkspaceLock: createInProcessDvdRescueWorkspaceLock(),
      signal: new AbortController().signal,
      workerId: "archive-worker-second-drive-completion",
    });

    expect(secondCopy).toHaveBeenCalledOnce();
    expect(scenario.access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: scenario.request.id }),
    ]);
    expect(readFileSync(
      scenario.access.catalog.listOriginalDiscArchives()[0]!.archivePath,
    )).toEqual(recoveredImage);
    expect(
      scenario.access.archiveJobs.list()
        .sort((left, right) => left.attemptOrdinal - right.attemptOrdinal)
        .map((attempt) => ({
          attemptOrdinal: attempt.attemptOrdinal,
          detectedDiscId: attempt.detectedDiscId,
          status: attempt.status,
        })),
    ).toEqual([
      {
        attemptOrdinal: 1,
        detectedDiscId: scenario.request.detectedDiscId,
        status: "failed",
      },
      {
        attemptOrdinal: 2,
        detectedDiscId: secondDisc.id,
        status: "completed",
      },
    ]);
  });

  it.each(["media generation", "Optical Drive authorization"] as const)(
    "preserves a rescue on another Optical Drive after a %s mismatch",
    async (mismatchCase) => {
      const scenario = await exerciseWatchabilityWorkerScenario({
        ranges: [{ startLba: 1, sectorCount: 1 }],
        validation: { outcome: "rejected", reason: "ambiguous" },
      });
      const rescuePaths = dvdRescueWorkspacePaths(
        realpathSync(scenario.originalsLibraryPath),
        scenario.request.id,
      );
      const preservedImage = readFileSync(rescuePaths.imagePath);
      const preservedMap = readFileSync(rescuePaths.mapPath);
      const {
        archiveRequest: continuedRequest,
        detectedDisc: secondDisc,
        discoveredDrive: secondDrive,
        hardware: scanHardware,
      } = await prepareMatchingOpticalDriveRescueContinuation(scenario, {
        displayName: "Mismatched rescue drive",
        serialNumber: `MISMATCHED-RESCUE-${mismatchCase}`,
        workerId: `archive-worker-second-drive-${mismatchCase}`,
      });
      expect(continuedRequest.id).toBe(scenario.request.id);
      const copy = vi.fn(async ({ authorizeStart }) => {
        if (mismatchCase === "Optical Drive authorization") {
          scenario.access.catalog.upsertOpticalDrive({
            ...secondDrive,
            isEnabled: false,
            isPresent: true,
          });
        }
        await authorizeStart?.();
        throw new Error("copy started despite mismatched source identity");
      });
      const mismatchHardware: OpticalDriveHardware = {
        ...scanHardware,
        ...(mismatchCase === "media generation"
          ? {
              observeMediaGeneration: vi.fn(
                async () => "replacement-media-generation",
              ),
            }
          : {}),
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
        hardware: mismatchHardware,
        log: vi.fn(),
        originalsLibraryPath: scenario.originalsLibraryPath,
        rescueWorkspaceLock: createInProcessDvdRescueWorkspaceLock(),
        signal: new AbortController().signal,
        workerId: `archive-worker-cross-drive-${mismatchCase}`,
      });

      expect(copy).toHaveBeenCalledOnce();
      expect(readFileSync(rescuePaths.imagePath)).toEqual(preservedImage);
      expect(readFileSync(rescuePaths.mapPath)).toEqual(preservedMap);
      expect(
        scenario.access.archiveJobs.list(["failed"])
          .find(({ attemptOrdinal }) => attemptOrdinal === 2),
      ).toMatchObject({
        archiveRequestId: scenario.request.id,
        errorMessage: mismatchCase === "media generation"
          ? "DVD medium changed during archiving"
          : "Optical Drive is not enabled before DVD persistence",
      });
      expect(scenario.access.catalog.listOriginalDiscArchives()).toEqual([]);
    },
  );

  it("preserves rescue outcomes and attempt evidence across Optical Drives", async () => {
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
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.archiveJobs.list()).toEqual([
      expect.objectContaining({
        attemptOrdinal: 1,
        errorMessage:
          "DVD salvage rejected: unreadable sectors affect an ambiguous DVD region; 2 sectors in 2 areas; LBAs 1, 3",
        readFailureCategory: null,
      }),
    ]);
    access.archiveRequests.retry(request.id);
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      request.id,
    );
    const alternateCopy = vi.fn(async ({
      authorizeStart,
      devicePath,
      outputPath,
      continuation,
    }: Parameters<DvdCopyRunner["copy"]>[0]) => {
      expect(devicePath).toBe(alternateDrive.devicePath);
      expect(outputPath).toBe(rescuePaths.imagePath);
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: initialRecovery,
      });
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
    const driveAJob = access.archiveJobs.list()
      .find(({ attemptOrdinal }) => attemptOrdinal === 1)!;
    const driveBJob = access.archiveJobs.list()
      .find(({ attemptOrdinal }) => attemptOrdinal === 2)!;

    const structuredFailureAttempts = [
      {
        category: "hardware_error" as const,
        drive: {
          devicePath: "/dev/sr2",
          displayName: "Hardware-failure rescue drive",
          serialNumber: "FAILED-RESCUE-003",
        },
      },
      {
        category: "protection_error" as const,
        drive: {
          devicePath: "/dev/sr3",
          displayName: "Protection-failure rescue drive",
          serialNumber: "FAILED-RESCUE-004",
        },
      },
    ];
    const persistedFailureDrives = [];
    const structuredFailureJobs = [];
    for (const [index, failureAttempt] of
      structuredFailureAttempts.entries()) {
      access.archiveRequests.retry(request.id);
      persistedFailureDrives.push(access.catalog.upsertOpticalDrive({
        ...failureAttempt.drive,
        isEnabled: true,
        isPresent: true,
      }));
      const failedCopy = vi.fn(async ({
        authorizeStart,
        continuation,
        devicePath,
        outputPath,
      }: Parameters<DvdCopyRunner["copy"]>[0]) => {
        expect(devicePath).toBe(failureAttempt.drive.devicePath);
        expect(outputPath).toBe(rescuePaths.imagePath);
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: partiallyImprovedRecovery,
        });
        expect(readFileSync(outputPath)).toEqual(partiallyImprovedImage);
        await authorizeStart?.();
        throw dvdReadFailure(failureAttempt.category, {
          informationLba: 3,
          requestedLba: 3,
          requestedBlockCount: 1,
          retryOrdinal: index,
        });
      });

      await pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        copyRunner: {
          copy: failedCopy,
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        hardware: {
          ...stableDeviceBinding(),
          discover: vi.fn().mockResolvedValue([failureAttempt.drive]),
          scanDvd: vi.fn().mockResolvedValue({
            fingerprint,
            scanData,
            sizeBytes,
          }),
        },
        log: vi.fn(),
        originalsLibraryPath,
        rescueWorkspaceLock: workspaceLock,
        signal: new AbortController().signal,
        workerId: `archive-worker-${failureAttempt.category}-rescue`,
      });

      expect(failedCopy).toHaveBeenCalledOnce();
      expect(readFileSync(rescuePaths.imagePath)).toEqual(
        partiallyImprovedImage,
      );
      const failedJob = access.archiveJobs.list()
        .find(({ attemptOrdinal }) => attemptOrdinal === index + 3)!;
      expect(failedJob).toMatchObject({
        readFailureStage: "rescue_resume",
        readFailureCategory: failureAttempt.category,
        readFailureLba: 3,
        readFailureRequestedBlockCount: 1,
        readFailureRetryCount: index,
      });
      structuredFailureJobs.push(failedJob);
    }

    access.archiveRequests.retry(request.id);
    const finalDrive = {
      devicePath: "/dev/sr4",
      displayName: "Final matching rescue drive",
      serialNumber: "FINAL-RESCUE-005",
    };
    const persistedFinalDrive = access.catalog.upsertOpticalDrive({
      ...finalDrive,
      isEnabled: true,
      isPresent: true,
    });
    const finalCopy = vi.fn(async ({
      authorizeStart,
      devicePath,
      outputPath,
      continuation,
    }: Parameters<DvdCopyRunner["copy"]>[0]) => {
      expect(devicePath).toBe(finalDrive.devicePath);
      expect(outputPath).toBe(rescuePaths.imagePath);
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: partiallyImprovedRecovery,
      });
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
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([finalDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes,
        }),
      },
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
    expect(attempts[0]).toEqual(driveAJob);
    expect(attempts[1]).toEqual(driveBJob);
    expect(attempts.slice(2, 4)).toEqual(structuredFailureJobs);
    expect(attempts.map(({ status }) => status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "completed",
    ]);
    expect(attempts.map(({ readFailureCategory }) => readFailureCategory))
      .toEqual([
        null,
        null,
        "hardware_error",
        "protection_error",
        null,
      ]);
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
      { attemptOrdinal: 3, opticalDriveId: persistedFailureDrives[0]!.id },
      { attemptOrdinal: 4, opticalDriveId: persistedFailureDrives[1]!.id },
      { attemptOrdinal: 5, opticalDriveId: persistedFinalDrive.id },
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
      copy: vi.fn(({ continuation, devicePath, outputPath, signal }) => {
        expect(devicePath).toBe(alternateDrive.devicePath);
        expect(outputPath).toBe(rescuePaths.imagePath);
        expect(continuation).toMatchObject({ kind: "damaged" });
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
      archiveRequestId: string;
    };
    rescueMap.archiveRequestId = "different-archive-request";
    writeFileSync(rescueMapPath, `${JSON.stringify(rescueMap)}\n`);
    const rescueImagePath = readdirSync(root)
      .map((name) => join(root, name))
      .find((path) => path.endsWith(".rip-dvd-rescue.iso"))!;
    const preservedImage = readFileSync(rescueImagePath);
    const preservedMap = readFileSync(rescueMapPath);
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
    expect(readFileSync(rescueImagePath)).toEqual(preservedImage);
    expect(readFileSync(rescueMapPath)).toEqual(preservedMap);
    expect(
      readdirSync(root).filter((name) => name.includes(".invalid-")),
    ).toHaveLength(0);
  });


  it("copies requested work on different drives within configured concurrency", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-11T11:30:00.000Z"));
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
    const pollOptions: PollArchiveWorkerOptions = {
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
      waitForNextSettlingObservation: async (_intervalMs, signal) => {
        signal.throwIfAborted();
        vi.setSystemTime(new Date(Date.now() + 2_500));
      },
    };
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

  it("starts archive work on another drive while settling owns one slot", async () => {
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
    access.catalog.upsertOpticalDrive({
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
    const startForInspectionSpy = vi.spyOn(
      access.archiveJobs,
      "startForInspection",
    );
    const waitForShutdown = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const scanDvd = vi.fn(
      async (
        binding: { drive: DiscoveredOpticalDrive },
        _signal: AbortSignal,
      ) => {
        if (binding.drive.devicePath === slowDiscoveredDrive.devicePath) {
          throw new Error("Settling must finish before metadata starts");
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
      waitForNextSettlingObservation: async (_intervalMs, signal) =>
        await waitForShutdown(signal),
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
      expect(access.discInspections.list({ currentOnly: true })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            opticalDriveId: expect.any(String),
            phase: "settling",
            status: "running",
          }),
        ]),
      );
      expect(scanDvd).not.toHaveBeenCalled();
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
      expect(scanDvd).not.toHaveBeenCalled();
    } finally {
      controller.abort(new Error("test complete"));
      await polling;
    }
  });

  it.each([
    {
      name: "matching evidence",
      recoveredCapacityBytes: 2_048,
      recoveredMediaGeneration: "generation-a",
      expectedResetCount: 0,
    },
    {
      name: "changed provisional evidence",
      recoveredCapacityBytes: 4_096,
      recoveredMediaGeneration: "generation-b",
      expectedResetCount: 1,
    },
    {
      name: "changed capacity with a matching generation",
      recoveredCapacityBytes: 4_096,
      recoveredMediaGeneration: "generation-a",
      expectedResetCount: 1,
    },
  ])(
    "recovers an expired settling claim with $name and a fresh quiet window",
    async ({
      recoveredCapacityBytes,
      recoveredMediaGeneration,
      expectedResetCount,
    }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
      const access = openTestDataAccess();
      const discoveredDrive = {
        devicePath: "/dev/sr0",
        serialNumber: "INTERRUPTED-SETTLING-001",
      };
      let mediaGeneration = "generation-a";
      let mediaCapacityBytes = 2_048;
      const fingerprint = `sha256:${"d".repeat(64)}`;
      const scanDvd = vi.fn(async (_binding, _signal, options) => {
        options?.onMetadata?.({
          audioStreamCount: 0,
          chapterCount: 1,
          subtitleStreamCount: 0,
          titleCount: 1,
          totalBytes: mediaCapacityBytes,
          volumeLabel: "RECOVERED_DISC",
        });
        return {
          fingerprint,
          scanData: {
            schemaVersion: 2 as const,
            contentId: fingerprint,
            titles: [{
              number: 1,
              durationSeconds: 60,
              chapters: 1,
              audioStreams: [],
              subtitles: [],
            }],
          },
          sizeBytes: mediaCapacityBytes,
          volumeLabel: "RECOVERED_DISC",
        };
      });
      const hardware: OpticalDriveHardware = {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        observeMedia: vi.fn(async (_binding, _signal, options) => {
          options?.onMediaGeneration(mediaGeneration);
          return {
            mediaGeneration,
            capacityBytes: mediaCapacityBytes,
          };
        }),
        observeMediaGeneration: vi.fn(async () => mediaGeneration),
        scanDvd,
      };

      const firstController = new AbortController();
      const firstWaits = createControlledSettlingWaits();
      const firstPolling = pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: firstController.signal,
        waitForNextSettlingObservation: firstWaits.wait,
      });
      await firstWaits.waitUntilPending();
      const original = access.discInspections.list({ currentOnly: true })[0]!;
      expect(original).toMatchObject({
        attemptCount: 1,
        phase: "settling",
        stableObservationCount: 1,
      });

      const interruption = new Error("worker stopped during settling");
      firstController.abort(interruption);
      await expect(firstPolling).rejects.toBe(interruption);
      expect(scanDvd).not.toHaveBeenCalled();

      mediaGeneration = recoveredMediaGeneration;
      mediaCapacityBytes = recoveredCapacityBytes;
      vi.setSystemTime(
        new Date(
          original.claimUpdatedAt!.getTime() +
            DISC_INSPECTION_LEASE_DURATION_MS +
            1,
        ),
      );
      const successorWaits = createControlledSettlingWaits();
      const successorPolling = pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: new AbortController().signal,
        waitForNextSettlingObservation: successorWaits.wait,
      });
      await successorWaits.waitUntilPending();

      expect(access.discInspections.list()).toEqual([
        expect.objectContaining({
          id: original.id,
          attemptCount: 2,
          phase: "settling",
          mediaGeneration: recoveredMediaGeneration,
          mediaCapacityBytes: recoveredCapacityBytes,
          stableObservationCount: 1,
          settlingResetCount: expectedResetCount,
        }),
      ]);
      expect(access.discInspections.listAttempts(original.id)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "interrupted",
          phase: "settling",
          reasonCode: "worker_interrupted",
        }),
      ]);
      expect(scanDvd).not.toHaveBeenCalled();

      successorWaits.releaseNext();
      await successorWaits.waitUntilPending();
      expect(access.discInspections.list({ currentOnly: true })).toEqual([
        expect.objectContaining({
          id: original.id,
          phase: "settling",
          stableObservationCount: 2,
        }),
      ]);
      expect(scanDvd).not.toHaveBeenCalled();

      successorWaits.releaseNext();
      await successorPolling;

      expect(scanDvd).toHaveBeenCalledOnce();
      expect(access.discInspections.list()).toEqual([
        expect.objectContaining({
          id: original.id,
          attemptCount: 2,
          status: "completed",
          mediaGeneration: recoveredMediaGeneration,
          stableObservationCount: 3,
        }),
      ]);
      expect(access.discInspections.listAttempts(original.id)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "interrupted",
        }),
        expect.objectContaining({
          attemptNumber: 2,
          outcome: "completed",
        }),
      ]);
      access.close();
    },
  );

  it("lets only one concurrent poll advance settling and start metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:30:00.000Z"));
    const access = openTestDataAccess();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "CONCURRENT-SETTLING-001",
    };
    const scanDvd = vi.fn().mockResolvedValue(null);
    const observeMedia = vi.fn().mockResolvedValue({
      mediaGeneration: "concurrent-generation",
      capacityBytes: 2_048,
    });
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      observeMedia,
      observeMediaGeneration: vi.fn(async () => "concurrent-generation"),
      scanDvd,
    };
    const ownerWaits = createControlledSettlingWaits();
    const ownerPolling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: ownerWaits.wait,
    });
    await ownerWaits.waitUntilPending();

    const competingWait = vi.fn();
    await pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: competingWait,
    });

    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        attemptCount: 1,
        phase: "settling",
        stableObservationCount: 1,
      }),
    ]);
    expect(access.discInspections.listAttempts(
      access.discInspections.list()[0]!.id,
    )).toEqual([]);
    expect(competingWait).not.toHaveBeenCalled();
    expect(scanDvd).not.toHaveBeenCalled();

    ownerWaits.releaseNext();
    await ownerWaits.waitUntilPending();
    ownerWaits.releaseNext();
    await ownerPolling;

    expect(scanDvd).toHaveBeenCalledOnce();
    expect(observeMedia).toHaveBeenCalledTimes(4);
    access.close();
  });

  it("renews the settling claim while readiness waiting is in progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:45:00.000Z"));
    const access = openTestDataAccess();
    const controller = new AbortController();
    const settlingWaits = createControlledSettlingWaits();
    const renew = vi.spyOn(access.discInspections, "renew");
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-HEARTBEAT-001",
        }]),
        scanDvd: vi.fn(),
      },
      log: vi.fn(),
      signal: controller.signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });
    await settlingWaits.waitUntilPending();
    const claimedAt = access.discInspections.list({ currentOnly: true })[0]!
      .claimUpdatedAt!;

    await vi.advanceTimersByTimeAsync(
      Math.floor(DISC_INSPECTION_LEASE_DURATION_MS / 3),
    );
    expect(renew).toHaveBeenCalledOnce();
    const renewed = access.discInspections.list({ currentOnly: true })[0]!;
    expect(renewed.phase).toBe("settling");
    expect(renewed.claimUpdatedAt!.getTime()).toBeGreaterThan(
      claimedAt.getTime(),
    );

    const interruption = new Error("test complete");
    controller.abort(interruption);
    await expect(polling).rejects.toBe(interruption);
    access.close();
  });

  it("aborts an in-flight scan when inspection lease renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T13:00:00.000Z"));
    const access = openTestDataAccess();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "INSPECTION-LEASE-001",
    };
    access.catalog.reconcileOpticalDrives([
      { ...discoveredDrive, isConfiguredDevice: true },
    ]);
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
      waitForNextSettlingObservation: async (intervalMs, signal) => {
        signal.throwIfAborted();
        vi.setSystemTime(new Date(Date.now() + intervalMs));
      },
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
      copy: vi.fn(async ({ authorizeStart, continuation, outputPath }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damagedRecovery,
        });
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
      continuation,
    }) => {
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: damagedRecovery,
      });
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

  it.runIf(supportsLinuxWriterOwnership)(
    "keeps invalid corrected recovery pending before finalizing cancellation",
    async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T08:00:00.000Z"));
    const access = openTestDataAccess();
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-corrected-cancel-recovery-"),
    );
    temporaryDirectories.push(originalsLibraryPath);
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "CORRECTED-CANCEL-RECOVERY-001",
    };
    const drive = access.catalog.reconcileOpticalDrives([{
      ...discoveredDrive,
      isConfiguredDevice: true,
    }])[0]!;
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const fingerprint = `dvdmeta-sha256:${"b".repeat(64)}`;
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
    const started = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "test-media-generation",
      mediaCapacityBytes: reportedSizeBytes,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
      sizeBytes: reportedSizeBytes,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.discInspections.record(started.claim!, {
      type: "metadata",
      audioStreamCount: 0,
      chapterCount: 10,
      subtitleStreamCount: 0,
      titleCount: 1,
      totalBytes: reportedSizeBytes,
      volumeLabel: null,
    });
    const inspection = access.discInspections.record(started.claim!, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const cancelledRequest = access.archiveRequests.list(["pending"])[0]!;
    const expiredClaim = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-that-crashed-after-corrected-link",
    )!;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 71);
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const crashedPublication = await preserveDvdArchive({
      archiveRequestId: cancelledRequest.id,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: discoveredDrive.devicePath,
      expectedTitleMap: scanData,
      fingerprint,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(boundaryFailure);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    });
    const rescuePaths = dvdRescueWorkspacePaths(
      realpathSync(originalsLibraryPath),
      cancelledRequest.id,
    );
    const validRescueMap = readFileSync(rescuePaths.mapPath, "utf8");
    const retentionMapPath = `${rescuePaths.mapPath}.retaining`;
    writeFileSync(rescuePaths.mapPath, "invalid rescue map\n");
    const invalidRetentionMap = JSON.parse(validRescueMap);
    invalidRetentionMap.imageFilesystemIdentity = "1:2";
    writeFileSync(
      retentionMapPath,
      `${JSON.stringify(invalidRetentionMap)}\n`,
    );
    access.archiveRequests.cancel(cancelledRequest.id);
    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    const replacementImage = Buffer.alloc(reportedSizeBytes, 79);
    const copyRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, replacementImage);
        return createCleanDvdRecoveryResult(reportedSizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const pollOptions = {
      access,
      configuredDevicePath: discoveredDrive.devicePath,
      copyRunner,
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([discoveredDrive]),
        scanDvd: vi.fn().mockResolvedValue({
          fingerprint,
          scanData,
          sizeBytes: reportedSizeBytes,
        }),
      },
      log: vi.fn(),
      originalsLibraryPath,
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(pollOptions);
    await pollArchiveWorker(pollOptions);

    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: expiredClaim.id }),
    ]);
    expect(access.archiveRequests.list(["cancellation_requested"])).toEqual([
      expect.objectContaining({ id: cancelledRequest.id }),
    ]);
    expect(existsSync(crashedPublication.archivePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
    expect(existsSync(retentionMapPath)).toBe(true);
    expect(
      readdirSync(realpathSync(originalsLibraryPath)).some((name) =>
        name.includes(".invalid-")
      ),
    ).toBe(false);

    unlinkSync(retentionMapPath);
    writeFileSync(rescuePaths.mapPath, validRescueMap);
    await pollArchiveWorker(pollOptions);

    expect(access.archiveJobs.list(["aborted"])).toEqual([
      expect.objectContaining({ id: expiredClaim.id }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: cancelledRequest.id }),
    ]);
    expect(existsSync(crashedPublication.archivePath)).toBe(false);
    expect(readFileSync(`${crashedPublication.archivePath}.failed`))
      .toEqual(retainedPrefix);

    const replacementRequest = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });
    await pollArchiveWorker({
      ...pollOptions,
      workerId: "replacement-after-corrected-cancellation",
    });

    expect(copyRunner.copy).toHaveBeenCalledOnce();
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: replacementRequest.id }),
    ]);
    expect(readFileSync(
      access.catalog.listOriginalDiscArchives()[0]!.archivePath,
    )).toEqual(replacementImage);
    },
  );

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

  it("keeps stable empty enabled Optical Drives as ordinary polling state", async () => {
    const access = openTestDataAccess();
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isEnabled: true,
      isPresent: true,
      serialNumber: "EMPTY-USB-002",
    });
    const discoveredDrives = [
      {
        devicePath: "/dev/sr0",
        displayName: "Empty SATA drive",
        product: "DVD-RW",
        serialNumber: "EMPTY-SATA-001",
        transport: "sata",
        vendor: "Pioneer",
      },
      {
        devicePath: "/dev/sr1",
        displayName: "Empty USB drive",
        product: "DVD-RW",
        serialNumber: "EMPTY-USB-002",
        transport: "usb",
        vendor: "LG",
      },
    ];
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Device not ready: no medium found",
      }),
      drives: () => discoveredDrives,
      mediaGeneration: "1",
    });
    const log = vi.fn();

    await pollArchiveWorkerOnce({
      access,
      concurrency: 2,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log,
      signal: new AbortController().signal,
    });

    const observedPaths = vi.mocked(runner.run).mock.calls
      .filter(([executable]) => executable === "blockdev")
      .map(([, arguments_]) => arguments_[1]);
    expect(observedPaths).toHaveLength(2);
    expect(observedPaths).toEqual(expect.arrayContaining(["/dev/sr0", "/dev/sr1"]));
    expect(access.catalog.listOpticalDrives({ ids: [secondDrive.id] })).toEqual([
      expect.objectContaining({ isEnabled: true, isPresent: true }),
    ]);
    expect(access.discInspections.list()).toEqual([]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(log).not.toHaveBeenCalled();
    access.close();
  });

  it("aborts settling as no_medium when the DVD is removed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T17:00:00.000Z"));
    const access = openTestDataAccess();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      product: "DVD-RW",
      serialNumber: "REMOVAL-001",
      vendor: "Pioneer",
    };
    let mediumPresent = true;
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => mediumPresent
        ? { exitCode: 0, stdout: "4700372992\n", stderr: "" }
        : {
            exitCode: 1,
            stdout: "",
            stderr: "Device not ready: medium not present",
          },
      drives: () => [discoveredDrive],
      mediaGeneration: "21",
    });
    const settlingWaits = createControlledSettlingWaits();
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    };

    const polling = pollArchiveWorkerOnce(options);
    await settlingWaits.waitUntilPending();
    const settling = access.discInspections.list({ currentOnly: true })[0]!;
    expect(settling).toMatchObject({ phase: "settling", status: "running" });

    mediumPresent = false;
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [settling.id] })).toEqual([
      expect.objectContaining({
        diagnostic: null,
        isCurrent: false,
        reasonCode: "no_medium",
        status: "aborted",
      }),
    ]);
    expect(access.discInspections.listAttempts(settling.id)).toEqual([
      expect.objectContaining({
        outcome: "aborted",
        phase: "settling",
        reasonCode: "no_medium",
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(options.log).not.toHaveBeenCalled();
    access.close();
  });

  it("aborts settling when replacement hardware takes the Optical Drive path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T17:15:00.000Z"));
    const access = openTestDataAccess();
    let serialNumber = "SETTLING-DRIVE-001";
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => ({
        exitCode: 0,
        stdout: "4700372992\n",
        stderr: "",
      }),
      drives: () => [{
        devicePath: "/dev/sr0",
        product: "DVD-RW",
        serialNumber,
        vendor: "Pioneer",
      }],
      mediaGeneration: "31",
    });
    const settlingWaits = createControlledSettlingWaits();
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    };

    const polling = pollArchiveWorkerOnce(options);
    await settlingWaits.waitUntilPending();
    const settling = access.discInspections.list({ currentOnly: true })[0]!;

    serialNumber = "REPLACEMENT-DRIVE-002";
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [settling.id] })).toEqual([
      expect.objectContaining({
        diagnostic: null,
        isCurrent: false,
        reasonCode: "drive_identity_changed",
        status: "aborted",
      }),
    ]);
    expect(access.discInspections.listAttempts(settling.id)).toEqual([
      expect.objectContaining({
        outcome: "aborted",
        phase: "settling",
        reasonCode: "drive_identity_changed",
      }),
    ]);
    expect(access.catalog.listOpticalDrives()).toEqual([
      expect.objectContaining({
        isEnabled: false,
        serialNumber: "REPLACEMENT-DRIVE-002",
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    access.close();
  });

  it("retains drive_unavailable when media observation becomes inaccessible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T17:30:00.000Z"));
    const access = openTestDataAccess();
    let accessible = true;
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => accessible
        ? { exitCode: 0, stdout: "4700372992\n", stderr: "" }
        : {
            exitCode: 1,
            stdout: "",
            stderr: "blockdev: cannot open /dev/sr0: Permission denied",
          },
      drives: () => [{
        devicePath: "/dev/sr0",
        product: "DVD-RW",
        serialNumber: "UNAVAILABLE-001",
        vendor: "Pioneer",
      }],
      mediaGeneration: "41",
    });
    const settlingWaits = createControlledSettlingWaits();
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    };

    const polling = pollArchiveWorkerOnce(options);
    await settlingWaits.waitUntilPending();
    const settling = access.discInspections.list({ currentOnly: true })[0]!;
    accessible = false;
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [settling.id] })).toEqual([
      expect.objectContaining({
        diagnostic: null,
        isCurrent: false,
        reasonCode: "drive_unavailable",
        status: "aborted",
      }),
    ]);
    expect(access.discInspections.listAttempts(settling.id)).toEqual([
      expect.objectContaining({
        outcome: "aborted",
        phase: "settling",
        reasonCode: "drive_unavailable",
      }),
    ]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("keeps media probe no-medium failures as ordinary empty polling", async () => {
    const access = openTestDataAccess();
    const probeLauncher: MediaGenerationProbeLauncher = {
      start: vi.fn(() => {
        const result = Promise.reject(
          new Error("ENOMEDIUM: no medium found, open '/dev/sr0'"),
        );
        return {
          cancel: vi.fn(),
          closed: result.then(() => undefined, () => undefined),
          result,
        };
      }),
    };
    const mediaGenerationObserver = createNodeMediaGenerationObserver({
      probeLauncher,
    });
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => ({
        exitCode: 0,
        stdout: "4700372992\n",
        stderr: "",
      }),
      deviceInstanceObserver: mediaGenerationObserver,
      drives: () => [{
        devicePath: "/dev/sr0",
        product: "DVD-RW",
        serialNumber: "PROBE-EMPTY-001",
        vendor: "Pioneer",
      }],
      mediaGeneration: "71",
      mediaGenerationObserver,
    });
    const log = vi.fn();

    await pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log,
      signal: new AbortController().signal,
    });

    expect(access.discInspections.list()).toEqual([]);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    expect(
      vi.mocked(runner.run).mock.calls.filter(
        ([executable]) => executable === "blockdev",
      ),
    ).toHaveLength(0);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(log).not.toHaveBeenCalled();
    access.close();
  });

  it("classifies media probe permission loss before blockdev as drive_unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const access = openTestDataAccess();
    let accessible = true;
    const probeLauncher: MediaGenerationProbeLauncher = {
      start: vi.fn(() => {
        const result = accessible
          ? Promise.resolve("61\n")
          : Promise.reject(
              new Error("EACCES: permission denied, open '/dev/sr0'"),
            );
        return {
          cancel: vi.fn(),
          closed: result.then(() => undefined, () => undefined),
          result,
        };
      }),
    };
    const mediaGenerationObserver = createNodeMediaGenerationObserver({
      probeLauncher,
    });
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () => ({
        exitCode: 0,
        stdout: "4700372992\n",
        stderr: "",
      }),
      deviceInstanceObserver: mediaGenerationObserver,
      drives: () => [{
        devicePath: "/dev/sr0",
        product: "DVD-RW",
        serialNumber: "PROBE-UNAVAILABLE-001",
        vendor: "Pioneer",
      }],
      mediaGeneration: "61",
      mediaGenerationObserver,
    });
    const settlingWaits = createControlledSettlingWaits();
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    };

    const polling = pollArchiveWorkerOnce(options);
    await settlingWaits.waitUntilPending();
    const settling = access.discInspections.list({ currentOnly: true })[0]!;
    accessible = false;
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [settling.id] })).toEqual([
      expect.objectContaining({
        diagnostic: null,
        isCurrent: false,
        reasonCode: "drive_unavailable",
        status: "aborted",
      }),
    ]);
    expect(access.discInspections.listAttempts(settling.id)).toEqual([
      expect.objectContaining({
        outcome: "aborted",
        phase: "settling",
        reasonCode: "drive_unavailable",
      }),
    ]);
    expect(
      vi.mocked(runner.run).mock.calls.filter(
        ([executable]) => executable === "blockdev",
      ),
    ).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("aborts an unauthorized settling Optical Drive as drive_unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-22T17:45:00.000Z"));
    const access = openTestDataAccess();
    const observeMedia = vi.fn().mockResolvedValue({
      mediaGeneration: "51",
      capacityBytes: 4_700_372_992,
    });
    const scanDvd = vi.fn();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      product: "DVD-RW",
      serialNumber: "UNAUTHORIZED-001",
      vendor: "Pioneer",
    };
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      observeMedia,
      scanDvd,
    };
    const settlingWaits = createControlledSettlingWaits();
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    };

    const polling = pollArchiveWorkerOnce(options);
    await settlingWaits.waitUntilPending();
    const settling = access.discInspections.list({ currentOnly: true })[0]!;
    access.catalog.upsertOpticalDrive({
      ...discoveredDrive,
      isEnabled: false,
      isPresent: true,
    });
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [settling.id] })).toEqual([
      expect.objectContaining({
        diagnostic: null,
        isCurrent: false,
        reasonCode: "drive_unavailable",
        status: "aborted",
      }),
    ]);
    expect(observeMedia).toHaveBeenCalledTimes(1);
    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("persists a claimed capacity-probe failure through normal retry state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T16:30:00.000Z"));
    const access = openTestDataAccess();
    const log = vi.fn();
    const { hardware } = createLinuxSettlingHardware({
      capacityResult: () => {
        throw new Error("capacity probe crashed");
      },
      drives: () => [{
        devicePath: "/dev/sr0",
        serialNumber: "SETTLING-PROBE-FAILURE-001",
      }],
      mediaGeneration: "probe-failure-generation",
    });

    await pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log,
      signal: new AbortController().signal,
    });

    const [inspection] = access.discInspections.list();
    expect(inspection).toMatchObject({
      status: "running",
      phase: "retry_wait",
      attemptCount: 1,
      consecutiveFailureCount: 1,
      reasonCode: "unknown",
      diagnostic: "capacity probe crashed",
      claimToken: null,
      claimUpdatedAt: null,
    });
    expect(access.discInspections.listAttempts(inspection!.id)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "failed",
        phase: "settling",
        reasonCode: "unknown",
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: capacity probe crashed",
    );
    access.close();
  });

  it.each([
    { name: "throws", result: "throw" },
    { name: "reports no medium", result: "no_medium" },
  ] as const)(
    "records timeout when the initial capacity probe $name at the deadline",
    async ({ result }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-22T16:45:00.000Z"));
      const access = openTestDataAccess();
      const scanDvd = vi.fn();
      const observeMedia: OpticalDriveHardware["observeMedia"] = vi.fn(
        async (_binding, _signal, options) => {
          options?.onMediaGeneration("late-probe-generation");
          const [inspection] = access.discInspections.list({
            currentOnly: true,
          });
          vi.setSystemTime(new Date(
            inspection!.settlingStartedAt!.getTime() +
              DISC_INSPECTION_SETTLING_TIMEOUT_MS,
          ));
          if (result === "throw") {
            throw new Error("late capacity probe failure");
          }
          return null;
        },
      );
      const hardware: OpticalDriveHardware = {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-LATE-PROBE-001",
        }]),
        observeMedia,
        scanDvd,
      };

      await pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: new AbortController().signal,
      });

      const [inspection] = access.discInspections.list();
      expect(inspection).toMatchObject({
        status: "running",
        phase: "retry_wait",
        attemptCount: 1,
        consecutiveFailureCount: 1,
        reasonCode: "drive_not_ready",
        diagnostic: "Optical Drive did not settle within 30 seconds",
        claimToken: null,
        claimUpdatedAt: null,
      });
      expect(access.discInspections.listAttempts(inspection!.id)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "failed",
          phase: "settling",
          reasonCode: "drive_not_ready",
        }),
      ]);
      expect(observeMedia).toHaveBeenCalledOnce();
      expect(scanDvd).not.toHaveBeenCalled();
      access.close();
    },
  );

  it("keeps invalid capacity observations settling until the exact timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:00:00.000Z"));
    const access = openTestDataAccess();
    const capacityResults: CommandResult[] = [
      { exitCode: 0, stdout: "0\n", stderr: "" },
      { exitCode: 0, stdout: "-2048\n", stderr: "" },
      { exitCode: 0, stdout: "not-a-number\n", stderr: "" },
      { exitCode: 0, stdout: "2049\n", stderr: "" },
      { exitCode: 0, stdout: "Infinity\n", stderr: "" },
      { exitCode: 0, stdout: "0x1269c0000\n", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "capacity unavailable" },
    ];
    let capacityIndex = 0;
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: () =>
        capacityResults[Math.min(
          capacityIndex++,
          capacityResults.length - 1,
        )]!,
      drives: () => [{
        devicePath: "/dev/sr0",
        serialNumber: "SETTLING-INVALID-001",
      }],
      mediaGeneration: "invalid-capacity-generation",
    });
    const settlingWaits = createControlledSettlingWaits();
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });

    await settlingWaits.waitUntilPending();
    const inspectionId = access.discInspections.list({
      currentOnly: true,
    })[0]!.id;
    for (let index = 1; index < capacityResults.length; index += 1) {
      settlingWaits.releaseNext(1_000);
      await settlingWaits.waitUntilPending();
      expect(access.discInspections.list({ ids: [inspectionId] })).toEqual([
        expect.objectContaining({
          phase: "settling",
          mediaCapacityBytes: null,
          stableObservationCount: 0,
          settlingQuietWindowStartedAt: null,
          titleCount: null,
          totalBytes: null,
        }),
      ]);
    }

    const settlingStartedAt = access.discInspections.list({
      ids: [inspectionId],
    })[0]!.settlingStartedAt!;
    await vi.advanceTimersByTimeAsync(
      settlingStartedAt.getTime() +
        DISC_INSPECTION_SETTLING_TIMEOUT_MS -
        Date.now() -
        1,
    );
    expect(access.discInspections.list({ ids: [inspectionId] })).toEqual([
      expect.objectContaining({
        phase: "settling",
        status: "running",
        consecutiveFailureCount: 0,
      }),
    ]);
    expect(access.discInspections.listAttempts(inspectionId)).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await polling;

    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        id: inspectionId,
        status: "running",
        phase: "retry_wait",
        consecutiveFailureCount: 1,
        reasonCode: "drive_not_ready",
        diagnostic: "Optical Drive did not settle within 30 seconds",
        titleCount: null,
        totalBytes: null,
      }),
    ]);
    expect(access.discInspections.listAttempts(inspectionId)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "failed",
        phase: "settling",
        reasonCode: "drive_not_ready",
      }),
    ]);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );
    access.close();
  });

  it.each([
    { name: "valid", returnsNoMedium: false },
    { name: "no-medium", returnsNoMedium: true },
  ])(
    "rejects a $name readiness result returned exactly at the deadline",
    async ({ returnsNoMedium }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-22T17:15:00.000Z"));
      const access = openTestDataAccess();
      const mediaCapacityBytes = 4_700_372_992;
      let observationCount = 0;
      const observeMedia: OpticalDriveHardware["observeMedia"] = vi.fn(
        async (_binding, _signal, options) => {
          observationCount += 1;
          options?.onMediaGeneration("deadline-generation");
          if (observationCount === 3) {
            const [inspection] = access.discInspections.list({
              currentOnly: true,
            });
            vi.setSystemTime(new Date(
              inspection!.settlingStartedAt!.getTime() +
                DISC_INSPECTION_SETTLING_TIMEOUT_MS,
            ));
            if (returnsNoMedium) {
              return null;
            }
          }
          return {
            mediaGeneration: "deadline-generation",
            capacityBytes: mediaCapacityBytes,
          };
        },
      );
      const scanDvd = vi.fn();
      const hardware: OpticalDriveHardware = {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-DEADLINE-001",
        }]),
        observeMedia,
        observeMediaGeneration: vi.fn().mockResolvedValue(
          "deadline-generation",
        ),
        scanDvd,
      };
      const settlingWaits = createControlledSettlingWaits();
      const polling = pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: new AbortController().signal,
        waitForNextSettlingObservation: settlingWaits.wait,
      });

      await settlingWaits.waitUntilPending();
      const inspectionId = access.discInspections.list({
        currentOnly: true,
      })[0]!.id;
      settlingWaits.releaseNext();
      await settlingWaits.waitUntilPending();
      settlingWaits.releaseNext();
      await polling;

      expect(access.discInspections.list({ ids: [inspectionId] })).toEqual([
        expect.objectContaining({
          status: "running",
          phase: "retry_wait",
          stableObservationCount: 2,
          consecutiveFailureCount: 1,
          reasonCode: "drive_not_ready",
          diagnostic: "Optical Drive did not settle within 30 seconds",
          titleCount: null,
          totalBytes: null,
        }),
      ]);
      expect(access.discInspections.listAttempts(inspectionId)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "failed",
          phase: "settling",
          reasonCode: "drive_not_ready",
        }),
      ]);
      expect(observeMedia).toHaveBeenCalledTimes(3);
      expect(scanDvd).not.toHaveBeenCalled();
      access.close();
    },
  );

  it("records timeout when failure classification crosses the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:20:00.000Z"));
    const access = openTestDataAccess();
    const mediaCapacityBytes = 4_700_372_992;
    let observationCount = 0;
    const observeMedia: OpticalDriveHardware["observeMedia"] = vi.fn(
      async (_binding, _signal, options) => {
        observationCount += 1;
        options?.onMediaGeneration("classification-generation");
        if (observationCount === 2) {
          throw new Error("readiness observation failed");
        }
        return {
          mediaGeneration: "classification-generation",
          capacityBytes: mediaCapacityBytes,
        };
      },
    );
    const observeMediaGeneration = vi.fn(async () => {
      const [inspection] = access.discInspections.list({ currentOnly: true });
      vi.setSystemTime(new Date(
        inspection!.settlingStartedAt!.getTime() +
          DISC_INSPECTION_SETTLING_TIMEOUT_MS,
      ));
      return "classification-generation";
    });
    const scanDvd = vi.fn();
    const hardware: OpticalDriveHardware = {
      ...stableDeviceBinding(),
      discover: vi.fn().mockResolvedValue([{
        devicePath: "/dev/sr0",
        serialNumber: "SETTLING-CLASSIFICATION-001",
      }]),
      observeMedia,
      observeMediaGeneration,
      scanDvd,
    };
    const settlingWaits = createControlledSettlingWaits();
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });

    await settlingWaits.waitUntilPending();
    const inspectionId = access.discInspections.list({
      currentOnly: true,
    })[0]!.id;
    settlingWaits.releaseNext();
    await polling;

    expect(access.discInspections.list({ ids: [inspectionId] })).toEqual([
      expect.objectContaining({
        status: "running",
        phase: "retry_wait",
        stableObservationCount: 1,
        consecutiveFailureCount: 1,
        reasonCode: "drive_not_ready",
        diagnostic: "Optical Drive did not settle within 30 seconds",
      }),
    ]);
    expect(access.discInspections.listAttempts(inspectionId)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "failed",
        phase: "settling",
        reasonCode: "drive_not_ready",
      }),
    ]);
    expect(observeMediaGeneration).toHaveBeenCalledOnce();
    expect(scanDvd).not.toHaveBeenCalled();
    access.close();
  });

  it("bounds blocked capacity probes across terminal failure and manual retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:30:00.000Z"));
    const access = openTestDataAccess();
    let mediaGeneration = "blocked-generation-1";
    let blockCapacity = true;
    let probeCount = 0;
    const probeWaiters: Array<() => void> = [];
    const waitForProbe = async (expectedCount: number) => {
      if (probeCount >= expectedCount) {
        return;
      }
      await new Promise<void>((resolve) => probeWaiters.push(resolve));
    };
    const { hardware, runner } = createLinuxSettlingHardware({
      capacityResult: async (_devicePath, activeSignal) => {
        probeCount += 1;
        probeWaiters.splice(0).forEach((resolve) => resolve());
        if (!blockCapacity) {
          return { exitCode: 0, stdout: "unavailable\n", stderr: "" };
        }
        return await new Promise<CommandResult>((_resolve, reject) => {
          const abort = () => reject(activeSignal.reason);
          if (activeSignal.aborted) {
            abort();
            return;
          }
          activeSignal.addEventListener("abort", abort, { once: true });
        });
      },
      drives: () => [{
        devicePath: "/dev/sr0",
        serialNumber: "SETTLING-BLOCKED-001",
      }],
      mediaGeneration: () => mediaGeneration,
    });
    const poll = (signal = new AbortController().signal) =>
      pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal,
      });

    let inspectionId: DiscInspectionId | undefined;
    for (let failure = 1; failure <= 5; failure += 1) {
      const polling = poll();
      await waitForProbe(failure);
      const currentBeforeTimeout = access.discInspections.list({
        currentOnly: true,
      })[0]!;
      inspectionId ??= currentBeforeTimeout.id;
      expect(currentBeforeTimeout).toMatchObject({
        id: inspectionId,
        attemptCount: failure,
        status: "running",
        phase: "settling",
        mediaGeneration,
        mediaCapacityBytes: null,
        stableObservationCount: 0,
        consecutiveFailureCount: failure - 1,
      });

      await vi.advanceTimersByTimeAsync(
        DISC_INSPECTION_SETTLING_TIMEOUT_MS - 1,
      );
      expect(access.discInspections.listAttempts(inspectionId)).toHaveLength(
        failure - 1,
      );
      await vi.advanceTimersByTimeAsync(1);
      await polling;

      const failed = access.discInspections.list({ ids: [inspectionId] })[0]!;
      expect(failed).toMatchObject({
        id: inspectionId,
        status: failure === 5 ? "failed" : "running",
        phase: failure === 5 ? "settling" : "retry_wait",
        consecutiveFailureCount: failure,
        reasonCode: "drive_not_ready",
      });
      expect(access.discInspections.listAttempts(inspectionId)).toHaveLength(
        failure,
      );
      if (failure < 5) {
        vi.setSystemTime(failed.retryAt!);
        mediaGeneration = `blocked-generation-${failure + 1}`;
      }
    }

    blockCapacity = false;
    mediaGeneration = "terminal-generation-churn";
    await poll();
    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        id: inspectionId,
        status: "failed",
        attemptCount: 5,
        consecutiveFailureCount: 5,
        reasonCode: "drive_not_ready",
      }),
    ]);

    access.discInspections.requestRetry(inspectionId!);
    blockCapacity = true;
    mediaGeneration = "manual-retry-generation";
    const controller = new AbortController();
    const manualPolling = poll(controller.signal);
    await waitForProbe(7);
    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        id: inspectionId,
        status: "running",
        phase: "settling",
        attemptCount: 6,
        consecutiveFailureCount: 0,
        mediaGeneration,
        mediaCapacityBytes: null,
        stableObservationCount: 0,
        settlingQuietWindowStartedAt: null,
        titleCount: null,
        totalBytes: null,
      }),
    ]);
    expect(access.discInspections.listAttempts(inspectionId!)).toHaveLength(5);
    expect(runner.run).not.toHaveBeenCalledWith(
      "rip-dvd-lsdvd",
      expect.anything(),
      expect.anything(),
    );

    const interruption = new Error("test complete");
    controller.abort(interruption);
    await expect(manualPolling).rejects.toBe(interruption);
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
            settlingQuietWindowStartedAt: expect.any(Date),
            settlingStartedAt: expect.any(Date),
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
    const settlingWaits = createControlledSettlingWaits();
    const poll = () => pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });

    const polling = poll();
    await settlingWaits.waitUntilPending();
    const inspectionId = access.discInspections.list({ currentOnly: true })[0]!.id;
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: inspectionId,
        phase: "settling",
        mediaGeneration: "test-media-generation",
        mediaCapacityBytes,
        stableObservationCount: 1,
        settlingQuietWindowStartedAt: expect.any(Date),
        settlingStartedAt: expect.any(Date),
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

    settlingWaits.releaseNext();
    await settlingWaits.waitUntilPending();
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

    settlingWaits.releaseNext();
    await polling;

    expect(
      run.mock.calls.filter(([executable]) =>
        executable === "rip-dvd-lsdvd"
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(([executable]) => executable === "blockdev"),
    ).toHaveLength(3);
    expect(settlingWaits.wait).toHaveBeenCalledTimes(2);
    expect(settlingWaits.wait).toHaveBeenCalledWith(
      2_500,
      expect.any(AbortSignal),
    );
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

  it.each([
    {
      name: "media generation",
      observations: [
        { mediaGeneration: "generation-a", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-a", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-b", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-b", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-b", capacityBytes: 4_700_372_992 },
      ],
    },
    {
      name: "declared capacity",
      observations: [
        { mediaGeneration: "generation-a", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-a", capacityBytes: 4_700_372_992 },
        { mediaGeneration: "generation-a", capacityBytes: 4_700_375_040 },
        { mediaGeneration: "generation-a", capacityBytes: 4_700_375_040 },
        { mediaGeneration: "generation-a", capacityBytes: 4_700_375_040 },
      ],
    },
  ])(
    "absorbs provisional $name churn into one active Disc Inspection attempt",
    async ({ observations }) => {
      vi.useFakeTimers();
      const startedAt = new Date("2026-08-22T18:30:00.000Z");
      vi.setSystemTime(startedAt);
      const access = openTestDataAccess();
      const fingerprint = `sha256:${"c".repeat(64)}`;
      const finalObservation = observations.at(-1)!;
      const scanDvd = vi.fn(async (_binding, _signal, options) => {
        options?.onPhase?.("reading_metadata");
        options?.onMetadata?.({
          audioStreamCount: 0,
          chapterCount: 1,
          subtitleStreamCount: 0,
          titleCount: 1,
          totalBytes: finalObservation.capacityBytes,
          volumeLabel: "SETTLED_AFTER_CHURN",
        });
        options?.onPhase?.("confirming_media");
        return {
          fingerprint,
          scanData: {
            schemaVersion: 2 as const,
            contentId: fingerprint,
            titles: [{
              number: 1,
              durationSeconds: 60,
              chapters: 1,
              audioStreams: [],
              subtitles: [],
            }],
          },
          sizeBytes: finalObservation.capacityBytes,
          volumeLabel: "SETTLED_AFTER_CHURN",
        };
      });
      const observeMedia = vi.fn();
      for (const observation of observations) {
        observeMedia.mockResolvedValueOnce(observation);
      }
      const hardware: OpticalDriveHardware = {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          displayName: "Churning drive",
          serialNumber: "SETTLING-CHURN-001",
        }]),
        observeMedia,
        observeMediaGeneration: vi.fn(
          async () => finalObservation.mediaGeneration,
        ),
        scanDvd,
      };
      const settlingWaits = createControlledSettlingWaits();
      const poll = () => pollArchiveWorkerOnce({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: new AbortController().signal,
        waitForNextSettlingObservation: settlingWaits.wait,
      });

      const polling = poll();
      await settlingWaits.waitUntilPending();
      settlingWaits.releaseNext();
      await settlingWaits.waitUntilPending();
      const inspectionId = access.discInspections.list({
        currentOnly: true,
      })[0]!.id;

      settlingWaits.releaseNext();
      await settlingWaits.waitUntilPending();

      expect(access.discInspections.list()).toEqual([
        expect.objectContaining({
          id: inspectionId,
          attemptCount: 1,
          status: "running",
          phase: "settling",
          mediaGeneration: finalObservation.mediaGeneration,
          mediaCapacityBytes: finalObservation.capacityBytes,
          stableObservationCount: 1,
          settlingQuietWindowStartedAt: expect.any(Date),
          settlingStartedAt: expect.any(Date),
          settlingResetCount: 1,
          titleCount: null,
        }),
      ]);
      expect(access.discInspections.listAttempts(inspectionId)).toEqual([]);
      expect(scanDvd).not.toHaveBeenCalled();
      expect(access.catalog.listDetectedDiscs()).toEqual([]);

      settlingWaits.releaseNext();
      await settlingWaits.waitUntilPending();
      settlingWaits.releaseNext();
      await polling;

      expect(scanDvd).toHaveBeenCalledOnce();
      expect(access.discInspections.list()).toEqual([
        expect.objectContaining({
          id: inspectionId,
          attemptCount: 1,
          status: "completed",
          mediaGeneration: finalObservation.mediaGeneration,
          mediaCapacityBytes: finalObservation.capacityBytes,
          stableObservationCount: 3,
          settlingResetCount: 1,
        }),
      ]);
      expect(access.discInspections.listAttempts(inspectionId)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "completed",
        }),
      ]);
      expect(access.catalog.listDetectedDiscs()).toEqual([
        expect.objectContaining({
          fingerprint,
          volumeLabel: "SETTLED_AFTER_CHURN",
        }),
      ]);
      access.close();
    },
  );

  it("does not reuse cached metadata after an A-to-B-to-A generation sequence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T18:45:00.000Z"));
    const access = openTestDataAccess();
    const mediaCapacityBytes = 4_700_372_992;
    let metadataReadCount = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (executable) => {
        if (executable === "lsblk") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              blockdevices: [{
                path: "/dev/sr0",
                type: "rom",
                vendor: "Pioneer",
                model: "DVD-RW",
                serial: "SETTLING-ABA-001",
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
          metadataReadCount += 1;
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: DISC_A",
              "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    let mediaGeneration = "generation-a";
    const mediaGenerationObserver = {
      observe: vi.fn(async () => mediaGeneration),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver,
      deviceInstanceObserver: {
        observe: vi.fn().mockResolvedValue("device-instance-1"),
      },
    });
    const pollOptions = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: new AbortController().signal,
    };

    await pollArchiveWorker(pollOptions);
    const firstInspectionId = access.discInspections.list({
      currentOnly: true,
    })[0]!.id;
    expect(metadataReadCount).toBe(1);
    expect(access.discInspections.list({ ids: [firstInspectionId] })).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);

    mediaGeneration = "generation-b";
    const settlingWaits = createControlledSettlingWaits();
    const returnedPolling = pollArchiveWorkerOnce({
      ...pollOptions,
      waitForNextSettlingObservation: settlingWaits.wait,
    });
    await settlingWaits.waitUntilPending();
    const resumedInspectionId = access.discInspections.list({
      currentOnly: true,
    })[0]!.id;
    expect(resumedInspectionId).not.toBe(firstInspectionId);

    settlingWaits.releaseNext();
    await settlingWaits.waitUntilPending();
    mediaGeneration = "generation-a";
    settlingWaits.releaseNext();
    await settlingWaits.waitUntilPending();
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: resumedInspectionId,
        attemptCount: 1,
        phase: "settling",
        mediaGeneration: "generation-a",
        stableObservationCount: 1,
        settlingResetCount: 1,
      }),
    ]);
    expect(access.discInspections.listAttempts(resumedInspectionId)).toEqual([]);

    settlingWaits.releaseNext();
    await settlingWaits.waitUntilPending();
    settlingWaits.releaseNext();
    await returnedPolling;

    expect(metadataReadCount).toBe(2);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: resumedInspectionId,
        attemptCount: 1,
        status: "completed",
        mediaGeneration: "generation-a",
        settlingResetCount: 1,
      }),
    ]);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ volumeLabel: "DISC_A" }),
    ]);

    await pollArchiveWorker(pollOptions);
    expect(metadataReadCount).toBe(2);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({ id: resumedInspectionId, status: "completed" }),
    ]);
    access.close();
  });

  it.each([
    {
      checkpoint: "before metadata collection",
      changedObservation: 4,
      expectedMetadataReads: 0,
    },
    {
      checkpoint: "after metadata collection",
      changedObservation: 5,
      expectedMetadataReads: 1,
    },
    {
      checkpoint: "before Detected Disc registration",
      changedObservation: 6,
      expectedMetadataReads: 1,
    },
  ])(
    "aborts a generation change $checkpoint",
    async ({ changedObservation, expectedMetadataReads }) => {
      const access = openTestDataAccess();
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
                serial: "SETTLING-FENCE-001",
              }],
            }),
            stderr: "",
          };
        }
        if (executable === "blockdev") {
          return {
            exitCode: 0,
            stdout: "4700372992\n",
            stderr: "",
          };
        }
        if (executable === "rip-dvd-lsdvd") {
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: FENCED_DISC",
              "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        throw new Error(`Unexpected command: ${executable}`);
      });
      const runner: CommandRunner = { run };
      let generationObservationCount = 0;
      const hardware = createLinuxOpticalDriveHardware({
        platform: "linux",
        runner,
        mediaGenerationObserver: {
          observe: vi.fn(async () => {
            generationObservationCount += 1;
            return generationObservationCount >= changedObservation
              ? "generation-b"
              : "generation-a";
          }),
        },
        deviceInstanceObserver: {
          observe: vi.fn().mockResolvedValue("device-instance-1"),
        },
      });

      await pollArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware,
        log: vi.fn(),
        signal: new AbortController().signal,
      });

      const [inspection] = access.discInspections.list();
      expect(inspection).toMatchObject({
        attemptCount: 1,
        status: "aborted",
        reasonCode: "media_changed",
        mediaGeneration: "generation-a",
      });
      expect(access.discInspections.listAttempts(inspection!.id)).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: "aborted",
          reasonCode: "media_changed",
        }),
      ]);
      expect(
        run.mock.calls.filter(([executable]) =>
          executable === "rip-dvd-lsdvd"
        ),
      ).toHaveLength(expectedMetadataReads);
      expect(access.catalog.listDetectedDiscs()).toEqual([]);
      access.close();
    },
  );

  it("keeps three matching observations inside five seconds in settling", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-22T19:00:00.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDataAccess();
    const controller = new AbortController();
    const settlingWaits = createControlledSettlingWaits();
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
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal: controller.signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });

    await settlingWaits.waitUntilPending();
    settlingWaits.releaseNext(2_000);
    await settlingWaits.waitUntilPending();
    settlingWaits.releaseNext(2_000);
    await settlingWaits.waitUntilPending();

    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        phase: "settling",
        stableObservationCount: 3,
        settlingQuietWindowStartedAt: expect.any(Date),
        settlingStartedAt: expect.any(Date),
      }),
    ]);
    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    const interruption = new Error("test complete");
    controller.abort(interruption);
    await expect(polling).rejects.toBe(interruption);
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
          return deviceObservationCount <= 3 ? "41" : "43";
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
      "DVD scan failed for /dev/sr0: Optical Drive instance changed before DVD settling",
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
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-11T13:30:00.000Z"));
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
        waitForNextSettlingObservation: async (intervalMs, signal) => {
          signal.throwIfAborted();
          vi.setSystemTime(new Date(Date.now() + intervalMs));
        },
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

  it("interrupts a settling wait during worker shutdown before metadata starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));
    const access = openTestDataAccess();
    const controller = new AbortController();
    const settlingWaits = createControlledSettlingWaits();
    const scanDvd = vi.fn();
    const waitForNextPoll = vi.fn(
      async (_intervalMs: number, signal: AbortSignal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const polling = runArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-SHUTDOWN-WAIT-001",
        }]),
        scanDvd,
      },
      log: vi.fn(),
      pollIntervalMs: 5_000,
      signal: controller.signal,
      waitForNextPoll,
      waitForNextSettlingObservation: settlingWaits.wait,
    });
    await settlingWaits.waitUntilPending();

    controller.abort(new Error("worker shutdown"));
    await expect(polling).resolves.toBeUndefined();

    expect(settlingWaits.wait).toHaveBeenCalledOnce();
    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("cancels a settling poll promptly without starting metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:10:00.000Z"));
    const access = openTestDataAccess();
    const controller = new AbortController();
    const settlingWaits = createControlledSettlingWaits();
    const scanDvd = vi.fn();
    const polling = pollArchiveWorkerOnce({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-CANCELLATION-001",
        }]),
        scanDvd,
      },
      log: vi.fn(),
      signal: controller.signal,
      waitForNextSettlingObservation: settlingWaits.wait,
    });
    await settlingWaits.waitUntilPending();

    const cancellation = new Error("worker operation cancelled");
    controller.abort(cancellation);
    await expect(polling).rejects.toBe(cancellation);

    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("interrupts a blocked readiness observation during worker shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:15:00.000Z"));
    const access = openTestDataAccess();
    const controller = new AbortController();
    const settlingWaits = createControlledSettlingWaits();
    let observationCount = 0;
    let blockedObservationSignal: AbortSignal | undefined;
    const observeMedia = vi.fn(
      async (_binding: unknown, signal: AbortSignal) => {
        observationCount += 1;
        if (observationCount === 1) {
          return {
            mediaGeneration: "shutdown-generation",
            capacityBytes: 2_048,
          };
        }
        blockedObservationSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const scanDvd = vi.fn();
    const polling = runArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: {
        ...stableDeviceBinding(),
        discover: vi.fn().mockResolvedValue([{
          devicePath: "/dev/sr0",
          serialNumber: "SETTLING-SHUTDOWN-OBSERVE-001",
        }]),
        observeMedia,
        observeMediaGeneration: vi.fn(async () => "shutdown-generation"),
        scanDvd,
      },
      log: vi.fn(),
      pollIntervalMs: 5_000,
      signal: controller.signal,
      waitForNextPoll: async (_intervalMs, signal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      waitForNextSettlingObservation: settlingWaits.wait,
    });
    await settlingWaits.waitUntilPending();
    settlingWaits.releaseNext();
    await vi.waitFor(() => expect(observeMedia).toHaveBeenCalledTimes(2));

    controller.abort(new Error("worker shutdown"));
    await expect(polling).resolves.toBeUndefined();

    expect(blockedObservationSignal?.aborted).toBe(true);
    expect(scanDvd).not.toHaveBeenCalled();
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("cancels an in-flight scan and stops polling during shutdown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-11T14:30:00.000Z"));
    const access = openTestDataAccess();
    const controller = new AbortController();
    access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "CANCEL-001",
        isConfiguredDevice: true,
      },
    ]);
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
        waitForNextSettlingObservation: async (intervalMs, signal) => {
          signal.throwIfAborted();
          vi.setSystemTime(new Date(Date.now() + intervalMs));
        },
      }),
    ).resolves.toBeUndefined();

    expect(scanDvd).toHaveBeenCalledTimes(1);
    expect(waitForNextPoll).toHaveBeenCalledTimes(1);
    access.close();
  });
});
