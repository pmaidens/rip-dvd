import { describe, expect, it, vi } from "vitest";

import {
  createLinuxOpticalDriveHardware,
  type BinaryCommandRunner,
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
            "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
            "  Audio: 2, Language: fr - Francais, Format: dts, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Comments1, Stream id: 0x89",
            "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20",
            "Title: 02, Length: 00:07:30.000 Chapters: 3, Cells: 3, Audio streams: 1, Subpictures: 0",
            "  Audio: 1, Language: es - Espanol, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
          ].join("\n"),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "4700000000\n",
          stderr: "",
        }),
    };
    const binaryRunner: BinaryCommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: Buffer.alloc(32_768, 0x11),
          stderr: Buffer.alloc(0),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: Buffer.alloc(32_768, 0x22),
          stderr: Buffer.alloc(0),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: Buffer.alloc(32_768, 0x33),
          stderr: Buffer.alloc(0),
        }),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      binaryRunner,
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
        "sha256:955dbd91d6d37be32c27ce0010ce0fbd001b00dae47b2ec913b76bcee45a0783",
      volumeLabel: "EXAMPLE_DISC",
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:955dbd91d6d37be32c27ce0010ce0fbd001b00dae47b2ec913b76bcee45a0783",
        titles: [
          {
            number: 1,
            durationSeconds: 5_711,
            chapters: 12,
            audioStreams: [
              {
                id: 128,
                languageCode: "en",
                language: "English",
                format: "ac3",
                channels: 6,
              },
              {
                id: 137,
                languageCode: "fr",
                language: "Francais",
                format: "dts",
                channels: 2,
              },
            ],
            subtitles: [
              {
                id: 32,
                languageCode: "en",
                language: "English",
                content: "Normal",
              },
            ],
          },
          {
            number: 2,
            durationSeconds: 450,
            chapters: 3,
            audioStreams: [
              {
                id: 128,
                languageCode: "es",
                language: "Espanol",
                format: "ac3",
                channels: 2,
              },
            ],
            subtitles: [],
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
      ["-Oh", "-a", "-c", "-s", "/dev/sr0"],
      expect.objectContaining({
        maxBufferBytes: 1_048_576,
        signal,
        timeoutMs: 90_000,
      }),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      3,
      "blockdev",
      ["--getsize64", "/dev/sr0"],
      expect.objectContaining({ signal, timeoutMs: 90_000 }),
    );
    expect(binaryRunner.run).toHaveBeenCalledTimes(3);
    expect(binaryRunner.run).toHaveBeenNthCalledWith(
      1,
      "dd",
      [
        "if=/dev/sr0",
        "bs=2048",
        "skip=0",
        "count=16",
        "status=none",
      ],
      expect.objectContaining({
        maxBufferBytes: 32_768,
        signal,
        timeoutMs: 90_000,
      }),
    );
  });

  it("distinguishes structurally identical DVDs by bounded content samples", async () => {
    const summary = [
      "Disc Title: GENERIC_DISC",
      "Title: 01, Length: 01:30:00.000 Chapters: 12, Cells: 12, Audio streams: 1, Subpictures: 0",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
    ].join("\n");
    const createHardware = (sampleByte: number) => {
      const runner: CommandRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "4700000000\n",
            stderr: "",
          }),
      };
      const binaryRunner: BinaryCommandRunner = {
        run: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: Buffer.alloc(32_768, sampleByte),
          stderr: Buffer.alloc(0),
        }),
      };
      return createLinuxOpticalDriveHardware({
        platform: "linux",
        runner,
        binaryRunner,
      });
    };
    const signal = new AbortController().signal;

    const first = await createHardware(0x11).scanDvd("/dev/sr0", signal);
    const second = await createHardware(0x22).scanDvd("/dev/sr0", signal);

    expect(first?.scanData.titles).toEqual(second?.scanData.titles);
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
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
    ).rejects.toThrow("malformed DVD title summary");

    const partiallyMalformedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: [
          "Disc Title: PARTIAL",
          "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 0",
          "Title: 02, Length: format-drifted Chapters: 4, Audio streams: 1, Subpictures: 0",
        ].join("\n"),
        stderr: "",
      }),
    };
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: partiallyMalformedRunner,
      }).scanDvd("/dev/sr0", signal),
    ).rejects.toThrow("malformed DVD title summary");
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
      }).scanDvd("../../etc/passwd", signal),
    ).rejects.toThrow("unsafe device path");
  });
});
