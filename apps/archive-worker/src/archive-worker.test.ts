import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  type DiscoveredOpticalDrive,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker,
  runArchiveWorker,
  type OpticalDriveHardware,
} from "./archive-worker.js";
import type { DvdCopyRunner } from "./dvd-archiver.js";
import {
  createLinuxOpticalDriveHardware,
  type CommandRunner,
} from "./optical-drive-hardware.js";

const temporaryDirectories: string[] = [];

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
    observeMediaGeneration: vi.fn(async () => "test-media-generation"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("archive worker polling", () => {
  it("persists metadata findings and hash progress before completing inspection", async () => {
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
    const observedDuringHash: unknown[] = [];
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
        options?.onPhase?.("hashing_content");
        options?.onBytesHashed?.(440);
        observedDuringHash.push(access.discInspections.list({ currentOnly: true })[0]);
        options?.onBytesHashed?.(1_000);
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

    expect(observedDuringHash).toEqual([
      expect.objectContaining({
        phase: "hashing_content",
        volumeLabel: "PROGRESS_DISC",
        titleCount: 1,
        bytesHashed: 440,
        status: "running",
      }),
    ]);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        bytesHashed: 1_000,
        detectedDiscId: expect.any(String),
        status: "completed",
      }),
    ]);
  });

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
      copy: vi.fn(async ({ outputPath, onBytesCopied }) => {
        onBytesCopied(4);
        writeFileSync(outputPath, "dvd-image");
        onBytesCopied(9);
      }),
      isActive: () => false,
    };

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
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
    });
    expect(readFileSync(archive.archivePath, "utf8")).toBe("dvd-image");
    expect(existsSync(`${archive.archivePath}.failed`)).toBe(false);
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
    const original = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "test-media-generation",
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

    const polling = pollArchiveWorker({
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
      copy: vi.fn(async ({ outputPath, onBytesCopied }) => {
        failedPartialPath = outputPath;
        onBytesCopied(4);
        writeFileSync(outputPath, "partial");
        throw new Error("dd read failed");
      }),
      isActive: () => false,
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
      copy: vi.fn(async ({ outputPath, onBytesCopied }) => {
        interruptedPartialPath = outputPath;
        writeFileSync(outputPath, "partial");
        onBytesCopied(4);
        controller.abort(interruption);
      }),
      isActive: () => false,
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
        return new Promise<void>((_resolve, reject) => {
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

  it("cooperatively aborts active archive work after request cancellation", async () => {
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
    const copyRunner: DvdCopyRunner = {
      isActive: () => false,
      copy: vi.fn(({ signal }) => {
        copyStarted();
        return new Promise<void>((_resolve, reject) => {
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
    await polling;

    expect(access.archiveJobs.list(["aborted"])).toEqual([
      expect.objectContaining({ errorMessage: "Archive cancelled by operator" }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(log).toHaveBeenCalledWith("DVD archive cancelled for /dev/sr0");
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
        lastSeenAt: new Date("2026-07-26T18:00:00.000Z"),
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

  it("does not persist a disc when authorized hardware is replaced during scanning", async () => {
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
                    discoveryCount <= 3 ? "OLD-DRIVE" : "NEW-DRIVE",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (executable === "lsdvd") {
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
          return { exitCode: 0, stdout: "1024\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader: {
        hash: vi
          .fn()
          .mockResolvedValue(
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          ),
      },
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
      "lsdvd",
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
        if (executable === "lsdvd") {
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
          return { exitCode: 0, stdout: "1024\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardwareOptions = {
      platform: "linux" as NodeJS.Platform,
      runner,
      contentReader: {
        hash: vi
          .fn()
          .mockResolvedValue(
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          ),
      },
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
      "lsdvd",
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
        if (executable === "lsdvd") {
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
          return { exitCode: 0, stdout: "1024\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader: {
        hash: vi
          .fn()
          .mockResolvedValue(
            "sha256:abababababababababababababababababababababababababababababababab",
          ),
      },
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("7"),
      },
      deviceInstanceObserver: {
        observe: vi
          .fn()
          .mockResolvedValueOnce("41")
          .mockResolvedValueOnce("41")
          .mockResolvedValue("43"),
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
      "lsdvd",
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
      const discover = vi
        .fn()
        .mockResolvedValueOnce([
          { devicePath: originalDevicePath, serialNumber: "OLD-001" },
          { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
        ])
        .mockResolvedValueOnce([
          { devicePath: originalDevicePath, serialNumber: "OLD-001" },
          { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
        ])
        .mockResolvedValueOnce([
          { devicePath: originalDevicePath, serialNumber: "OLD-001" },
          { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
        ])
        .mockResolvedValue([
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
    const discover = vi.fn()
      .mockResolvedValueOnce(attachedDrive)
      .mockResolvedValueOnce(attachedDrive)
      .mockResolvedValueOnce(attachedDrive)
      .mockResolvedValueOnce(attachedDrive)
      .mockResolvedValueOnce([])
      .mockResolvedValue(attachedDrive);
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
    await pollArchiveWorker(options);
    vi.setSystemTime(new Date("2026-07-29T18:00:00.000Z"));
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
        detectedAt: new Date("2026-07-29T18:00:00.000Z"),
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
      const polling = pollArchiveWorker({
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
    const scanDvd = vi.fn(
      async (_binding: unknown, signal: AbortSignal) => {
        controller.abort(new Error("worker shutdown"));
        signal.throwIfAborted();
        return null;
      },
    );
    const waitForNextPoll = vi.fn();

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
    expect(waitForNextPoll).not.toHaveBeenCalled();
    access.close();
  });
});
