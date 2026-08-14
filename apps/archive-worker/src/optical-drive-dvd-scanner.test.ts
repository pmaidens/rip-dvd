import { describe, expect, it, vi } from "vitest";

import { DiscInspectionError } from "./disc-inspection-error.js";
import type { CommandRunner } from "./optical-drive-command-runner.js";
import { createBoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import { createOpticalDriveDvdScanner } from "./optical-drive-dvd-scanner.js";
import { createOpticalDriveScanCache } from "./optical-drive-scan-cache.js";
import type { DiscContentReader } from "./optical-disc-content.js";

function validMetadata(volumeLabel: string, titleNumber = 1): string {
  return [
    `Disc Title: ${volumeLabel}`,
    `Title: ${String(titleNumber).padStart(2, "0")}, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0`,
  ].join("\n");
}

async function createScannerFixture({
  contentReader = { hash: vi.fn() },
  mediaGeneration = "generation-17",
  runner,
  signal = new AbortController().signal,
}: {
  contentReader?: DiscContentReader;
  mediaGeneration?: string;
  runner: CommandRunner;
  signal?: AbortSignal;
}) {
  const identity = createBoundOpticalDriveIdentity({
    observe: vi.fn().mockResolvedValue("instance-17"),
  });
  const scanner = createOpticalDriveDvdScanner({
    cache: createOpticalDriveScanCache(),
    contentReader,
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
    const contentId = `sha256:${"c".repeat(64)}`;
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
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "1024\n",
          stderr: "",
        }),
    };
    const contentReader = { hash: vi.fn().mockResolvedValue(contentId) };
    const identity = createBoundOpticalDriveIdentity({
      observe: vi.fn().mockResolvedValue("instance-17"),
    });
    const scanner = createOpticalDriveDvdScanner({
      cache: createOpticalDriveScanCache(),
      contentReader,
      identity,
      mediaGenerationObserver: {
        observe: vi.fn().mockResolvedValue("generation-17"),
      },
      runner,
    });
    const signal = new AbortController().signal;
    const binding = await identity.bind({ devicePath: "/dev/sr0" }, signal);

    const first = await scanner.scan(binding, signal);
    const repeated = await scanner.scan(binding, signal);

    expect(first).toMatchObject({
      fingerprint: contentId,
      isNewMediumObservation: true,
    });
    expect(repeated).toEqual({
      ...first,
      isNewMediumObservation: false,
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(contentReader.hash).toHaveBeenCalledOnce();
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

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
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

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "drive_not_ready",
      }),
    );
  });

  it("reports an lsdvd command failure as a structured metadata retry", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn().mockResolvedValue({
          exitCode: 2,
          stdout: "",
          stderr: "permission denied",
        }),
      },
    });

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "metadata_read_failed",
      }),
    );
  });

  it("recovers valid titles when unreadable IFO decoys crash the full scan", async () => {
    const contentId = `sha256:${"d".repeat(64)}`;
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 139,
          stdout: "",
          stderr:
            "libdvdread: Invalid IFO for title 20 (VTS_20_0.IFO).\nSegmentation fault",
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
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "4096\n",
          stderr: "",
        }),
    };
    const contentReader = { hash: vi.fn().mockResolvedValue(contentId) };
    const { binding, scanner, signal } = await createScannerFixture({
      contentReader,
      runner,
    });

    await expect(scanner.scan(binding, signal)).resolves.toMatchObject({
      fingerprint: contentId,
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
    expect(contentReader.hash).toHaveBeenCalledOnce();
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

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_metadata",
      }),
    );
  });

  it("reports a blockdev failure as a structured content-size retry", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: validMetadata("SIZE_FAILURE"),
            stderr: "",
          })
          .mockResolvedValueOnce({
            exitCode: 1,
            stdout: "",
            stderr: "read failed",
          }),
      },
    });

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "content_size_failed",
      }),
    );
  });

  it("reports an invalid content size as a structured contract failure", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: validMetadata("INVALID_SIZE"),
            stderr: "",
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "not-a-size",
            stderr: "",
          }),
      },
    });

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_content",
      }),
    );
  });

  it("reports content-reader errors as structured read retries regardless of message", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      contentReader: {
        hash: vi.fn().mockRejectedValue(
          new Error("DVD medium changed according to an arbitrary helper string"),
        ),
      },
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: validMetadata("READ_FAILURE"),
            stderr: "",
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "1024",
            stderr: "",
          }),
      },
    });

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "retry",
        reasonCode: "content_read_failed",
      }),
    );
  });

  it("reports an invalid content identity as a structured contract failure", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      contentReader: { hash: vi.fn().mockResolvedValue("not-a-content-id") },
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: validMetadata("INVALID_IDENTITY"),
            stderr: "",
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "1024",
            stderr: "",
          }),
      },
    });

    await expect(scanner.scan(binding, signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_content",
      }),
    );
  });

  it("preserves the AbortSignal reason across the content-reader boundary", async () => {
    const controller = new AbortController();
    const shutdown = new Error("worker shutdown");
    const { binding, scanner } = await createScannerFixture({
      contentReader: {
        hash: vi.fn().mockImplementation(async () => {
          controller.abort(shutdown);
          throw shutdown;
        }),
      },
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: validMetadata("ABORTED_READ"),
            stderr: "",
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "1024",
            stderr: "",
          }),
      },
      signal: controller.signal,
    });

    await expect(scanner.scan(binding, controller.signal)).rejects.toBe(shutdown);
  });

  it("reports a changed medium generation as a structured abort", async () => {
    const { binding, scanner, signal } = await createScannerFixture({
      mediaGeneration: "generation-18",
      runner: { run: vi.fn() },
    });

    await expect(scanner.scan(binding, signal, {
      expectedMediaGeneration: "generation-17",
    })).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "abort",
        reasonCode: "media_changed",
      }),
    );
  });
});
