import { describe, expect, it, vi } from "vitest";

import { DiscInspectionError } from "./disc-inspection-error.js";
import type { CommandRunner } from "./optical-drive-command-runner.js";
import { createBoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import { createOpticalDriveDvdScanner } from "./optical-drive-dvd-scanner.js";
import { createOpticalDriveScanCache } from "./optical-drive-scan-cache.js";

function validMetadata(volumeLabel: string, titleNumber = 1): string {
  return [
    `Disc Title: ${volumeLabel}`,
    `Title: ${String(titleNumber).padStart(2, "0")}, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0`,
  ].join("\n");
}

async function createScannerFixture({
  mediaGeneration = "generation-17",
  runner,
  signal = new AbortController().signal,
}: {
  mediaGeneration?: string;
  runner: CommandRunner;
  signal?: AbortSignal;
}) {
  const identity = createBoundOpticalDriveIdentity({
    observe: vi.fn().mockResolvedValue("instance-17"),
  });
  const scanner = createOpticalDriveDvdScanner({
    cache: createOpticalDriveScanCache(),
    identity,
    mediaGenerationObserver: {
      observe: vi.fn().mockResolvedValue(mediaGeneration),
    },
    runner,
  });
  const binding = await identity.bind({ devicePath: "/dev/sr0" }, signal);
  return { binding, scanner, signal };
}

describe("Optical Drive DVD scan coordinator", () => {
  it("reuses a stable cached scan as an existing medium observation", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: [
            "Disc Title: CACHED_DISC",
            "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
          ].join("\n"),
          stderr: "",
        }),
    };
    const identity = createBoundOpticalDriveIdentity({
      observe: vi.fn().mockResolvedValue("instance-17"),
    });
    const scanner = createOpticalDriveDvdScanner({
      cache: createOpticalDriveScanCache(),
      identity,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("generation-17"),
      },
      runner,
    });
    const signal = new AbortController().signal;
    const binding = await identity.bind({ devicePath: "/dev/sr0" }, signal);

    const first = await scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    });
    const repeated = await scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    });

    expect(first).toMatchObject({
      fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
      isNewMediumObservation: true,
    });
    expect(repeated).toEqual({
      ...first,
      isNewMediumObservation: false,
    });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("does not reuse cached metadata after direct capacity changes", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: validMetadata("CAPACITY_CHANGED_DISC"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: validMetadata("CAPACITY_CHANGED_DISC"),
        stderr: "",
      });
    const { binding, scanner, signal } = await createScannerFixture({
      runner: { run },
    });

    const oldScan = await scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    });
    const currentScan = await scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 4_096,
    });

    expect(oldScan).toMatchObject({ sizeBytes: 2_048 });
    expect(currentScan).toMatchObject({
      isNewMediumObservation: true,
      sizeBytes: 4_096,
    });
    expect(currentScan?.fingerprint).not.toBe(oldScan?.fingerprint);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports an empty Optical Drive with a structured no-medium outcome", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "Device not ready: no medium found",
        }),
      },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "abort",
        reasonCode: "no_medium",
      }),
    );
  });

  it("reports a spinning-up Optical Drive as a structured retry", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "Device not ready",
        }),
      },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "drive_not_ready",
      }),
    );
  });

  it("reports an lsdvd command failure as a structured metadata retry", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "permission denied",
    });
    const { binding, scanner, signal } = await createScannerFixture({
      runner: { run },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "metadata_read_failed",
      }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("recovers valid titles when unreadable IFO decoys crash the full scan", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: null,
          signal: "SIGSEGV",
          stdout: "",
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: validMetadata("PROTECTED_DISC", 1),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: validMetadata("PROTECTED_DISC", 2),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 4,
          stdout: "",
          stderr: "Can't open ifo 3!",
        })
        .mockResolvedValueOnce({
          exitCode: 4,
          stdout: "",
          stderr: "Can't open ifo 4!",
        })
        .mockResolvedValueOnce({
          exitCode: 4,
          stdout: "",
          stderr: "Can't open ifo 5!",
        }),
    };
    const { binding, scanner, signal } = await createScannerFixture({
      runner,
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 4_096,
    })).resolves.toMatchObject({
      fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
      scanData: {
        titles: [{ number: 1 }, { number: 2 }],
      },
      volumeLabel: "PROTECTED_DISC",
    });
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      "rip-dvd-lsdvd",
      ["-q", "-t", "1", "-Oh", "-a", "-c", "-s", "/dev/sr0"],
      expect.any(Object),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      6,
      "rip-dvd-lsdvd",
      ["-q", "-t", "5", "-Oh", "-a", "-c", "-s", "/dev/sr0"],
      expect.any(Object),
    );
    expect(runner.run).toHaveBeenCalledTimes(6);
  });

  it("reports malformed lsdvd output as a structured metadata failure", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: "Disc Title: BROKEN\nTitle: not a title map",
          stderr: "",
        }),
      },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_metadata",
      }),
    );
  });

  it("requires settled direct capacity instead of reading block-device size", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: validMetadata("MISSING_DIRECT_CAPACITY"),
          stderr: "",
        }),
      },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: undefined as never,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_content",
      }),
    );
  });

  it("reports an invalid content size as a structured contract failure", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: validMetadata("INVALID_SIZE"),
          stderr: "",
        }),
      },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 0,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_content",
      }),
    );
  });

  it("reports a changed medium generation as a structured abort", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      mediaGeneration: "generation-18",
      runner: { run: vi.fn() },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaCapacityBytes: 2_048,
      expectedMediaGeneration: "generation-17",
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "abort",
        reasonCode: "media_changed",
      }),
    );
  });
});
