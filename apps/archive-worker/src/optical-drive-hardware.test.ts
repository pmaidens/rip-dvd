import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { DiscInspectionError } from "./disc-inspection-error.js";
import { commandFailure } from "./optical-drive-command-runner.js";
import {
  createLinuxOpticalDriveHardware,
  createNodeCommandRunner,
  createNodeDiscContentProbeLauncher,
  createNodeDiscContentReader,
  createNodeFileDiscContentProbeLauncher,
  createHashProgressParser,
  createNodeMediaGenerationProbeLauncher,
  createNodeMediaGenerationObserver,
  type CommandRunner,
  type DiscContentProbeLauncher,
  type MediaGenerationObserver,
} from "./optical-drive-hardware.js";
import { readActiveMediaGeneration } from "./optical-media-probe.js";

const execFileAsync = promisify(execFile);
const nodeFileDiscContentReader = createNodeDiscContentReader({
  probeLauncher: createNodeFileDiscContentProbeLauncher(),
});

async function createStuckThenSuccessfulProbeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "rip-dvd-stuck-probe-"));
  const scriptPath = join(directory, "probe.mjs");
  const countPath = join(directory, "count");
  const pidPath = join(directory, "pids");
  await writeFile(countPath, "0");
  await writeFile(
    scriptPath,
    [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      `const countPath = ${JSON.stringify(countPath)};`,
      `const pidPath = ${JSON.stringify(pidPath)};`,
      'appendFileSync(pidPath, `${process.pid}\\n`);',
      'const count = Number(readFileSync(countPath, "utf8"));',
      'writeFileSync(countPath, String(count + 1));',
      'if (count === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      'process.stdout.write("29\\n");',
    ].join("\n"),
  );
  return {
    async cleanup() {
      await rm(directory, { force: true, recursive: true });
    },
    pidPath,
    scriptPath,
  };
}

async function expectProbeProcessesExited(pidPath: string, count = 2) {
  await vi.waitFor(async () => {
    const pids = (await readFile(pidPath, "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(pids).toHaveLength(count);
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
}

describe("Linux Optical Drive hardware boundary", () => {
  const stableMediaGenerationObserver = (): MediaGenerationObserver => ({
    observe: vi.fn().mockResolvedValue("1"),
  });
  const stableDeviceInstanceObserver = (): MediaGenerationObserver => ({
    observe: vi.fn().mockResolvedValue("test-device-instance"),
  });
  const boundOpticalDrive = (devicePath = "/dev/sr0") => ({
    deviceInstanceToken: "test-device-instance",
    drive: { devicePath },
  });
  const createTestOpticalDriveHardware = (
    options?: Parameters<typeof createLinuxOpticalDriveHardware>[0],
  ) =>
    createLinuxOpticalDriveHardware({
      ...options,
      deviceInstanceObserver:
        options?.deviceInstanceObserver ?? stableDeviceInstanceObserver(),
    });

  it("hashes DVD bytes through the libdvdcss reader", async () => {
    const stdout = new EventEmitter();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 41,
      stderr,
      stdout: Object.assign(stdout, { destroy: vi.fn() }),
      unref: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child);
    const launcher = createNodeDiscContentProbeLauncher({ spawnProcess });
    const progress: number[] = [];

    const active = launcher.start(
      "/dev/sr0",
      7_295_115_264,
      (bytes) => progress.push(bytes),
    );
    stderr.emit("data", Buffer.from("65011712 bytes ha"));
    stderr.emit("data", Buffer.from("shed\nignored diagnostic\n7295115264 bytes hashed\n"));
    stdout.emit("data", Buffer.from(`sha256:${"a".repeat(64)}`));
    child.emit("close", 0, null);

    await expect(active.result).resolves.toBe(`sha256:${"a".repeat(64)}`);
    await expect(active.closed).resolves.toBeUndefined();
    expect(progress).toEqual([65_011_712, 7_295_115_264]);
    expect(spawnProcess).toHaveBeenCalledWith(
      "rip-dvd-dvdcss-reader",
      ["hash", "/dev/sr0", "7295115264"],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("parses chunked monotonic hash progress without treating diagnostics as progress", () => {
    const progress: number[] = [];
    const parser = createHashProgressParser(100, (bytes) => progress.push(bytes));

    parser.push("10 bytes ha");
    parser.push("shed\nnot progress\r50 bytes hashed\r");
    parser.push("50 bytes hashed\n100 bytes hashed");
    parser.finish();

    expect(progress).toEqual([10, 50, 100]);
    expect(parser.diagnostics()).toContain("not progress");
    expect(() => parser.push("101 bytes hashed\n")).toThrow(
      "invalid byte count",
    );
  });

  it("uses the production probe module to hold the device open while reading generation", () => {
    const events: string[] = [];
    const value = readActiveMediaGeneration(
      "/dev/sr0",
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
      "/sys/class/block/sr0/diskseq",
      {
        openSync(path: string, flags: number) {
          events.push(`open:${path}:${flags}`);
          return 7;
        },
        readFileSync(path: string, encoding: "utf8") {
          events.push(`read:${path}:${encoding}`);
          return "17\n";
        },
        closeSync(descriptor: number) {
          events.push(`close:${descriptor}`);
        },
      },
    );

    expect(value).toBe("17\n");
    expect(events).toEqual([
      `open:/dev/sr0:${fsConstants.O_RDONLY | fsConstants.O_NONBLOCK}`,
      "read:/sys/class/block/sr0/diskseq:utf8",
      "close:7",
    ]);
  });

  it("runs the deployed child-process probe module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rip-dvd-generation-"));
    const generationPath = join(directory, "diskseq");
    await writeFile(generationPath, "23\n");
    try {
      const probe = createNodeMediaGenerationProbeLauncher().start(
        "/dev/null",
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
        generationPath,
      );
      await expect(probe.result).resolves.toBe("23\n");
      probe.cancel();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds timeout and shutdown for SIGTERM-resistant device commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rip-dvd-stuck-command-"));
    const scriptPath = join(directory, "command.mjs");
    const pidPath = join(directory, "pids");
    await writeFile(
      scriptPath,
      [
        'import { appendFileSync } from "node:fs";',
        `const pidPath = ${JSON.stringify(pidPath)};`,
        'appendFileSync(pidPath, `${process.pid}\\n`);',
        'process.on("SIGTERM", () => {});',
        "setTimeout(() => process.exit(0), 750);",
      ].join("\n"),
    );
    const runner = createNodeCommandRunner();
    const processHasExited = async (index: number) => {
      await vi.waitFor(
        async () => {
          const pid = Number(
            (await readFile(pidPath, "utf8")).trim().split("\n")[index],
          );
          expect(Number.isSafeInteger(pid)).toBe(true);
          expect(() => process.kill(pid, 0)).toThrow();
        },
        { timeout: 250 },
      );
    };
    try {
      const timedOut = runner.run(process.execPath, [scriptPath], {
        maxBufferBytes: 1_024,
        signal: new AbortController().signal,
        timeoutMs: 50,
      });
      let watchdog: NodeJS.Timeout | undefined;
      try {
        await expect(
          Promise.race([
            timedOut,
            new Promise<never>((_resolve, reject) => {
              watchdog = setTimeout(
                () => reject(new Error("device command outlived its timeout")),
                300,
              );
            }),
          ]),
        ).rejects.toThrow("device command timed out");
      } finally {
        clearTimeout(watchdog);
      }
      await processHasExited(0);

      const controller = new AbortController();
      const cancelled = runner.run(process.execPath, [scriptPath], {
        maxBufferBytes: 1_024,
        signal: controller.signal,
        timeoutMs: 5_000,
      });
      await vi.waitFor(async () => {
        const pids = (await readFile(pidPath, "utf8")).trim().split("\n");
        expect(pids).toHaveLength(2);
      });
      controller.abort(new Error("worker shutdown"));

      await expect(cancelled).rejects.toThrow("worker shutdown");
      await processHasExited(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves and reports a device command termination signal", async () => {
    const runner = createNodeCommandRunner();

    const result = await runner.run(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGSEGV")'],
      {
        maxBufferBytes: 1_024,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGSEGV",
    });
    expect(commandFailure("lsdvd", result).message).toBe(
      "lsdvd terminated by signal SIGSEGV",
    );
  });

  it.each(["stdout", "stderr"])(
    "enforces device-command %s limits in UTF-8 bytes",
    async (stream) => {
      const runner = createNodeCommandRunner();

      await expect(
        runner.run(
          process.execPath,
          ["-e", `process.${stream}.write("€".repeat(400))`],
          {
            maxBufferBytes: 1_024,
            signal: new AbortController().signal,
            timeoutMs: 5_000,
          },
        ),
      ).rejects.toThrow("device command output exceeded its bound");
    },
  );

  it("retains device-command admission until the cancelled process closes", async () => {
    const processes: Array<{
      cancel: ReturnType<typeof vi.fn>;
      resolveClosed(): void;
    }> = [];
    const processLauncher = {
      start: vi.fn(() => {
        let resolveClosed!: () => void;
        const cancel = vi.fn();
        processes.push({ cancel, resolveClosed: () => resolveClosed() });
        return {
          result: new Promise<never>(() => undefined),
          closed: new Promise<void>((resolve) => {
            resolveClosed = resolve;
          }),
          cancel,
        };
      }),
    };
    const runner = createNodeCommandRunner({
      maxActiveCommands: 1,
      processLauncher,
    });
    const firstController = new AbortController();
    const first = runner.run("lsdvd", ["/dev/mock0"], {
      maxBufferBytes: 1_024,
      signal: firstController.signal,
      timeoutMs: 5_000,
    });
    firstController.abort(new Error("worker shutdown"));
    await expect(first).rejects.toThrow("worker shutdown");
    expect(processes[0]!.cancel).toHaveBeenCalledOnce();

    await expect(
      runner.run("lsblk", ["--json"], {
        maxBufferBytes: 1_024,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("device command capacity is exhausted");
    expect(processLauncher.start).toHaveBeenCalledOnce();

    processes[0]!.resolveClosed();
    await Promise.resolve();
    const nextController = new AbortController();
    const next = runner.run("lsblk", ["--json"], {
      maxBufferBytes: 1_024,
      signal: nextController.signal,
      timeoutMs: 5_000,
    });
    nextController.abort(new Error("worker shutdown"));
    await expect(next).rejects.toThrow("worker shutdown");
    expect(processLauncher.start).toHaveBeenCalledTimes(2);
    processes[1]!.resolveClosed();
  });

  it("kills and retires a timed-out production probe before the next observation", async () => {
    const fixture = await createStuckThenSuccessfulProbeFixture();
    const launcher = createNodeMediaGenerationProbeLauncher({
      scriptPath: fixture.scriptPath,
    });
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 500,
      probeLauncher: launcher,
    });
    try {
      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).rejects.toThrow("media observation timed out");
      await expectProbeProcessesExited(fixture.pidPath, 1);
      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).resolves.toBe("29");

      await expectProbeProcessesExited(fixture.pidPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it("kills and retires an aborted production probe before the next observation", async () => {
    const fixture = await createStuckThenSuccessfulProbeFixture();
    const launcher = createNodeMediaGenerationProbeLauncher({
      scriptPath: fixture.scriptPath,
    });
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 2_000,
      probeLauncher: launcher,
    });
    const controller = new AbortController();
    try {
      const observation = observer.observe("/dev/sr0", controller.signal);
      await vi.waitFor(async () => {
        expect((await readFile(fixture.pidPath, "utf8")).trim()).not.toBe("");
      });
      controller.abort();
      await expect(observation).rejects.toThrow(/abort/i);
      await expectProbeProcessesExited(fixture.pidPath, 1);
      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).resolves.toBe("29");
      await expectProbeProcessesExited(fixture.pidPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a timed-out probe single-flight until the helper actually closes", async () => {
    const pendingProbes: Array<{
      cancel: ReturnType<typeof vi.fn>;
      close(): void;
      reject(error: Error): void;
      resolve(value: string): void;
    }> = [];
    const launcher = {
      start: vi.fn(() => {
        let rejectResult!: (error: Error) => void;
        let resolveResult!: (value: string) => void;
        let resolveClosed!: () => void;
        const result = new Promise<string>((resolve, reject) => {
          rejectResult = reject;
          resolveResult = resolve;
        });
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        const probe = {
          cancel: vi.fn(),
          close: resolveClosed,
          reject: rejectResult,
          resolve: resolveResult,
        };
        pendingProbes.push(probe);
        return { cancel: probe.cancel, closed, result };
      }),
    };
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 10,
      probeLauncher: launcher,
    });

    await expect(
      observer.observe("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("media observation timed out");
    await expect(
      observer.observe("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("media observation timed out");

    expect(launcher.start).toHaveBeenCalledTimes(1);
    expect(pendingProbes[0]?.cancel).toHaveBeenCalledTimes(1);

    pendingProbes[0]?.reject(new Error("probe closed after cancellation"));
    pendingProbes[0]?.close();
    await Promise.resolve();
    await Promise.resolve();

    const recoveredObservation = observer.observe(
      "/dev/sr0",
      new AbortController().signal,
    );
    expect(launcher.start).toHaveBeenCalledTimes(2);
    pendingProbes[1]?.resolve("31\n");
    await expect(recoveredObservation).resolves.toBe("31");
  });

  it("bounds never-closing helpers across distinct historical device paths", async () => {
    const launcher = {
      start: vi.fn(() => ({
        cancel: vi.fn(),
        closed: new Promise<void>(() => undefined),
        result: new Promise<string>(() => undefined),
      })),
    };
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 1,
      probeLauncher: launcher,
    });

    for (let device = 0; device < 40; device += 1) {
      await expect(
        observer.observe(`/dev/sr${device}`, new AbortController().signal),
      ).rejects.toThrow(/media observation (?:timed out|capacity is exhausted)/);
    }

    expect(launcher.start).toHaveBeenCalledTimes(32);
    await expect(
      observer.observe("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("media observation timed out");
    expect(launcher.start).toHaveBeenCalledTimes(32);
  });

  it("reuses globally bounded capacity after a historical path actually closes", async () => {
    const probes = new Map<
      string,
      {
        close(): void;
        resolve(value: string): void;
      }
    >();
    const launcher = {
      start: vi.fn((devicePath: string) => {
        let resolveResult!: (value: string) => void;
        let resolveClosed!: () => void;
        const result = new Promise<string>((resolve) => {
          resolveResult = resolve;
        });
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        probes.set(devicePath, {
          close: resolveClosed,
          resolve: resolveResult,
        });
        return { cancel: vi.fn(), closed, result };
      }),
    };
    const observer = createNodeMediaGenerationObserver({
      maxActiveProbes: 2,
      observationTimeoutMs: 5,
      probeLauncher: launcher,
    });

    await expect(
      observer.observe("/dev/sr0", new AbortController().signal),
    ).rejects.toThrow("media observation timed out");
    await expect(
      observer.observe("/dev/sr1", new AbortController().signal),
    ).rejects.toThrow("media observation timed out");
    await expect(
      observer.observe("/dev/sr2", new AbortController().signal),
    ).rejects.toThrow("media observation capacity is exhausted");

    probes.get("/dev/sr0")?.close();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const healthyObservation = observer.observe(
      "/dev/sr2",
      new AbortController().signal,
    );
    probes.get("/dev/sr2")?.resolve("41\n");
    probes.get("/dev/sr2")?.close();
    await expect(healthyObservation).resolves.toBe("41");
    expect(launcher.start).toHaveBeenCalledTimes(3);
  });

  it("retains a production probe tombstone after post-spawn kill errors", async () => {
    const fixture = await createStuckThenSuccessfulProbeFixture();
    const launcher = createNodeMediaGenerationProbeLauncher({
      scriptPath: fixture.scriptPath,
      terminateProcess(child) {
        (
          child as unknown as {
            emit(event: "error", error: Error): void;
          }
        ).emit("error", new Error("kill delivery failed"));
      },
    });
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 100,
      probeLauncher: launcher,
    });
    let stuckPid: number | undefined;
    try {
      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).rejects.toThrow("media observation timed out");
      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).rejects.toThrow("kill delivery failed");

      const pids = (await readFile(fixture.pidPath, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(1);
      stuckPid = pids[0];
      if (stuckPid === undefined) {
        throw new Error("stuck production probe did not report its pid");
      }
      process.kill(stuckPid, "SIGKILL");
      await expectProbeProcessesExited(fixture.pidPath, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).resolves.toBe("29");
      await expectProbeProcessesExited(fixture.pidPath);
    } finally {
      if (stuckPid !== undefined) {
        try {
          process.kill(stuckPid, "SIGKILL");
        } catch {
          // Already reaped.
        }
      }
      await fixture.cleanup();
    }
  });

  it("bounds repeated polls while a production child-process probe stays stuck", async () => {
    const fixture = await createStuckThenSuccessfulProbeFixture();
    const terminateProcess = vi.fn();
    const launcher = createNodeMediaGenerationProbeLauncher({
      scriptPath: fixture.scriptPath,
      // Model SIGKILL remaining pending during uninterruptible SCSI I/O. The
      // launcher still executes its real cancellation and unref path.
      terminateProcess,
    });
    const observer = createNodeMediaGenerationObserver({
      observationTimeoutMs: 500,
      probeLauncher: launcher,
    });
    let stuckPid: number | undefined;
    try {
      for (let poll = 0; poll < 3; poll += 1) {
        await expect(
          observer.observe("/dev/sr0", new AbortController().signal),
        ).rejects.toThrow("media observation timed out");
      }

      const pids = (await readFile(fixture.pidPath, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(1);
      expect(terminateProcess).toHaveBeenCalledTimes(1);
      stuckPid = pids[0];
      if (stuckPid === undefined) {
        throw new Error("stuck production probe did not report its pid");
      }

      process.kill(stuckPid, "SIGKILL");
      await expectProbeProcessesExited(fixture.pidPath, 1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(
        observer.observe("/dev/sr0", new AbortController().signal),
      ).resolves.toBe("29");
      await expectProbeProcessesExited(fixture.pidPath);
    } finally {
      if (stuckPid !== undefined) {
        try {
          process.kill(stuckPid, "SIGKILL");
        } catch {
          // Already reaped.
        }
      }
      await fixture.cleanup();
    }
  });

  it("fails closed before scanning when active media generation is unavailable", async () => {
    const runner: CommandRunner = { run: vi.fn() };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn().mockRejectedValue(
          new Error("Optical Drive media generation is unavailable"),
        ),
      },
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow("media generation is unavailable");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("carries the bound device instance through persistence confirmation", async () => {
    const deviceInstanceObserver: MediaGenerationObserver = {
      observe: vi
        .fn()
        .mockResolvedValueOnce("41")
        .mockResolvedValueOnce("43"),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner: { run: vi.fn() },
      deviceInstanceObserver,
    });
    const signal = new AbortController().signal;
    const binding = await hardware.bindOpticalDrive(
      { devicePath: "/dev/sr0", serialNumber: "DRIVE-001" },
      signal,
    );

    await expect(
      hardware.confirmOpticalDrive(binding, signal),
    ).rejects.toThrow("Optical Drive instance changed before DVD persistence");
    expect(deviceInstanceObserver.observe).toHaveBeenCalledTimes(2);
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
    const metadataFingerprint = expect.stringMatching(
      /^dvdmeta-sha256:[0-9a-f]{64}$/,
    );
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
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
    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).resolves.toEqual({
      fingerprint: metadataFingerprint,
      isNewMediumObservation: true,
      sizeBytes: 4_700_000_000,
      volumeLabel: "EXAMPLE_DISC",
      scanData: {
        schemaVersion: 2,
        contentId: metadataFingerprint,
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
      ["--json", "--output", "PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL"],
      expect.objectContaining({
        maxBufferBytes: 1_048_576,
        signal,
        timeoutMs: 90_000,
      }),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      "rip-dvd-lsdvd",
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
  });

  it("accepts Bookworm lsdvd blank and comma-containing language labels", async () => {
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: [
            "Disc Title: LANGUAGE_DISC",
            "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 1, Subpictures: 1",
            "  Audio: 1, Language:  - Not Specified, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
            "  Subtitle: 1, Language: lv - Latvian, Lettish, Content: Normal, Stream id: 0x20,",
          ].join("\n"),
          stderr: "",
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).resolves.toMatchObject({
      scanData: {
        titles: [
          {
            audioStreams: [
              {
                id: 128,
                language: "Not Specified",
                format: "ac3",
                channels: 2,
              },
            ],
            subtitles: [
              {
                id: 32,
                languageCode: "lv",
                language: "Latvian, Lettish",
                content: "Normal",
              },
            ],
          },
        ],
      },
    });
  });

  it("normalizes unavailable lsdvd stream languages during Disc Inspection", async () => {
    const legacySummary = [
      "Disc Title: HP7_DEATHLY_HALLOWS_PART_1",
      "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 02, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 03, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 04, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 05, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 06, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 07, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 08, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 09, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "Title: 10, Length: 00:00:11.266 Chapters: 2, Cells: 2, Audio streams: 1, Subpictures: 1",
      "  Audio: 1, Language: \uFFFD\uFFFD - , Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Undefined, Stream id: 0x80",
      "  Subtitle: 1, Language: \uFFFD\uFFFD - , Content: Undefined, Stream id: 0x20,",
      "Title: 11, Length: 00:00:11.266 Chapters: 2, Cells: 2, Audio streams: 1, Subpictures: 1",
      "  Audio: 1, Language: \uFFFD\uFFFD - , Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Undefined, Stream id: 0x81",
      "  Subtitle: 1, Language: \uFFFD\uFFFD - , Content: Undefined, Stream id: 0x21,",
      "Title: 12, Length: 02:26:05.000 Chapters: 37, Cells: 37, Audio streams: 1, Subpictures: 1",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
      "  Subtitle: 1, Language: \uFFFD\uFFFD - , Content: Undefined, Stream id: 0x20,",
    ].join("\n");
    const maintainedSummary = legacySummary.replaceAll(
      "\uFFFD\uFFFD - ,",
      "xx - Unknown,",
    );
    const scan = async (summary: string) => {
      const runner: CommandRunner = {
        run: vi.fn()
          .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: "4700000000\n",
            stderr: "",
          }),
      };
      const hardware = createTestOpticalDriveHardware({
        platform: "linux",
        runner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      });
      const result = await hardware.scanDvd(
        boundOpticalDrive(),
        new AbortController().signal,
      );
      return { result, runner };
    };

    const legacy = await scan(legacySummary);
    const maintained = await scan(maintainedSummary);

    expect(legacy.result).toEqual(maintained.result);
    expect(legacy.result?.scanData.titles.map((title) => title.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(legacy.result?.scanData.titles.slice(9)).toEqual([
      {
        number: 10,
        durationSeconds: 11,
        chapters: 2,
        audioStreams: [
          {
            id: 128,
            languageCode: "xx",
            language: "Unknown",
            format: "ac3",
            channels: 6,
          },
        ],
        subtitles: [
          {
            id: 32,
            languageCode: "xx",
            language: "Unknown",
            content: "Undefined",
          },
        ],
      },
      {
        number: 11,
        durationSeconds: 11,
        chapters: 2,
        audioStreams: [
          {
            id: 129,
            languageCode: "xx",
            language: "Unknown",
            format: "ac3",
            channels: 2,
          },
        ],
        subtitles: [
          {
            id: 33,
            languageCode: "xx",
            language: "Unknown",
            content: "Undefined",
          },
        ],
      },
      {
        number: 12,
        durationSeconds: 8_765,
        chapters: 37,
        audioStreams: [
          {
            id: 128,
            languageCode: "en",
            language: "English",
            format: "ac3",
            channels: 6,
          },
        ],
        subtitles: [
          {
            id: 32,
            languageCode: "xx",
            language: "Unknown",
            content: "Undefined",
          },
        ],
      },
    ]);
    expect(legacy.result?.fingerprint).toBe(maintained.result?.fingerprint);
    expect(legacy.runner.run).toHaveBeenCalledTimes(2);
    expect(maintained.runner.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      kind: "audio",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 1, Subpictures: 0",
      row: "  Audio: 1, Language: en - , Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
      message: "lsdvd returned invalid audio language",
    },
    {
      kind: "subtitle",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 1",
      row: "  Subtitle: 1, Language: en - , Content: Normal, Stream id: 0x20,",
      message: "lsdvd returned invalid subtitle language",
    },
  ])("rejects an empty $kind label with an available code", async ({
    title,
    row,
    message,
  }) => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: ["Disc Title: INVALID_LANGUAGE", title, row].join("\n"),
        stderr: "",
      }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow(message);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("inspects a CSS-protected DVD through the packaged metadata reader", async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockImplementation(async (executable: string) => {
        if (executable === "lsdvd") {
          return {
            exitCode: 139,
            stdout: "",
            stderr: "Encrypted DVD support unavailable\nNo css library available",
          };
        }
        if (executable === "rip-dvd-lsdvd") {
          return {
            exitCode: 0,
            stdout: [
              "Disc Title: PROTECTED_DISC",
              "Title: 01, Length: 00:42:00.000 Chapters: 8, Cells: 8, Audio streams: 0, Subpictures: 0",
            ].join("\n"),
            stderr: "",
          };
        }
        if (executable === "blockdev") {
          return { exitCode: 0, stdout: "4700000000\n", stderr: "" };
        }
        throw new Error(`Unexpected command: ${executable}`);
      }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).resolves.toMatchObject({
      volumeLabel: "PROTECTED_DISC",
      scanData: {
        titles: [{ number: 1, durationSeconds: 2_520, chapters: 8 }],
      },
    });
  });

  it.each([
    {
      name: "repeated audio ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 2, Subpictures: 0",
      rows: [
        "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
        "  Audio: 1, Language: fr - Francais, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x81",
      ],
    },
    {
      name: "missing audio ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 2, Subpictures: 0",
      rows: [
        "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
      ],
    },
    {
      name: "out-of-range audio ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 2, Subpictures: 0",
      rows: [
        "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
        "  Audio: 3, Language: fr - Francais, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x81",
      ],
    },
    {
      name: "repeated subtitle ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 2",
      rows: [
        "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20,",
        "  Subtitle: 1, Language: fr - Francais, Content: Normal, Stream id: 0x21,",
      ],
    },
    {
      name: "missing subtitle ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 2",
      rows: [
        "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20,",
      ],
    },
    {
      name: "out-of-range subtitle ordinal",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 2",
      rows: [
        "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20,",
        "  Subtitle: 3, Language: fr - Francais, Content: Normal, Stream id: 0x21,",
      ],
    },
  ])("rejects $name rows", async ({ title, rows }) => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: ["Disc Title: INVALID_STREAMS", title, ...rows].join("\n"),
        stderr: "",
      }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow("lsdvd returned invalid stream ordinals");
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "audio",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 2, Subpictures: 0",
      rows: [
        "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
        "  Audio: 2, Language: fr - Francais, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
      ],
    },
    {
      name: "subtitle",
      title:
        "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 2",
      rows: [
        "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20,",
        "  Subtitle: 2, Language: fr - Francais, Content: Normal, Stream id: 0x20,",
      ],
    },
  ])("rejects duplicate $name source IDs", async ({ title, rows }) => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: ["Disc Title: DUPLICATE_IDS", title, ...rows].join("\n"),
        stderr: "",
      }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: stableMediaGenerationObserver(),
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow("lsdvd returned an invalid DVD title map");
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("actively observes media generation before reusing a successful scan", async () => {
    const summary = [
      "Disc Title: CACHED_DISC",
      "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
    ].join("\n");
    const discovery = {
      exitCode: 0,
      stdout: JSON.stringify({
        blockdevices: [{ path: "/dev/sr0", type: "rom" }],
      }),
      stderr: "",
    };
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(discovery)
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" })
        .mockResolvedValueOnce(discovery),
    };
    const mediaGenerationObserver = stableMediaGenerationObserver();
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver,
    });
    const signal = new AbortController().signal;

    await hardware.discover(signal);
    const first = await hardware.scanDvd(boundOpticalDrive(), signal);
    await hardware.discover(signal);
    const repeated = await hardware.scanDvd(boundOpticalDrive(), signal);

    expect(first).toMatchObject({ isNewMediumObservation: true });
    expect(repeated).toEqual({
      ...first,
      isNewMediumObservation: false,
    });
    expect(mediaGenerationObserver.observe).toHaveBeenCalledTimes(3);
    expect(mediaGenerationObserver.observe).toHaveBeenLastCalledWith(
      "/dev/sr0",
      signal,
    );
  });

  it("retries a transient not-ready drive without caching stable absence", async () => {
    const summary = [
      "Disc Title: SPUN_UP_DISC",
      "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
    ].join("\n");
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: "",
          stderr: "Device not ready",
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: summary, stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" }),
    };
    const mediaGenerationObserver: MediaGenerationObserver = {
      observe: vi.fn().mockResolvedValue("17"),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver,
    });
    const signal = new AbortController().signal;

    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).rejects.toThrow(
      "temporarily not ready",
    );
    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).resolves.toMatchObject({
      volumeLabel: "SPUN_UP_DISC",
      fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
    });
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("detects an inserted DVD when the media generation does not advance", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(200);
    try {
      const runner: CommandRunner = {
        run: vi.fn()
          .mockResolvedValueOnce({
            exitCode: 1,
            stdout: "",
            stderr: "Device not ready: no medium found",
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: [
              "Disc Title: INSERTED_DISC",
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
      const hardware = createTestOpticalDriveHardware({
        platform: "linux",
        runner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      });
      const signal = new AbortController().signal;

      await expect(hardware.scanDvd(boundOpticalDrive(), signal)).rejects.toEqual(
        expect.objectContaining<Partial<DiscInspectionError>>({
          kind: "abort",
          reasonCode: "no_medium",
        }),
      );

      // Worker polls start five seconds apart, so the next scan can begin less
      // than five seconds after the previous lsdvd call completed.
      now.mockReturnValue(5_000);

      await expect(hardware.scanDvd(boundOpticalDrive(), signal)).resolves.toMatchObject({
        volumeLabel: "INSERTED_DISC",
        fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
        isNewMediumObservation: true,
      });
      expect(runner.run).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  });

  it("detects empty-to-disc and A-to-B changes without an external poller or rediscovery", async () => {
    const metadata = (label: string) =>
      [
        `Disc Title: ${label}`,
        "Title: 01, Length: 00:01:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      ].join("\n");
    const runner: CommandRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: "",
          stderr: "Device not ready: no medium found",
        })
        // Disc A appears without another discovery call.
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: metadata("DISC_A"),
          stderr: "",
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" })
        // Disc B replaces A without another discovery call.
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: metadata("DISC_B"),
          stderr: "",
        })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "1024\n", stderr: "" }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn()
          .mockResolvedValueOnce("17")
          .mockResolvedValueOnce("17")
          .mockResolvedValueOnce("18")
          .mockResolvedValueOnce("18")
          .mockResolvedValueOnce("19")
          .mockResolvedValueOnce("19"),
      },
    });
    const signal = new AbortController().signal;

    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).rejects.toEqual(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "abort",
        reasonCode: "no_medium",
      }),
    );
    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).resolves.toMatchObject({
      volumeLabel: "DISC_A",
      fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
    });
    await expect(hardware.scanDvd(boundOpticalDrive(), signal)).resolves.toMatchObject({
      volumeLabel: "DISC_B",
      fingerprint: expect.stringMatching(/^dvdmeta-sha256:[0-9a-f]{64}$/),
    });
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
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn()
          .mockResolvedValueOnce("41")
          .mockResolvedValueOnce("43"),
      },
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow("DVD medium changed during scanning");
  });

  it("uses the same identity for equal-sized DVDs with identical metadata", async () => {
    const summary = [
      "Disc Title: GENERIC_DISC",
      "Title: 01, Length: 01:30:00.000 Chapters: 12, Cells: 12, Audio streams: 1, Subpictures: 0",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 6, AP: 0, Content: Normal, Stream id: 0x80",
    ].join("\n");
    const createHardware = () => {
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
      return createTestOpticalDriveHardware({
        platform: "linux",
        runner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      });
    };
    const signal = new AbortController().signal;

    const first = await createHardware().scanDvd(boundOpticalDrive(), signal);
    const second = await createHardware().scanDvd(boundOpticalDrive(), signal);

    expect(first?.scanData.titles).toEqual(second?.scanData.titles);
    expect(first?.fingerprint).toBe(second?.fingerprint);
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
      const first = await nodeFileDiscContentReader.hash(
        firstPath,
        firstContent.length,
        signal,
      );
      const second = await nodeFileDiscContentReader.hash(
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

  it("cancels without waiting for a blocked raw-disc open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rip-dvd-blocked-open-"));
    const devicePath = join(directory, "blocked-device");
    await execFileAsync("mkfifo", [devicePath]);
    const controller = new AbortController();
    const reader = createNodeDiscContentReader({
      hashTimeoutMs: 5_000,
      probeLauncher: createNodeFileDiscContentProbeLauncher(),
    });
    let shutdownWatchdog: NodeJS.Timeout | undefined;
    try {
      const hashing = reader.hash(devicePath, 1, controller.signal);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error("worker shutdown"));

      await expect(
        Promise.race([
          hashing,
          new Promise<never>((_resolve, reject) => {
            shutdownWatchdog = setTimeout(
              () => reject(new Error("blocked raw-disc open retained shutdown")),
              2_000,
            );
          }),
        ]),
      ).rejects.toThrow("worker shutdown");
    } finally {
      clearTimeout(shutdownWatchdog);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains bounded raw-disc tombstones until child close", async () => {
    const probes = new Map<
      string,
      {
        close(): void;
        resolve(contentId: string): void;
      }
    >();
    const launcher: DiscContentProbeLauncher = {
      start: vi.fn((devicePath) => {
        let resolveResult!: (contentId: string) => void;
        let resolveClosed!: () => void;
        const result = new Promise<string>((resolve) => {
          resolveResult = resolve;
        });
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        probes.set(devicePath, {
          close: resolveClosed,
          resolve: resolveResult,
        });
        return { result, closed, cancel: vi.fn() };
      }),
    };
    const reader = createNodeDiscContentReader({
      hashTimeoutMs: 50,
      maxActiveHashes: 2,
      probeLauncher: launcher,
    });
    const abortHash = async (devicePath: string) => {
      const controller = new AbortController();
      const hashing = reader.hash(devicePath, 1, controller.signal);
      controller.abort(new Error("worker shutdown"));
      await expect(hashing).rejects.toThrow("worker shutdown");
    };

    await abortHash("/dev/sr0");
    await expect(
      reader.hash("/dev/sr0", 2, new AbortController().signal),
    ).rejects.toThrow("DVD content size changed while hashing was active");
    await abortHash("/dev/sr1");
    await expect(
      reader.hash("/dev/sr2", 1, new AbortController().signal),
    ).rejects.toThrow("DVD content hashing capacity is exhausted");
    expect(launcher.start).toHaveBeenCalledTimes(2);

    probes.get("/dev/sr0")?.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovered = reader.hash(
      "/dev/sr2",
      1,
      new AbortController().signal,
    );
    probes.get("/dev/sr2")?.resolve(`sha256:${"e".repeat(64)}`);
    probes.get("/dev/sr2")?.close();

    await expect(recovered).resolves.toBe(`sha256:${"e".repeat(64)}`);
    expect(launcher.start).toHaveBeenCalledTimes(3);
  });

  it("rejects a raw-disc read shorter than its declared size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rip-dvd-short-disc-"));
    const devicePath = join(directory, "short-disc.img");
    await writeFile(devicePath, Buffer.from([1, 2, 3]));
    try {
      await expect(
        nodeFileDiscContentReader.hash(
          devicePath,
          4,
          new AbortController().signal,
        ),
      ).rejects.toThrow("read ended before the declared media size");
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
        }),
    };
    const hardware = createTestOpticalDriveHardware({
      platform: "linux",
      runner,
      mediaGenerationObserver: {
        observe: vi.fn()
          .mockResolvedValueOnce("41")
          .mockResolvedValueOnce("42"),
      },
    });

    await expect(
      hardware.scanDvd(boundOpticalDrive(), new AbortController().signal),
    ).rejects.toThrow("DVD medium changed during scanning");
  });

  it("fails closed for unsupported platforms, malformed discovery, and unsafe identifiers", async () => {
    const signal = new AbortController().signal;
    const neverRun: CommandRunner = { run: vi.fn() };
    await expect(
      createTestOpticalDriveHardware({
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
        createTestOpticalDriveHardware({
          platform: "linux",
          runner,
        }).discover(signal),
      ).rejects.toThrow();
    }
  });

  it("distinguishes an empty drive from scanner and malformed-output failures", async () => {
    const signal = new AbortController().signal;
    const emptyRunner: CommandRunner = {
      run: vi.fn().mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "Device not ready: no medium found",
      }),
    };
    await expect(
      createTestOpticalDriveHardware({
        platform: "linux",
        runner: emptyRunner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      }).scanDvd(boundOpticalDrive(), signal),
    ).rejects.toEqual(expect.objectContaining<Partial<DiscInspectionError>>({
      kind: "abort",
      reasonCode: "no_medium",
    }));

    const failedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: `permission denied ${"x".repeat(1_000)}`,
      }),
    };
    await expect(
      createTestOpticalDriveHardware({
        platform: "linux",
        runner: failedRunner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      }).scanDvd(boundOpticalDrive(), signal),
    ).rejects.toThrow(/^lsdvd exited with status 2: .{1,500}$/);

    const malformedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Disc Title: BROKEN\nTitle: not a title map",
        stderr: "",
      }),
    };
    await expect(
      createTestOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      }).scanDvd(boundOpticalDrive(), signal),
    ).rejects.toThrow("malformed DVD title summary");

    const partiallyMalformedRunner: CommandRunner = {
      run: vi.fn().mockResolvedValueOnce({
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
      createTestOpticalDriveHardware({
        platform: "linux",
        runner: partiallyMalformedRunner,
        mediaGenerationObserver: stableMediaGenerationObserver(),
      }).scanDvd(boundOpticalDrive(), signal),
    ).rejects.toThrow("malformed DVD title summary");
    await expect(
      createTestOpticalDriveHardware({
        platform: "linux",
        runner: malformedRunner,
      }).scanDvd(boundOpticalDrive("../../etc/passwd"), signal),
    ).rejects.toThrow("unsafe device path");
  });
});
