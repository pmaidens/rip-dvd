import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeDvdCopyRunner } from "./dvd-archiver.js";

import {
  DVD_INITIAL_COPY_POLICY_VERSION,
  DVD_INITIAL_COPY_RESULT_PREFIX,
  parseDvdInitialCopyResultProtocol,
  runDvdInitialCopyForArchiveJob,
  type DvdInitialCopyDiagnostic,
  type DvdInitialCopyResult,
  type DvdInitialCopyRunner,
} from "./dvd-initial-copy.js";

const SECTOR_SIZE_BYTES = 2_048;
const createdDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-initial-copy-"));
  createdDirectories.push(directory);
  return directory;
}

function mediumErrorDiagnostic(
  startLba: number,
  sectorCount: number,
): DvdInitialCopyDiagnostic {
  return {
    classification: "tolerable_medium_error" as const,
    classifierVersion: "scsi-read-classifier-v2" as const,
    requestedLba: startLba,
    requestedBlockCount: sectorCount,
    retryOrdinal: 0,
    scsiStatus: 2,
    hostStatus: 0,
    driverStatus: 8,
    senseResponseCode: 0x70,
    senseKey: 0x03,
    asc: 0x11,
    ascq: 0,
    informationLba: startLba,
  };
}

function resultPayload(
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    protocolVersion: 1,
    copyPolicyVersion: DVD_INITIAL_COPY_POLICY_VERSION,
    declaredByteCount: 8 * SECTOR_SIZE_BYTES,
    recoveredByteCount: 4 * SECTOR_SIZE_BYTES,
    skippedSectorCount: 4,
    skippedRegionCount: 2,
    skippedSectorBitmapHex: "c3",
    skippedRequestCount: 2,
    diagnosticsTruncated: false,
    diagnostics: [
      mediumErrorDiagnostic(0, 2),
      mediumErrorDiagnostic(6, 2),
    ],
    ...overrides,
  });
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DVD initial-copy protocol", () => {
  it("returns a clean current map for a complete native copy", () => {
    const result = parseDvdInitialCopyResultProtocol(JSON.stringify({
      protocolVersion: 1,
      copyPolicyVersion: DVD_INITIAL_COPY_POLICY_VERSION,
      declaredByteCount: 4 * SECTOR_SIZE_BYTES,
      recoveredByteCount: 4 * SECTOR_SIZE_BYTES,
      skippedSectorCount: 0,
      skippedRegionCount: 0,
      skippedSectorBitmapHex: "",
      skippedRequestCount: 0,
      diagnosticsTruncated: false,
      diagnostics: [],
    }), 4 * SECTOR_SIZE_BYTES);

    expect(result).toEqual({
      declaredByteCount: 4 * SECTOR_SIZE_BYTES,
      diagnostics: [],
      diagnosticsTruncated: false,
      copyPolicyVersion: DVD_INITIAL_COPY_POLICY_VERSION,
      recoveredByteCount: 4 * SECTOR_SIZE_BYTES,
      skippedRequestCount: 0,
      unrecoveredSourceRanges: [],
    });
  });

  it("normalizes skipped requests into sorted half-open source ranges", () => {
    const result = parseDvdInitialCopyResultProtocol(
      resultPayload(),
      8 * SECTOR_SIZE_BYTES,
    );

    expect(result.unrecoveredSourceRanges).toEqual([
      {
        startLba: 0,
        sectorCount: 2,
        classification: "skipped_untested",
      },
      {
        startLba: 6,
        sectorCount: 2,
        classification: "skipped_untested",
      },
    ]);
    expect(result.diagnostics).toEqual([
      mediumErrorDiagnostic(0, 2),
      mediumErrorDiagnostic(6, 2),
    ]);
  });

  it("keeps an initial one-sector failure classified as skipped", () => {
    const result = parseDvdInitialCopyResultProtocol(resultPayload({
      recoveredByteCount: 7 * SECTOR_SIZE_BYTES,
      skippedSectorCount: 1,
      skippedRegionCount: 1,
      skippedSectorBitmapHex: "08",
      skippedRequestCount: 1,
      diagnostics: [mediumErrorDiagnostic(3, 1)],
    }), 8 * SECTOR_SIZE_BYTES);

    expect(result.unrecoveredSourceRanges).toEqual([{
      startLba: 3,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
  });

  it("merges adjacent skipped requests into one normalized interval", () => {
    const result = parseDvdInitialCopyResultProtocol(resultPayload({
      recoveredByteCount: 4 * SECTOR_SIZE_BYTES,
      skippedSectorCount: 4,
      skippedRegionCount: 1,
      skippedSectorBitmapHex: "0f",
      diagnostics: [
        mediumErrorDiagnostic(0, 2),
        mediumErrorDiagnostic(2, 2),
      ],
    }), 8 * SECTOR_SIZE_BYTES);

    expect(result.unrecoveredSourceRanges).toEqual([{
      startLba: 0,
      sectorCount: 4,
      classification: "skipped_untested",
    }]);
  });

  it.each([
    ["wrong extent", { declaredByteCount: 7 * SECTOR_SIZE_BYTES }],
    ["wrong recovered count", { recoveredByteCount: 5 * SECTOR_SIZE_BYTES }],
    ["wrong skipped count", { skippedSectorCount: 3 }],
    ["wrong region count", { skippedRegionCount: 1 }],
    ["missing diagnostics", { diagnostics: [], diagnosticsTruncated: false }],
    ["out-of-range diagnostic", {
      diagnostics: [mediumErrorDiagnostic(7, 2)],
      skippedRequestCount: 1,
      diagnosticsTruncated: false,
    }],
  ])("rejects a %s", (_label, overrides) => {
    expect(() => parseDvdInitialCopyResultProtocol(
      resultPayload(overrides),
      8 * SECTOR_SIZE_BYTES,
    )).toThrow("DVD initial-copy helper result is malformed");
  });

  it("exposes one bounded terminal result prefix", () => {
    expect(DVD_INITIAL_COPY_RESULT_PREFIX).toBe(
      "rip-dvd-initial-copy-result ",
    );
  });
});

describe("Archive Job DVD initial-copy boundary", () => {
  function createRunner(
    result: DvdInitialCopyResult,
    image: Buffer,
  ): DvdInitialCopyRunner {
    return {
      copyInitial: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, image);
        return result;
      }),
      waitForInactive: vi.fn(async () => {}),
    };
  }

  it("keeps the native image and complete current map from one copy", async () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "initial.iso.partial");
    const image = Buffer.concat([
      Buffer.alloc(SECTOR_SIZE_BYTES, 17),
      Buffer.alloc(SECTOR_SIZE_BYTES, 0),
      Buffer.alloc(SECTOR_SIZE_BYTES, 0),
      Buffer.alloc(SECTOR_SIZE_BYTES, 29),
    ]);
    const nativeResult: DvdInitialCopyResult = {
      copyPolicyVersion: DVD_INITIAL_COPY_POLICY_VERSION,
      declaredByteCount: image.byteLength,
      recoveredByteCount: 2 * SECTOR_SIZE_BYTES,
      skippedRequestCount: 1,
      diagnosticsTruncated: false,
      diagnostics: [mediumErrorDiagnostic(1, 2)],
      unrecoveredSourceRanges: [{
        startLba: 1,
        sectorCount: 2,
        classification: "skipped_untested",
      }],
    };
    const runner = createRunner(nativeResult, image);
    const progress = vi.fn();

    const completed = await runDvdInitialCopyForArchiveJob({
      authorizeCopy: vi.fn(),
      devicePath: "/dev/dvd",
      onProgress: progress,
      outputPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: image.byteLength,
    });

    expect(runner.copyInitial).toHaveBeenCalledOnce();
    expect(readFileSync(outputPath)).toEqual(image);
    expect(completed.unrecoveredSourceRanges).toEqual(
      nativeResult.unrecoveredSourceRanges,
    );
    expect(completed.recoveredByteCount).toBe(2 * SECTOR_SIZE_BYTES);
    expect(completed.imageFilesystemIdentity).toMatch(/^\d+:[1-9]\d*$/);
    expect(progress).toHaveBeenCalledWith({
      phase: "copying",
      progressPercent: 0,
    });
  });

  it("parses an injected native-reader result through the workflow boundary", async () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "native-initial.iso.partial");
    const image = Buffer.concat([
      Buffer.alloc(SECTOR_SIZE_BYTES, 41),
      Buffer.alloc(SECTOR_SIZE_BYTES, 0),
      Buffer.alloc(SECTOR_SIZE_BYTES, 43),
      Buffer.alloc(SECTOR_SIZE_BYTES, 47),
    ]);
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const probeAuthorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const probeAuthorizationGrant = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      write: vi.fn(() => true),
    });
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        {
          destroy: vi.fn(),
          end: vi.fn(() => {
            writeFileSync(outputPath, image);
            stderr.emit("data", Buffer.from(
              `${DVD_INITIAL_COPY_RESULT_PREFIX}${resultPayload({
                declaredByteCount: image.byteLength,
                recoveredByteCount: 3 * SECTOR_SIZE_BYTES,
                skippedSectorCount: 1,
                skippedRegionCount: 1,
                skippedSectorBitmapHex: "02",
                skippedRequestCount: 1,
                diagnostics: [mediumErrorDiagnostic(1, 1)],
              })}\n`,
            ));
            child.emit("close", 0, null);
          }),
        },
        probeAuthorizationReady,
        probeAuthorizationGrant,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnProcess = vi.fn((
      _executable: string,
      _arguments: readonly string[],
      _options: unknown,
    ) => {
      queueMicrotask(() => authorizationReady.emit(
        "data",
        Buffer.from("rip-dvd-copy-authorization-ready\n"),
      ));
      return child;
    });
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: spawnProcess as never,
      timeoutMs: 1_000,
    });

    const completed = await runDvdInitialCopyForArchiveJob({
      devicePath: "/dev/zero",
      onProgress: vi.fn(),
      outputPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: image.byteLength,
    });

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]![1]).toContain(
      "initial-copy-authorized",
    );
    expect(completed.unrecoveredSourceRanges).toEqual([{
      startLba: 1,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
    expect(readFileSync(outputPath)).toEqual(image);
  });

  it.each([
    [
      "a native transport failure",
      "DVD read failed while communicating with the Optical Drive",
    ],
    ["an output failure", "DVD initial-copy output write failed"],
  ])("does not turn %s into source damage", async (_label, message) => {
    const runner: DvdInitialCopyRunner = {
      copyInitial: vi.fn(async () => {
        throw new Error(message);
      }),
      waitForInactive: vi.fn(async () => {}),
    };

    await expect(runDvdInitialCopyForArchiveJob({
      devicePath: "/dev/dvd",
      onProgress: vi.fn(),
      outputPath: join(temporaryDirectory(), "initial.iso.partial"),
      runner,
      signal: new AbortController().signal,
      sizeBytes: 2 * SECTOR_SIZE_BYTES,
    })).rejects.toThrow(message);
    expect(runner.waitForInactive).toHaveBeenCalledOnce();
  });

  it("preserves an Archive Job ownership failure at copy authorization", async () => {
    const ownershipFailure = new Error("Stale archive job attempt");
    const runner: DvdInitialCopyRunner = {
      copyInitial: vi.fn(async ({ authorizeStart }) => {
        await authorizeStart?.();
        throw new Error("copy should not start");
      }),
      waitForInactive: vi.fn(async () => {}),
    };

    await expect(runDvdInitialCopyForArchiveJob({
      authorizeCopy() {
        throw ownershipFailure;
      },
      devicePath: "/dev/dvd",
      onProgress: vi.fn(),
      outputPath: join(temporaryDirectory(), "initial.iso.partial"),
      runner,
      signal: new AbortController().signal,
      sizeBytes: 2 * SECTOR_SIZE_BYTES,
    })).rejects.toBe(ownershipFailure);
    expect(runner.waitForInactive).toHaveBeenCalledOnce();
  });

  it("does not start an initial copy after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner: DvdInitialCopyRunner = {
      copyInitial: vi.fn(),
      waitForInactive: vi.fn(),
    };

    await expect(runDvdInitialCopyForArchiveJob({
      devicePath: "/dev/dvd",
      onProgress: vi.fn(),
      outputPath: join(temporaryDirectory(), "initial.iso.partial"),
      runner,
      signal: controller.signal,
      sizeBytes: 2 * SECTOR_SIZE_BYTES,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.copyInitial).not.toHaveBeenCalled();
  });
});
