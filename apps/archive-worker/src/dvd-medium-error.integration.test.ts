import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preserveDvdArchive,
  type DvdCopyRequest,
  type DvdCopyRunner,
} from "./dvd-archiver.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
  DVD_RECOVERY_RESULT_PREFIX,
  formatDvdRecoveryResumeBitmap,
  parseDvdRecoveryResultProtocol,
  type DvdRecoveryResult,
} from "./dvd-recovery-contracts.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";

const nativeTestExecutable =
  process.env.RIP_DVD_NATIVE_TEST_EXECUTABLE ?? "";
const temporaryDirectories: string[] = [];

function fixedMediumSense(lba: number): string {
  const sense = Buffer.alloc(18);
  sense[0] = 0xf0;
  sense[2] = 0x03;
  sense.writeUInt32BE(lba, 3);
  sense[7] = 10;
  sense[12] = 0x11;
  return sense.toString("hex");
}

function descriptorMediumSense(lba: number): string {
  const sense = Buffer.alloc(20);
  sense[0] = 0x72;
  sense[1] = 0x03;
  sense[2] = 0x11;
  sense[7] = 12;
  sense[9] = 10;
  sense[10] = 0x80;
  sense.writeBigUInt64BE(BigInt(lba), 12);
  return sense.toString("hex");
}

function rawCompletionFault(
  lba: number,
  remainingFailures: number | "always",
  sense: string,
): string {
  return `raw@${lba}@${remainingFailures}@2@0@8@${sense.length / 2}@${sense}`;
}

interface SyntheticDvdCopyRunner extends DvdCopyRunner {
  results: DvdRecoveryResult[];
}

function createSyntheticDvdCopyRunner({
  faults,
  sourcePath,
}: {
  faults: string;
  sourcePath: string;
}): SyntheticDvdCopyRunner {
  const results: DvdRecoveryResult[] = [];
  return {
    results,
    async copy(request: DvdCopyRequest): Promise<DvdRecoveryResult> {
      await request.authorizeStart?.();
      request.signal.throwIfAborted();
      const arguments_ = request.resumeFrom === undefined
        ? [
            "copy-test",
            sourcePath,
            request.outputPath,
            String(request.sizeBytes),
            faults,
            "0",
            "valid",
          ]
        : [
            "resume-test",
            sourcePath,
            request.outputPath,
            String(request.sizeBytes),
            faults,
            "0",
            "valid",
            formatDvdRecoveryResumeBitmap(request.resumeFrom),
            request.resumeImageFilesystemIdentity ?? "",
          ];
      const completion = spawnSync(nativeTestExecutable, arguments_, {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (completion.error !== undefined) {
        throw completion.error;
      }
      for (const line of completion.stderr.split("\n")) {
        const match = /^(\d+) bytes copied$/.exec(line);
        if (match !== null) {
          request.onBytesCopied(Number(match[1]));
        }
      }
      if (completion.status !== 0) {
        throw new Error(
          `Synthetic DVD reader failed: ${completion.stderr.trim()}`,
        );
      }
      const payloads = completion.stderr
        .split("\n")
        .filter((line) => line.startsWith(DVD_RECOVERY_RESULT_PREFIX))
        .map((line) => line.slice(DVD_RECOVERY_RESULT_PREFIX.length));
      if (payloads.length !== 1) {
        throw new Error("Synthetic DVD reader result is invalid");
      }
      const result = parseDvdRecoveryResultProtocol(
        payloads[0]!,
        request.sizeBytes,
      );
      results.push(result);
      return result;
    },
    isActive: () => false,
    async withDeviceInactive(_devicePath, mutation) {
      return mutation();
    },
    async waitForInactive() {},
  };
}

function createFixture(archiveRequestId: string) {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-medium-error-"));
  temporaryDirectories.push(directory);
  const originalsLibraryPath = join(directory, "originals");
  mkdirSync(originalsLibraryPath);
  const sourcePath = join(directory, "synthetic-disc.img");
  const content = Buffer.alloc(40 * 2_048);
  for (let index = 0; index < content.length; index += 1) {
    content[index] = index % 251;
  }
  writeFileSync(sourcePath, content);
  const digest = "a".repeat(64);
  const expectedTitleMap = {
    schemaVersion: 2 as const,
    contentId: `dvdmeta-sha256:${digest}`,
    titles: [{
      number: 1,
      durationSeconds: 3_600,
      chapters: 10,
      audioStreams: [],
      subtitles: [],
    }],
  };
  return {
    archivePath: join(
      realpathSync(originalsLibraryPath),
      `dvdmeta-${digest}.iso`,
    ),
    baseOptions: {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap,
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    },
    content,
    originalsLibraryPath,
    sourcePath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.runIf(nativeTestExecutable !== "")(
  "native medium-error rescue through the Archive Worker",
  () => {
    it("publishes a clean archive after a transient initial medium error", async () => {
      const fixture = createFixture(
        "11111111-1111-4111-8111-111111111111",
      );
      const runner = createSyntheticDvdCopyRunner({
        faults: rawCompletionFault(5, 1, fixedMediumSense(5)),
        sourcePath: fixture.sourcePath,
      });
      const salvageValidator = { validate: vi.fn() };

      const preserved = await preserveDvdArchive({
        ...fixture.baseOptions,
        runner,
        salvageValidator,
      });

      expect(runner.results).toEqual([
        createCleanDvdRecoveryResult(fixture.content.byteLength),
      ]);
      expect(preserved.integrityEvidence).toMatchObject({
        integrity: "clean_read",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      });
      expect(readFileSync(preserved.archivePath)).toEqual(fixture.content);
      expect(salvageValidator.validate).not.toHaveBeenCalled();
    });

    it("keeps exact persistent damage through initial copy and resume", async () => {
      const archiveRequestId = "22222222-2222-4222-8222-222222222222";
      const fixture = createFixture(archiveRequestId);
      const initialRunner = createSyntheticDvdCopyRunner({
        faults: [
          rawCompletionFault(5, "always", fixedMediumSense(5)),
          rawCompletionFault(6, "always", descriptorMediumSense(6)),
          rawCompletionFault(9, "always", fixedMediumSense(9)),
        ].join(","),
        sourcePath: fixture.sourcePath,
      });
      const initialResult = createDamagedDvdRecoveryResult(
        fixture.content.byteLength,
        [
          { startLba: 5, sectorCount: 2 },
          { startLba: 9, sectorCount: 1 },
        ],
      );

      await expect(
        preserveDvdArchive({ ...fixture.baseOptions, runner: initialRunner }),
      ).rejects.toThrow("DVD rescue requires validation");

      expect(initialRunner.results).toEqual([initialResult]);
      expect(existsSync(fixture.archivePath)).toBe(false);
      const rescuePaths = dvdRescueWorkspacePaths(
        realpathSync(fixture.originalsLibraryPath),
        archiveRequestId,
      );
      const expectedInitialImage = Buffer.from(fixture.content);
      for (const lba of [5, 6, 9]) {
        expectedInitialImage.fill(0, lba * 2_048, (lba + 1) * 2_048);
      }
      expect(readFileSync(rescuePaths.imagePath)).toEqual(expectedInitialImage);

      const resumeRunner = createSyntheticDvdCopyRunner({
        faults: rawCompletionFault(
          6,
          "always",
          descriptorMediumSense(6),
        ),
        sourcePath: fixture.sourcePath,
      });
      const salvageValidator = {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
          outcome: "accepted" as const,
        }),
      };

      const preserved = await preserveDvdArchive({
        ...fixture.baseOptions,
        runner: resumeRunner,
        salvageValidator,
      });

      expect(resumeRunner.results).toEqual([
        createDamagedDvdRecoveryResult(fixture.content.byteLength, [
          { startLba: 6, sectorCount: 1 },
        ]),
      ]);
      expect(preserved.integrityEvidence).toMatchObject({
        integrity: "watchable_salvage",
        badSectorCount: 1,
        badAreaCount: 1,
        badSectorRanges: [{ startLba: 6, sectorCount: 1 }],
      });
      const expectedResumedImage = Buffer.from(fixture.content);
      expectedResumedImage.fill(0, 6 * 2_048, 7 * 2_048);
      expect(readFileSync(preserved.archivePath)).toEqual(expectedResumedImage);
      expect(salvageValidator.validate).toHaveBeenCalledOnce();
      await preserved.finalizePublication?.();
    });

    it("publishes a clean archive after a transient resume medium error", async () => {
      const fixture = createFixture(
        "33333333-3333-4333-8333-333333333333",
      );
      const initialRunner = createSyntheticDvdCopyRunner({
        faults: rawCompletionFault(
          12,
          "always",
          fixedMediumSense(12),
        ),
        sourcePath: fixture.sourcePath,
      });

      await expect(
        preserveDvdArchive({ ...fixture.baseOptions, runner: initialRunner }),
      ).rejects.toThrow("DVD rescue requires validation");

      const resumeRunner = createSyntheticDvdCopyRunner({
        faults: rawCompletionFault(12, 1, descriptorMediumSense(12)),
        sourcePath: fixture.sourcePath,
      });
      const salvageValidator = { validate: vi.fn() };
      const preserved = await preserveDvdArchive({
        ...fixture.baseOptions,
        runner: resumeRunner,
        salvageValidator,
      });

      expect(resumeRunner.results).toEqual([
        createCleanDvdRecoveryResult(fixture.content.byteLength),
      ]);
      expect(preserved.integrityEvidence).toMatchObject({
        integrity: "clean_read",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      });
      expect(readFileSync(preserved.archivePath)).toEqual(fixture.content);
      expect(salvageValidator.validate).not.toHaveBeenCalled();
      await preserved.finalizePublication?.();
    });

    it("keeps a non-media completion out of recovery and publication", async () => {
      const fixture = createFixture(
        "44444444-4444-4444-8444-444444444444",
      );
      const illegalRequestSense =
        "f00005000000050a00000000210000000000";
      const runner = createSyntheticDvdCopyRunner({
        faults: rawCompletionFault(5, "always", illegalRequestSense),
        sourcePath: fixture.sourcePath,
      });
      const salvageValidator = { validate: vi.fn() };

      await expect(
        preserveDvdArchive({
          ...fixture.baseOptions,
          runner,
          salvageValidator,
        }),
      ).rejects.toThrow("Synthetic DVD reader failed");

      expect(runner.results).toEqual([]);
      expect(existsSync(fixture.archivePath)).toBe(false);
      expect(
        readdirSync(realpathSync(fixture.originalsLibraryPath)).some((name) =>
          name.endsWith(".rip-dvd-rescue.iso"),
        ),
      ).toBe(false);
      expect(salvageValidator.validate).not.toHaveBeenCalled();
    });
  },
);
