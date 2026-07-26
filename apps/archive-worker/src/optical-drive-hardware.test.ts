import { describe, expect, it, vi } from "vitest";

import {
  createLinuxOpticalDriveHardware,
  type CommandRunner,
} from "./optical-drive-hardware.js";

describe("Linux Optical Drive hardware boundary", () => {
  it("discovers rom devices and scans a bounded DVD title map", async () => {
    const runner: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: JSON.stringify({
            blockdevices: [
              {
                path: "/dev/sda",
                type: "disk",
                tran: "sata",
                vendor: "ATA",
                model: "SSD",
              },
              {
                path: "/dev/sr0",
                type: "rom",
                tran: "usb",
                vendor: "Pioneer ",
                model: " DVD-RW ",
                serial: "DRIVE-001 ",
              },
            ],
          }),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: [
            "Disc Title: EXAMPLE_DISC",
            "Title: 01, Length: 01:35:11.000 Chapters: 12, Cells: 13, Audio streams: 2, Subpictures: 1",
            "Title: 02, Length: 00:07:30.000 Chapters: 3, Cells: 3, Audio streams: 1, Subpictures: 0",
          ].join("\n"),
          stderr: "",
        }),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
    });
    const signal = new AbortController().signal;

    await expect(hardware.discover(signal)).resolves.toEqual([
      {
        devicePath: "/dev/sr0",
        displayName: "Pioneer DVD-RW",
        vendor: "Pioneer",
        product: "DVD-RW",
        serialNumber: "DRIVE-001",
      },
    ]);
    await expect(hardware.scanDvd("/dev/sr0", signal)).resolves.toEqual({
      fingerprint:
        "sha256:883be17931fa91b49940fe58bebbacba0f38163c760535184fe24245a65b0241",
      volumeLabel: "EXAMPLE_DISC",
      scanData: {
        schemaVersion: 1,
        titles: [
          {
            number: 1,
            durationSeconds: 5_711,
            chapters: 12,
            audioStreams: 2,
            subtitles: 1,
          },
          {
            number: 2,
            durationSeconds: 450,
            chapters: 3,
            audioStreams: 1,
            subtitles: 0,
          },
        ],
      },
    });
    expect(runner.run).toHaveBeenNthCalledWith(
      1,
      "lsblk",
      ["--json", "--output", "PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL"],
      expect.objectContaining({
        maxBufferBytes: 1_048_576,
        signal,
        timeoutMs: 90_000,
      }),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      "lsdvd",
      ["-a", "-c", "-s", "/dev/sr0"],
      expect.objectContaining({
        maxBufferBytes: 1_048_576,
        signal,
        timeoutMs: 90_000,
      }),
    );
  });

  it("fails closed for unsupported platforms, malformed discovery, and unsafe identifiers", async () => {
    const signal = new AbortController().signal;
    const neverRun: CommandRunner = { run: vi.fn() };
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "darwin",
        runner: neverRun,
      }).discover(signal),
    ).rejects.toThrow("supported only on Linux");
    expect(neverRun.run).not.toHaveBeenCalled();

    for (const stdout of [
      "not-json",
      JSON.stringify({ blockdevices: {} }),
      JSON.stringify({
        blockdevices: [{ path: "/tmp/fake-disc", type: "rom" }],
      }),
      JSON.stringify({
        blockdevices: Array.from({ length: 33 }, (_, index) => ({
          path: `/dev/sr${index}`,
          type: "rom",
        })),
      }),
    ]) {
      const runner: CommandRunner = {
        run: vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "" }),
      };
      await expect(
        createLinuxOpticalDriveHardware({
          platform: "linux",
          runner,
        }).discover(signal),
      ).rejects.toThrow();
    }
  });

  it("distinguishes an empty drive from scanner and malformed-output failures", async () => {
    const signal = new AbortController().signal;
    const emptyRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Device not ready: no medium found",
      }),
    };
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: emptyRunner,
      }).scanDvd("/dev/sr0", signal),
    ).resolves.toBeNull();

    const failedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 2,
        stdout: "",
        stderr: `permission denied ${"x".repeat(1_000)}`,
      }),
    };
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: failedRunner,
      }).scanDvd("/dev/sr0", signal),
    ).rejects.toThrow(/^lsdvd exited with status 2: .{1,500}$/);

    const malformedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Disc Title: BROKEN\nTitle: not a title map",
        stderr: "",
      }),
    };
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
      }).scanDvd("/dev/sr0", signal),
    ).rejects.toThrow("no reviewable DVD titles");
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
      }).scanDvd("../../etc/passwd", signal),
    ).rejects.toThrow("unsafe device path");
  });
});
