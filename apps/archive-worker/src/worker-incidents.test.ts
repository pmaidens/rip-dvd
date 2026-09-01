import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type OpticalDriveHardware,
  pollArchiveWorker,
  runArchiveWorker,
} from "./archive-worker.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-incidents-"));
  temporaryDirectories.push(directory);
  return {
    access: createDataAccess({ databasePath: join(directory, "test.sqlite") }),
    originalsLibraryPath: join(directory, "originals"),
  };
}

function emptyHardware(
  discover: OpticalDriveHardware["discover"],
): OpticalDriveHardware {
  return {
    discover,
    bindOpticalDrive: vi.fn(),
    confirmOpticalDrive: vi.fn(),
    observeMedia: vi.fn(),
    observeMediaGeneration: vi.fn(),
    scanDvd: vi.fn(),
  };
}

async function runUntil(
  options: Omit<Parameters<typeof runArchiveWorker>[0], "signal">,
  condition: () => void,
): Promise<void> {
  const controller = new AbortController();
  await runArchiveWorker({
    ...options,
    signal: controller.signal,
    waitForNextPoll: async () => {
      await vi.waitFor(condition);
      controller.abort();
    },
  });
}

describe("Archive Worker Incidents", () => {
  it("coalesces polling failures and resolves them after a successful poll", async () => {
    const fixture = createFixture();
    const diagnostic =
      "/dev/private-drive --scan ENV=hidden claim=private-token";
    const discover = vi.fn<OpticalDriveHardware["discover"]>(async () => {
      throw new Error(diagnostic);
    });
    const log = vi.fn();
    const options = {
      ...fixture,
      configuredDevicePath: "/dev/private-drive",
      hardware: emptyHardware(discover),
      log,
      pollIntervalMs: 1,
    };

    for (const occurrenceCount of [1, 2]) {
      await runUntil(options, () => {
        expect(fixture.access.workerIncidents.list({
          workerKind: "archive",
          resolvedLimit: 20,
        })[0]).toMatchObject({ occurrenceCount, resolvedAt: null });
      });
    }

    const active = fixture.access.workerIncidents.list({
      workerKind: "archive",
      resolvedLimit: 20,
    });
    expect(active).toEqual([
      expect.objectContaining({
        reasonCode: "poll_failure",
        phase: "polling",
        occurrenceCount: 2,
        evidence: {},
      }),
    ]);
    expect(JSON.stringify(active)).not.toContain("/dev/private-drive");
    expect(JSON.stringify(active)).not.toContain("private-token");
    expect(log).toHaveBeenCalledWith(
      `Archive worker poll failed: ${diagnostic}`,
    );

    discover.mockResolvedValue([]);
    await runUntil(options, () => {
      expect(fixture.access.workerIncidents.list({
        workerKind: "archive",
        resolvedLimit: 20,
      })[0]?.resolvedAt).toEqual(expect.any(Date));
    });
    fixture.access.close();
  });

  it("records a drive poll failure that occurs before a Disc Inspection exists", async () => {
    const fixture = createFixture();
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      serialNumber: "UNOWNED-POLL-001",
    };
    const bindOpticalDrive = vi.fn<OpticalDriveHardware["bindOpticalDrive"]>(
      async () => {
        throw new Error("drive binding failed before inspection");
      },
    );
    const hardware: OpticalDriveHardware = {
      ...emptyHardware(vi.fn().mockResolvedValue([discoveredDrive])),
      bindOpticalDrive,
    };
    const log = vi.fn();
    const options = {
      ...fixture,
      configuredDevicePath: discoveredDrive.devicePath,
      hardware,
      log,
      pollIntervalMs: 1,
    };

    await runUntil(options, () => {
      expect(fixture.access.workerIncidents.list({
        workerKind: "archive",
        resolvedLimit: 20,
      })[0]).toMatchObject({
        reasonCode: "poll_failure",
        occurrenceCount: 1,
        resolvedAt: null,
      });
    });
    expect(fixture.access.discInspections.list()).toEqual([]);

    bindOpticalDrive.mockResolvedValue({
      deviceInstanceToken: "recovered-device-instance",
      drive: discoveredDrive,
    });
    hardware.observeMedia = vi.fn().mockResolvedValue(null);
    await runUntil(options, () => {
      expect(fixture.access.workerIncidents.list({
        workerKind: "archive",
        resolvedLimit: 20,
      })[0]?.resolvedAt).toEqual(expect.any(Date));
    });
    expect(log).toHaveBeenCalledWith(
      "DVD scan failed for /dev/sr0: drive binding failed before inspection",
    );
    fixture.access.close();
  });

  it("records and resolves unowned Archive Job claim-recovery failures", async () => {
    const fixture = createFixture();
    const log = vi.fn();
    const recoverExpiredClaims = vi.spyOn(
      fixture.access.archiveJobs,
      "recoverExpiredClaims",
    ).mockImplementation(() => {
      throw new Error("claim recovery database unavailable");
    });
    const options = {
      ...fixture,
      configuredDevicePath: "/dev/sr0",
      hardware: emptyHardware(vi.fn().mockResolvedValue([])),
      log,
      signal: new AbortController().signal,
    };

    await expect(pollArchiveWorker(options)).rejects.toThrow(
      "claim recovery database unavailable",
    );
    expect(fixture.access.workerIncidents.list({
      workerKind: "archive",
      resolvedLimit: 20,
    })).toEqual([
      expect.objectContaining({
        reasonCode: "claim_recovery_failure",
        phase: "claim_recovery",
        evidence: { recoveryArea: "expired_archive_job_claim" },
        resolvedAt: null,
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      "Expired Archive Job claims could not be recovered: claim recovery database unavailable",
    );

    recoverExpiredClaims.mockReturnValue([]);
    await pollArchiveWorker(options);
    expect(fixture.access.workerIncidents.list({
      workerKind: "archive",
      resolvedLimit: 20,
    })[0]?.resolvedAt).toEqual(expect.any(Date));
    fixture.access.close();
  });

  it("keeps the original polling failure and persistence failure in stdout", async () => {
    const fixture = createFixture();
    const log = vi.fn();
    const discover = vi.fn<OpticalDriveHardware["discover"]>(async () => {
      throw new Error("original Archive Worker poll failure");
    });
    vi.spyOn(fixture.access.workerIncidents, "record").mockImplementation(() => {
      throw new Error("incident database failure");
    });

    await runUntil({
      ...fixture,
      configuredDevicePath: "/dev/sr0",
      hardware: emptyHardware(discover),
      log,
      pollIntervalMs: 1,
    }, () => {
      expect(log.mock.calls.map(([message]) => message)).toEqual(
        expect.arrayContaining([
          "Archive worker poll failed: original Archive Worker poll failure",
          "Archive Worker Incident could not be persisted: incident database failure",
        ]),
      );
    });
    fixture.access.close();
  });
});
