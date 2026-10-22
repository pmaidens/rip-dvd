import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

import {
  createDvdSourceSampleDigest,
  classifyArchiveReadFailureEvidence,
  isArchiveReadFailureEvidenceConsistent,
  dvdDiscVerificationOutcome,
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
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import {
  DVD_READ_FAILURE_RESULT_PREFIX,
  DVD_READ_FAILURE_CLASSIFIER_VERSION,
  parseDvdReadFailureTerminalResultProtocol,
} from "./dvd-recovery-contracts.js";

const FLOCK_CONFLICT_EXIT_CODE = 75;
const MAX_DIAGNOSTIC_BYTES = 65_536;

const VERIFICATION_FAILURE_KEYS = [
  "asc", "ascq", "category", "classifierVersion", "driverStatus",
  "hostStatus", "informationLba", "protocolVersion", "requestedBlockCount",
  "requestedLba", "retryOrdinal", "scsiStatus", "senseKey",
  "senseResponseCode",
].sort();

function optionalInteger(
  value: unknown,
  maximum: number,
): value is number | null {
  return value === null ||
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function parseVerificationReadFailure(
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
    candidate.retryOrdinal !== 0 ||
    !optionalInteger(candidate.scsiStatus, 0xff) ||
    !optionalInteger(candidate.hostStatus, 0xffff) ||
    !optionalInteger(candidate.driverStatus, 0xffff) ||
    !optionalInteger(candidate.senseResponseCode, 0xff) ||
    !optionalInteger(candidate.senseKey, 0x0f) ||
    !optionalInteger(candidate.asc, 0xff) ||
    !optionalInteger(candidate.ascq, 0xff) ||
    !optionalInteger(candidate.informationLba, Number.MAX_SAFE_INTEGER) ||
    ((candidate.scsiStatus === null || candidate.hostStatus === null ||
      candidate.driverStatus === null) &&
      (candidate.scsiStatus !== null || candidate.hostStatus !== null ||
        candidate.driverStatus !== null)) ||
    (candidate.senseResponseCode === null &&
      (candidate.senseKey !== null || candidate.asc !== null ||
        candidate.ascq !== null || candidate.informationLba !== null)) ||
    (candidate.senseResponseCode !== null &&
      candidate.senseResponseCode !== 0x70 &&
      candidate.senseResponseCode !== 0x72) ||
    (candidate.asc === null) !== (candidate.ascq === null) ||
    (candidate.informationLba !== null &&
      (candidate.informationLba < expected.startLba ||
        candidate.informationLba >=
          expected.startLba + expected.sectorCount))
  ) {
    throw new Error("DVD verification read failure result is malformed");
  }
  const classified = classifyArchiveReadFailureEvidence({
    scsiStatus: candidate.scsiStatus,
    hostStatus: candidate.hostStatus,
    driverStatus: candidate.driverStatus,
    senseKey: candidate.senseKey,
    asc: candidate.asc,
    ascq: candidate.ascq,
  } as Parameters<typeof classifyArchiveReadFailureEvidence>[0]);
  const category = classified === "recognized_medium_error"
    ? "medium_error"
    : classified;
  const hasOutOfRangeEvidence = isArchiveReadFailureEvidenceConsistent({
    scsiStatus: candidate.scsiStatus as number | null,
    hostStatus: candidate.hostStatus as number | null,
    driverStatus: candidate.driverStatus as number | null,
    senseKey: candidate.senseKey as number | null,
    asc: candidate.asc as number | null,
    ascq: candidate.ascq as number | null,
    category: "out_of_range",
  });
  if (
    candidate.category !==
      (category === "medium_error" ? "unknown" : category) ||
    hasOutOfRangeEvidence
  ) {
    throw new Error("DVD verification read failure result is malformed");
  }
  return {
    category,
    classifierVersion: DVD_READ_FAILURE_CLASSIFIER_VERSION,
    scsiStatus: candidate.scsiStatus as number | null,
    hostStatus: candidate.hostStatus as number | null,
    driverStatus: candidate.driverStatus as number | null,
    senseResponseCode: candidate.senseResponseCode as number | null,
    senseKey: candidate.senseKey as number | null,
    asc: candidate.asc as number | null,
    ascq: candidate.ascq as number | null,
    informationLba: candidate.informationLba as number | null,
  };
}

export type DvdVerificationSourceRead =
  | { outcome: "readable"; bytes: Buffer }
  | { outcome: "unreadable"; diagnostic: DvdDiscVerificationDiagnostic };

export interface DvdVerificationSourceReader {
  read(input: {
    devicePath: string;
    startLba: number;
    sectorCount: number;
    acceptedEndLbaExclusive: number;
  }): Promise<DvdVerificationSourceRead>;
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
    read(input) {
      const devicePath = requireSafeOpticalDevicePath(input.devicePath);
      if (
        !Number.isSafeInteger(input.startLba) ||
        input.startLba < 0 ||
        !Number.isSafeInteger(input.sectorCount) ||
        input.sectorCount <= 0 ||
        input.startLba + input.sectorCount > input.acceptedEndLbaExclusive
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
      ], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe", lockDescriptor],
      });
      closeSync(lockDescriptor);
      if (child.stdout === null || child.stderr === null) {
        child.kill();
        throw new Error("DVD verification helper pipes are unavailable");
      }
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      return new Promise<DvdVerificationSourceRead>((resolve, reject) => {
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        let stderr = "";
        let overflow = false;
        childStdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > DVD_SOURCE_SAMPLE_BYTE_COUNT) {
            overflow = true;
            return;
          }
          stdout.push(chunk);
        });
        childStderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`;
          if (Buffer.byteLength(stderr) > MAX_DIAGNOSTIC_BYTES) {
            overflow = true;
            stderr = stderr.slice(-MAX_DIAGNOSTIC_BYTES);
          }
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (overflow || signal !== null) {
            reject(new Error("DVD verification helper output is invalid"));
            return;
          }
          if (code === 0) {
            const bytes = Buffer.concat(stdout);
            if (bytes.length !== DVD_SOURCE_SAMPLE_BYTE_COUNT) {
              reject(new Error("DVD verification helper returned a short sample"));
              return;
            }
            resolve({ outcome: "readable", bytes });
            return;
          }
          const line = stderr.split("\n")
            .find((value) => value.startsWith(DVD_READ_FAILURE_RESULT_PREFIX));
          if (code !== 3 || line === undefined) {
            reject(new Error("DVD verification helper failed"));
            return;
          }
          const diagnostic = parseVerificationReadFailure(
            line.slice(DVD_READ_FAILURE_RESULT_PREFIX.length),
            input,
          );
          resolve({
            outcome: "unreadable",
            diagnostic,
          });
        });
      });
    },
  };
}

export async function verifyInsertedDvdAgainstSamples(input: {
  manifest: DvdSourceSampleManifest | null;
  sourceMetadataFingerprint: string;
  observedMetadataFingerprint: string;
  devicePath: string;
  reader: DvdVerificationSourceReader;
  startedAtMs: number;
  now?(): number;
  insertionIsCurrent(): boolean;
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
  let insertionChanged = !input.insertionIsCurrent();
  let checkpointChanged = !input.checkpointIsCurrent();
  for (const sample of manifest?.samples ?? []) {
    if (insertionChanged || checkpointChanged) break;
    if (now() - input.startedAtMs >=
      DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS) {
      budgetExhausted = true;
      break;
    }
    if (input.authorizeRead !== undefined && !await input.authorizeRead()) {
      interrupted = true;
      break;
    }
    const read = await input.reader.read({
      devicePath: input.devicePath,
      startLba: sample.startLba,
      sectorCount: sample.sectorCount,
      acceptedEndLbaExclusive: manifest!.acceptedEndLbaExclusive,
    });
    insertionChanged = !input.insertionIsCurrent();
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
    const executed = await input.access.withDvdInitialCheckpoint(
      claim.originalDiscArchiveId,
      input.archiveImageOwnership ?? defaultArchiveImageOwnership,
      async ({ evidence, assertOwned }) => {
        const inspectionIsCurrent = () => {
          const current = input.access.discInspections.list({
            ids: [claim.discInspectionId],
          })[0];
          return current !== undefined &&
            current.isCurrent &&
            current.status === "completed" &&
            current.detectedDiscId === claim.detectedDiscId &&
            current.mediaGeneration === claim.mediaGeneration;
        };
        const checkpointIsCurrent = () => {
          assertOwned();
          const header = input.access.catalog.findDvdArchiveEvidenceHeader(
            claim.originalDiscArchiveId,
          );
          return evidence.revision === claim.checkpointRevision &&
            evidence.manifestDigest === claim.checkpointDigest &&
            header !== null &&
            header.currentManifestRevision === claim.checkpointRevision &&
            header.currentManifestDigest === claim.checkpointDigest;
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
        const manifest = input.access.catalog.findDvdSourceSampleManifest(
          claim.originalDiscArchiveId,
        );
        if (manifest !== null && (
          manifest.sourceMetadataFingerprint !==
            claim.sourceMetadataFingerprint ||
          manifest.checkpointRevision !== claim.checkpointRevision ||
          manifest.checkpointDigest !== claim.checkpointDigest ||
          manifest.acceptedEndLbaExclusive !==
            evidence.acceptedEndLbaExclusive
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
