import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createLinuxOpticalDriveHardware,
  nodeDiscContentReader,
  type CommandRunner,
  type DiscContentReader,
  type MediaGenerationReader,
} from "./optical-drive-hardware.js";

describe("Linux Optical Drive hardware boundary", () => {
  const stableMediaGenerationReader = (): MediaGenerationReader => ({
    read: vi.fn().mockResolvedValue("1"),
  });

  it("discovers rom devices and scans a bounded DVD title map", async () => {
    const summary = [
      "Disc Title: EXAMPLE_DISC",
      "Title: 01, Length: 01:35:11.000 Chapters: 12, Cells: 13, Audio streams: 2, Subpictures: 2",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
      "  Audio: 2, Language: fr - Francais, Format: dts, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Comments1, Stream id: 0x89",
      "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20,",
      "  Subtitle: 2, Language: xx - Unknown, Content: Undefined, Stream id: 0x21,",
      "Title: 02, Length: 00:07:30.000 Chapters: 3, Cells: 3, Audio streams: 1, Subpictures: 0",
      "  Audio: 1, Language: es - Espanol, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
    ].join("\n");
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
                diskseq: "17",
              },
            ],
          }),
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: summary,
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "4700000000\n",
          stderr: "",
        }),
    };
    const contentId = `sha256:${"c".repeat(64)}`;
    const contentReader: DiscContentReader = {
      hash: vi.fn().mockResolvedValue(contentId),
    };
    const mediaGenerationReader: MediaGenerationReader = {
      read: vi.fn().mockResolvedValue("17"),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader,
      mediaGenerationReader,
    });
    const signal = new AbortController().signal;

    await expect(hardware.discover(signal)).resolves.toEqual([
      {
        devicePath: "/dev/sr0",
        displayName: "Pioneer DVD-RW",
        vendor: "Pioneer",
        product: "DVD-RW",
        serialNumber: "DRIVE-001",
        mediaGeneration: "17",
      },
    ]);
    await expect(hardware.scanDvd("/dev/sr0", signal)).resolves.toEqual({
      fingerprint: contentId,
      volumeLabel: "EXAMPLE_DISC",
      scanData: {
        schemaVersion: 2,
        contentId,
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
              {
                id: 33,
                languageCode: "xx",
                language: "Unknown",
                content: "Undefined",
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
      ["--json", "--output", "PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL,DISKSEQ"],
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
    expect(contentReader.hash).toHaveBeenCalledOnce();
    expect(contentReader.hash).toHaveBeenCalledWith(
      "/dev/sr0",
      4_700_000_000,
      signal,
    );
    expect(mediaGenerationReader.read).toHaveBeenCalledTimes(2);
  });

  it("reuses a successful scan until discovery observes a new media generation", async () => {
    const summary = [
      "Disc Title: CACHED_DISC",
      "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
    ].join("\n");
    const discovery = (diskseq: string) => ({
      exitCode: 0,
      stdout: JSON.stringify({
        blockdevices: [{ path: "/dev/sr0", type: "rom", diskseq }],
      }),
      stderr: "",
    });
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(discovery("17"))
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" })
        .mockResolvedValueOnce(discovery("17")),
    };
    const contentReader: DiscContentReader = {
      hash: vi.fn().mockResolvedValue(`sha256:${"c".repeat(64)}`),
    };
    const mediaGenerationReader: MediaGenerationReader = {
      read: vi.fn().mockResolvedValue("17"),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader,
      mediaGenerationReader,
    });
    const signal = new AbortController().signal;

    await hardware.discover(signal);
    const first = await hardware.scanDvd("/dev/sr0", signal);
    await hardware.discover(signal);
    const repeated = await hardware.scanDvd("/dev/sr0", signal);

    expect(repeated).toEqual(first);
    expect(contentReader.hash).toHaveBeenCalledOnce();
  });

  it("rejects an A to B to A swap using the monotonic media generation", async () => {
    const summary = [
      "Disc Title: TRANSIENT_DISC_B",
      "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
    ].join("\n");
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" }),
    };
    const mediaGenerationReader: MediaGenerationReader = {
      read: vi.fn()
        .mockResolvedValueOnce("41")
        .mockResolvedValueOnce("43"),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader: {
        hash: vi.fn().mockResolvedValue(`sha256:${"a".repeat(64)}`),
      },
      mediaGenerationReader,
    });

    await expect(
      hardware.scanDvd("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("DVD medium changed during scanning");
  });

  it("distinguishes equal-sized DVDs that differ outside the old fixed samples", async () => {
    const summary = [
      "Disc Title: GENERIC_DISC",
      "Title: 01, Length: 01:30:00.000 Chapters: 12, Cells: 12, Audio streams: 1, Subpictures: 0",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
    ].join("\n");
    const createHardware = (contentId: string) => {
      const runner: CommandRunner = {
        run: vi
          .fn()
          .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "4700000000\n",
            stderr: "",
          })
          .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "4700000000\n",
            stderr: "",
          }),
      };
      const contentReader: DiscContentReader = {
        hash: vi.fn().mockResolvedValue(contentId),
      };
      return createLinuxOpticalDriveHardware({
        platform: "linux",
        runner,
        contentReader,
        mediaGenerationReader: stableMediaGenerationReader(),
      });
    };
    const signal = new AbortController().signal;

    const first = await createHardware(
      `sha256:${"a".repeat(64)}`,
    ).scanDvd("/dev/sr0", signal);
    const second = await createHardware(
      `sha256:${"b".repeat(64)}`,
    ).scanDvd("/dev/sr0", signal);

    expect(first?.scanData.titles).toEqual(second?.scanData.titles);
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it("hashes every declared byte instead of only fixed content samples", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rip-dvd-content-"));
    const firstPath = join(directory, "first-disc.img");
    const secondPath = join(directory, "second-disc.img");
    const firstContent = Buffer.alloc(262_144);
    const secondContent = Buffer.from(firstContent);
    secondContent[65_536] = 1;
    await writeFile(firstPath, firstContent);
    await writeFile(secondPath, secondContent);
    try {
      const signal = new AbortController().signal;
      const first = await nodeDiscContentReader.hash(
        firstPath,
        firstContent.length,
        signal,
      );
      const second = await nodeDiscContentReader.hash(
        secondPath,
        secondContent.length,
        signal,
      );

      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first).not.toBe(second);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a scan when the medium changes around metadata collection", async () => {
    const summary = [
      "Disc Title: SWAPPED_DISC",
      "Title: 01, Length: 01:30:00.000 Chapters: 12, Cells: 12, Audio streams: 0, Subpictures: 0",
    ].join("\n");
    const runner: CommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "4700000000\n",
          stderr: "",
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "4700000000\n",
          stderr: "",
        }),
    };
    const contentReader: DiscContentReader = {
      hash: vi.fn().mockResolvedValue(`sha256:${"a".repeat(64)}`),
    };
    const hardware = createLinuxOpticalDriveHardware({
      platform: "linux",
      runner,
      contentReader,
      mediaGenerationReader: {
        read: vi.fn().mockResolvedValueOnce("41").mockResolvedValueOnce("42"),
      },
    });

    await expect(
      hardware.scanDvd("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("DVD medium changed during scanning");
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
        mediaGenerationReader: stableMediaGenerationReader(),
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
        mediaGenerationReader: stableMediaGenerationReader(),
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
        mediaGenerationReader: stableMediaGenerationReader(),
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
        mediaGenerationReader: stableMediaGenerationReader(),
      }).scanDvd("/dev/sr0", signal),
    ).rejects.toThrow("malformed DVD title summary");
    await expect(
      createLinuxOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
        mediaGenerationReader: stableMediaGenerationReader(),
      }).scanDvd("../../etc/passwd", signal),
    ).rejects.toThrow("unsafe device path");
  });
});
