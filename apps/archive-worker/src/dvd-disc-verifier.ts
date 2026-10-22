import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

import {
  assertDvdSourceSampleManifestProjection,
  createDvdSourceSampleDigest,
  dvdDiscVerificationOutcome,
  dvdDiscVerificationCheckpointIsCurrent,
  dvdDiscVerificationInsertionIsCurrent,
  normalizeDvdDiscVerificationDiagnostic,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS,
  type DataAccess,
  type DvdDiscVerificationDiagnostic,
  type DvdDiscVerificationSampleFinding,
  type DvdSourceSampleManifest,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import {
  requireSafeOpticalDevicePath,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";
import {
  DVD_READ_FAILURE_RESULT_PREFIX,
  DVD_READ_FAILURE_CLASSIFIER_VERSION,
  parseDvdReadFailureTerminalResultProtocol,
} from "./dvd-recovery-contracts.js";
import type { ActiveBoundedProcess } from "./bounded-child-process.js";

const FLOCK_CONFLICT_EXIT_CODE = 75;
const MAX_DIAGNOSTIC_BYTES = 65_536;

const VERIFICATION_FAILURE_KEYS = [
  "asc", "ascq", "category", "classifierVersion", "driverStatus",
  "hostStatus", "informationLba", "protocolVersion", "requestedBlockCount",
  "requestedLba", "retryOrdinal", "scsiStatus", "senseKey",
  "senseResponseCode",
].sort();

export function parseDvdVerificationReadFailureProtocol(
  payload: string,
  expected: { startLba: number; sectorCount: number; acceptedEndLbaExclusive: number },
): DvdDiscVerificationDiagnostic {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD verification read failure result is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DVD verification read failure result is malformed");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.category === "out_of_range") {
    const { readFailure } = parseDvdReadFailureTerminalResultProtocol(
      payload,
      expected.acceptedEndLbaExclusive * 2_048,
    );
    if (
      readFailure.requestedLba !== expected.startLba ||
      readFailure.requestedBlockCount !== expected.sectorCount ||
      readFailure.retryOrdinal !== 0
    ) {
      throw new Error("DVD verification read failure result is malformed");
    }
    return {
      category: readFailure.category,
      classifierVersion: readFailure.classifierVersion,
      scsiStatus: readFailure.scsiStatus,
      hostStatus: readFailure.hostStatus,
      driverStatus: readFailure.driverStatus,
      senseResponseCode: readFailure.senseResponseCode,
      senseKey: readFailure.senseKey,
      asc: readFailure.asc,
      ascq: readFailure.ascq,
      informationLba: readFailure.informationLba,
    };
  }
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== VERIFICATION_FAILURE_KEYS.length ||
    keys.some((key, index) => key !== VERIFICATION_FAILURE_KEYS[index]) ||
    candidate.protocolVersion !== 1 ||
    candidate.classifierVersion !== DVD_READ_FAILURE_CLASSIFIER_VERSION ||
    candidate.requestedLba !== expected.startLba ||
    candidate.requestedBlockCount !== expected.sectorCount ||
    candidate.retryOrdinal !== 0
  ) {
    throw new Error("DVD verification read failure result is malformed");
  }
  try {
    return normalizeDvdDiscVerificationDiagnostic(
      candidate as Parameters<
        typeof normalizeDvdDiscVerificationDiagnostic
      >[0],
      expected,
      "read_failure_protocol",
    );
  } catch {
    throw new Error("DVD verification read failure result is malformed");
  }
}

export type DvdVerificationSourceRead =
  | { outcome: "readable"; bytes: Buffer }
  | { outcome: "unreadable"; diagnostic: DvdDiscVerificationDiagnostic };

export interface DvdVerificationSourceReader {
  start(input: {
    devicePath: string;
    startLba: number;
    sectorCount: number;
    acceptedEndLbaExclusive: number;
    timeoutMs: number;
  }): ActiveBoundedProcess<DvdVerificationSourceRead>;
}

class DvdVerificationReadDeadlineError extends Error {
  constructor() {
    super("DVD verification source read exceeded its deadline");
    this.name = "DvdVerificationReadDeadlineError";
  }
}

class DvdVerificationReadStoppedError extends Error {
  constructor(readonly reason: "deadline" | "interrupted") {
    super(`DVD verification source read stopped: ${reason}`);
    this.name = "DvdVerificationReadStoppedError";
  }
}

function openDeviceLock(devicePath: string): number {
  const descriptor = openSync(
    devicePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(devicePath);
    if (
      (!opened.isBlockDevice() && !opened.isCharacterDevice()) ||
      (!linked.isBlockDevice() && !linked.isCharacterDevice()) ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) throw new Error("DVD verification device lock is unsafe");
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function createNodeDvdVerificationSourceReader():
  DvdVerificationSourceReader {
  return {
    start(input) {
      const devicePath = requireSafeOpticalDevicePath(input.devicePath);
      if (
        !Number.isSafeInteger(input.startLba) ||
        input.startLba < 0 ||
        !Number.isSafeInteger(input.sectorCount) ||
        input.sectorCount <= 0 ||
        input.startLba + input.sectorCount > input.acceptedEndLbaExclusive ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs <= 0 ||
        input.timeoutMs > DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS
      ) throw new Error("DVD verification source read is invalid");
      const lockDescriptor = openDeviceLock(devicePath);
      const child = spawn("flock", [
        "--exclusive",
        "--nonblock",
        "--no-fork",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        "/proc/self/fd/3",
        "rip-dvd-dvdcss-reader",
        "verify-sample-v1",
        devicePath,
        String(input.startLba),
        String(input.sectorCount),
        String(input.acceptedEndLbaExclusive),
        String(Math.max(1, Math.ceil(input.timeoutMs / 1_000))),
      ], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe", lockDescriptor],
      });
      closeSync(lockDescriptor);
      if (child.stdout === null || child.stderr === null) {
        child.kill("SIGKILL");
        throw new Error("DVD verification helper pipes are unavailable");
      }
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      let resolveResult!: (value: DvdVerificationSourceRead) => void;
      let rejectResult!: (reason: unknown) => void;
      let resolveClosed!: () => void;
      let processClosed = false;
      let operationSettled = false;
      let cancellationRequested = false;
      const result = new Promise<DvdVerificationSourceRead>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const rejectOperation = (error: unknown) => {
        if (!operationSettled) {
          operationSettled = true;
          rejectResult(error);
        }
      };
      const resolveOperation = (value: DvdVerificationSourceRead) => {
        if (!operationSettled) {
          operationSettled = true;
          resolveResult(value);
        }
      };
      const confirmClosed = () => {
        if (!processClosed) {
          processClosed = true;
          resolveClosed();
        }
      };
      {
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderr = "";
        let overflow = false;
        childStdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > DVD_SOURCE_SAMPLE_BYTE_COUNT) {
            overflow = true;
            child.kill("SIGKILL");
            return;
          }
          stdout.push(chunk);
        });
        childStderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`;
          if (Buffer.byteLength(stderr) > MAX_DIAGNOSTIC_BYTES) {
            overflow = true;
            stderr = stderr.slice(-MAX_DIAGNOSTIC_BYTES);
            child.kill("SIGKILL");
          }
        });
        child.once("error", (error) => {
          rejectOperation(error);
          if (child.pid === undefined) confirmClosed();
        });
        child.once("close", (code, signal) => {
          confirmClosed();
          if (cancellationRequested) {
            rejectOperation(new Error("DVD verification source read was cancelled"));
            return;
          }
          if (signal === "SIGALRM") {
            rejectOperation(new DvdVerificationReadDeadlineError());
            return;
          }
          if (overflow || signal !== null) {
            rejectOperation(new Error("DVD verification helper output is invalid"));
            return;
          }
          if (code === 0) {
            const bytes = Buffer.concat(stdout);
            if (bytes.length !== DVD_SOURCE_SAMPLE_BYTE_COUNT) {
              rejectOperation(new Error("DVD verification helper returned a short sample"));
              return;
            }
            resolveOperation({ outcome: "readable", bytes });
            return;
          }
          const line = stderr.split("\n")
            .find((value) => value.startsWith(DVD_READ_FAILURE_RESULT_PREFIX));
          if (code !== 3 || line === undefined) {
            rejectOperation(new Error("DVD verification helper failed"));
            return;
          }
          const diagnostic = parseDvdVerificationReadFailureProtocol(
            line.slice(DVD_READ_FAILURE_RESULT_PREFIX.length),
            input,
          );
          resolveOperation({
            outcome: "unreadable",
            diagnostic,
          });
        });
      }
      return {
        result,
        closed,
        cancel() {
          if (cancellationRequested || processClosed) return;
          cancellationRequested = true;
          childStdout.destroy();
          childStderr.destroy();
          child.kill("SIGKILL");
        },
      };
    },
  };
}

async function runBoundedDvdVerificationSourceRead(input: {
  active: ActiveBoundedProcess<DvdVerificationSourceRead>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<
  | { outcome: "completed"; read: DvdVerificationSourceRead }
  | { outcome: "stopped"; reason: "deadline" | "interrupted" }
> {
  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(
      new DvdVerificationReadStoppedError("interrupted"),
    );
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    removeAbortListener = () =>
      input.signal?.removeEventListener("abort", onAbort);
    timeout = setTimeout(() => reject(
      new DvdVerificationReadStoppedError("deadline"),
    ), input.timeoutMs);
    timeout.unref();
  });
  try {
    const read = await Promise.race([input.active.result, stopped]);
    await input.active.closed;
    return { outcome: "completed", read };
  } catch (error) {
    input.active.cancel();
    await input.active.closed;
    if (error instanceof DvdVerificationReadStoppedError) {
      return { outcome: "stopped", reason: error.reason };
    }
    if (error instanceof DvdVerificationReadDeadlineError) {
      return { outcome: "stopped", reason: "deadline" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    removeAbortListener();
  }
}

export async function verifyInsertedDvdAgainstSamples(input: {
  manifest: DvdSourceSampleManifest | null;
  sourceMetadataFingerprint: string;
  observedMetadataFingerprint: string;
  devicePath: string;
  reader: DvdVerificationSourceReader;
  startedAtMs: number;
  now?(): number;
  signal?: AbortSignal;
  insertionIsCurrent(): boolean | Promise<boolean>;
  checkpointIsCurrent(): boolean;
  authorizeRead?(): boolean | Promise<boolean>;
  recordFinding?(
    finding: DvdDiscVerificationSampleFinding,
  ): void | Promise<void>;
}) {
  const now = input.now ?? Date.now;
  const manifest = input.manifest;
  const metadataMatches = input.observedMetadataFingerprint ===
    input.sourceMetadataFingerprint;
  const sourceCoverageComplete = manifest?.samples.length ===
    DVD_SOURCE_SAMPLE_BAND_COUNT;
  const findings: DvdDiscVerificationSampleFinding[] = [];
  let budgetExhausted = false;
  let interrupted = false;
  let insertionChanged = !await input.insertionIsCurrent();
  let checkpointChanged = !input.checkpointIsCurrent();
  for (const sample of manifest?.samples ?? []) {
    if (insertionChanged || checkpointChanged) break;
    if (input.signal?.aborted) {
      interrupted = true;
      break;
    }
    let elapsedMs = now() - input.startedAtMs;
    if (elapsedMs >= DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS) {
      budgetExhausted = true;
      break;
    }
    if (input.authorizeRead !== undefined) {
      if (!await input.authorizeRead()) {
        interrupted = true;
        break;
      }
      elapsedMs = now() - input.startedAtMs;
      if (elapsedMs >= DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS) {
        budgetExhausted = true;
        break;
      }
    }
    const timeoutMs = DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS - elapsedMs;
    const activeRead = input.reader.start({
      devicePath: input.devicePath,
      startLba: sample.startLba,
      sectorCount: sample.sectorCount,
      acceptedEndLbaExclusive: manifest!.acceptedEndLbaExclusive,
      timeoutMs,
    });
    const boundedRead = await runBoundedDvdVerificationSourceRead({
      active: activeRead,
      signal: input.signal,
      timeoutMs,
    });
    if (boundedRead.outcome === "stopped") {
      if (boundedRead.reason === "deadline") budgetExhausted = true;
      else interrupted = true;
      break;
    }
    const read = boundedRead.read;
    insertionChanged = !await input.insertionIsCurrent();
    checkpointChanged = !input.checkpointIsCurrent();
    if (insertionChanged || checkpointChanged) break;
    let finding: DvdDiscVerificationSampleFinding;
    if (read.outcome === "unreadable") {
      finding = {
        ...sample,
        outcome: "unreadable",
        referenceDigest: sample.digest,
        observedDigest: null,
        diagnostic: read.diagnostic,
      };
    } else {
      const observedDigest = createDvdSourceSampleDigest(read.bytes);
      finding = {
        ...sample,
        outcome: observedDigest === sample.digest ? "match" : "mismatch",
        referenceDigest: sample.digest,
        observedDigest,
        diagnostic: null,
      };
    }
    await input.recordFinding?.(finding);
    findings.push(finding);
  }
  const evaluated = dvdDiscVerificationOutcome({
    metadataMatches,
    manifestUnavailable: manifest === null,
    coverageComplete: sourceCoverageComplete &&
      findings.length === manifest?.samples.length,
    budgetExhausted,
    interrupted,
    insertionChanged,
    checkpointChanged,
    findings,
  });
  return {
    ...evaluated,
    findings,
    budgetExhausted,
    interrupted,
    insertionChanged,
    checkpointChanged,
  };
}

export async function pollDvdDiscVerification(input: {
  access: DataAccess;
  reader: DvdVerificationSourceReader;
  workerExecutionId: string;
  mediaGenerationObserver: MediaGenerationObserver;
  signal?: AbortSignal;
  archiveImageOwnership?: ArchiveImageOwnership;
}): Promise<boolean> {
  input.access.dvdDiscVerifications.recoverExpiredClaims();
  const claim = input.access.dvdDiscVerifications.claimNext(
    input.workerExecutionId,
  );
  if (claim === null) return false;
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    try {
      if (!input.access.dvdDiscVerifications.renewClaim(claim)) {
        throw new Error("DVD disc verification claim expired");
      }
    } catch (error) {
      heartbeatError = error;
      clearInterval(heartbeat);
    }
  }, 5_000);
  try {
    const executed = await input.access.withDvdCurrentCheckpoint(
      claim.originalDiscArchiveId,
      input.archiveImageOwnership ?? defaultArchiveImageOwnership,
      async ({ checkpoint, assertOwned }) => {
        const insertionSignal = input.signal ?? new AbortController().signal;
        const databaseInspectionIsCurrent = () => {
          const current = input.access.discInspections.list({
            ids: [claim.discInspectionId],
          })[0];
          return dvdDiscVerificationInsertionIsCurrent(claim, current);
        };
        const checkpointIsCurrent = () => {
          assertOwned();
          const header = input.access.catalog.findDvdArchiveEvidenceHeader(
            claim.originalDiscArchiveId,
          );
          return dvdDiscVerificationCheckpointIsCurrent(claim, {
            revision: checkpoint.currentManifestRevision,
            digest: checkpoint.currentManifestDigest,
          }) && header !== null &&
            dvdDiscVerificationCheckpointIsCurrent(claim, {
              revision: header.currentManifestRevision,
              digest: header.currentManifestDigest,
            });
        };
        const inspection = input.access.discInspections.list({
          ids: [claim.discInspectionId],
        })[0];
        const drive = inspection === undefined
          ? undefined
          : input.access.catalog.listOpticalDrives({
              ids: [inspection.opticalDriveId],
            })[0];
        if (drive === undefined || claim.startedAt === null) {
          throw new Error("DVD verification insertion is unavailable");
        }
        const inspectionIsCurrent = async () => {
          if (!databaseInspectionIsCurrent()) return false;
          try {
            const liveGeneration = await input.mediaGenerationObserver.observe(
              drive.devicePath,
              insertionSignal,
            );
            return liveGeneration === claim.mediaGeneration &&
              databaseInspectionIsCurrent();
          } catch {
            return false;
          }
        };
        const projectedManifest = input.access.catalog.findDvdSourceSampleManifest(
          claim.originalDiscArchiveId,
        );
        const manifest = checkpoint.initialEvidence.sourceSampleManifest ??
          null;
        assertDvdSourceSampleManifestProjection(manifest, projectedManifest);
        if (manifest !== null && (
          manifest.sourceMetadataFingerprint !==
            claim.sourceMetadataFingerprint ||
          manifest.acceptedEndLbaExclusive !==
            checkpoint.initialEvidence.acceptedEndLbaExclusive
        )) {
          throw new Error(
            "DVD verification source manifest does not match the checkpoint",
          );
        }
        const result = await verifyInsertedDvdAgainstSamples({
          manifest,
          sourceMetadataFingerprint: claim.sourceMetadataFingerprint,
          observedMetadataFingerprint: claim.observedMetadataFingerprint,
          devicePath: drive.devicePath,
          reader: input.reader,
          startedAtMs: claim.startedAt.getTime(),
          signal: input.signal,
          insertionIsCurrent: inspectionIsCurrent,
          checkpointIsCurrent,
          authorizeRead: () => {
            assertOwned();
            if (heartbeatError !== undefined) return false;
            const active = input.access.dvdDiscVerifications.renewClaim(claim);
            if (!active) {
              heartbeatError = new Error("DVD disc verification claim expired");
            }
            return active;
          },
          recordFinding: (finding) => {
            assertOwned();
            if (heartbeatError !== undefined) throw heartbeatError;
            input.access.dvdDiscVerifications.appendFinding(claim, finding);
            assertOwned();
          },
        });
        assertOwned();
        input.access.dvdDiscVerifications.complete(claim, result);
      },
    );
    if (executed === null) {
      throw new Error("DVD verification checkpoint is unavailable");
    }
  } catch {
    input.access.dvdDiscVerifications.fail(claim);
  } finally {
    clearInterval(heartbeat);
  }
  if (heartbeatError !== undefined) throw heartbeatError;
  return true;
}
