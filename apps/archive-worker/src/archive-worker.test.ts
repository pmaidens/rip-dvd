import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker,
  runArchiveWorker,
  type OpticalDriveHardware,
} from "./archive-worker.js";

const temporaryDirectories: string[] = [];

function openTestDataAccess() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-worker-"));
  temporaryDirectories.push(directory);
  return createDataAccess({ databasePath: join(directory, "rip-dvd.sqlite") });
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("archive worker polling", () => {
  it("discovers an enabled Optical Drive and stores its scanned Detected Disc", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDataAccess();
    const hardware: OpticalDriveHardware = {
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
        discover: vi.fn().mockResolvedValue([
          { devicePath: discoveredDevicePath, displayName: "Aliased drive" },
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
      discoveredDevicePath,
      expect.any(AbortSignal),
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
      discoveredDevicePath,
      expect.any(AbortSignal),
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
        .mockResolvedValue([
          { devicePath: replacementDevicePath, serialNumber: "NEW-002" },
        ]);
      const scanDvd = vi.fn().mockResolvedValue(null);
      const options = {
        access,
        configuredDevicePath: configuredAliasPath,
        hardware: { discover, scanDvd },
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
        originalDevicePath,
        expect.any(AbortSignal),
      );
      access.close();
    },
  );

  it("keeps repeated polls idempotent and marks disappeared drives missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDataAccess();
    const discover = vi.fn().mockResolvedValue([
      { devicePath: "/dev/sr0", displayName: "Archive drive" },
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
      hardware: { discover, scanDvd },
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(attachedDrive);
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
      hardware: { discover, scanDvd },
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
      { devicePath: "/dev/sr0", displayName: "Enabled drive" },
      { devicePath: "/dev/sr1", displayName: "Disabled drive" },
    ]);
    const scanDvd = vi.fn().mockResolvedValueOnce(null);
    const options = {
      access,
      configuredDevicePath: "/dev/sr0",
      hardware: { discover, scanDvd },
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
        discover: vi.fn().mockResolvedValue([
          { devicePath: "/dev/sr1", displayName: "Second drive" },
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
        discover: vi.fn().mockResolvedValue([{ devicePath: "/dev/sr1" }]),
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

  it("cancels an in-flight scan and stops polling during shutdown", async () => {
    const access = openTestDataAccess();
    const controller = new AbortController();
    const scanDvd = vi.fn(async (_devicePath: string, signal: AbortSignal) => {
      controller.abort(new Error("worker shutdown"));
      signal.throwIfAborted();
      return null;
    });
    const waitForNextPoll = vi.fn();

    await expect(
      runArchiveWorker({
        access,
        configuredDevicePath: "/dev/sr0",
        hardware: {
          discover: vi.fn().mockResolvedValue([{ devicePath: "/dev/sr0" }]),
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
