import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

import {
  createDvdSourceSampleDigest,
  dvdDiscVerificationOutcome,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS,
  type DataAccess,
  type DvdDiscVerificationDiagnostic,
  type DvdDiscVerificationSampleFinding,
  type DvdSourceSampleManifest,
} from "@rip-dvd/data-access";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import {
  DVD_READ_FAILURE_RESULT_PREFIX,
  parseDvdReadFailureTerminalResultProtocol,
} from "./dvd-recovery-contracts.js";

const FLOCK_CONFLICT_EXIT_CODE = 75;
const MAX_DIAGNOSTIC_BYTES = 65_536;

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
          const { readFailure } = parseDvdReadFailureTerminalResultProtocol(
            line.slice(DVD_READ_FAILURE_RESULT_PREFIX.length),
            input.acceptedEndLbaExclusive * 2_048,
          );
          resolve({
            outcome: "unreadable",
            diagnostic: {
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
            },
          });
        });
      });
    },
  };
}

export async function verifyInsertedDvdAgainstSamples(input: {
  manifest: DvdSourceSampleManifest | null;
  observedMetadataFingerprint: string;
  devicePath: string;
  reader: DvdVerificationSourceReader;
  startedAtMs: number;
  now?(): number;
  insertionIsCurrent(): boolean;
  checkpointIsCurrent(): boolean;
}) {
  const now = input.now ?? Date.now;
  if (input.manifest === null) {
    return {
      outcome: "inconclusive" as const,
      reasons: ["DISC_SAMPLE_MANIFEST_UNAVAILABLE" as const],
      findings: [] as DvdDiscVerificationSampleFinding[],
      budgetExhausted: false,
    };
  }
  const metadataMatches = input.observedMetadataFingerprint ===
    input.manifest.sourceMetadataFingerprint;
  const coverageComplete = input.manifest.samples.length ===
    DVD_SOURCE_SAMPLE_BAND_COUNT;
  const findings: DvdDiscVerificationSampleFinding[] = [];
  let budgetExhausted = false;
  let insertionChanged = !input.insertionIsCurrent();
  let checkpointChanged = !input.checkpointIsCurrent();
  for (const sample of input.manifest.samples) {
    if (insertionChanged || checkpointChanged) break;
    if (now() - input.startedAtMs >=
      DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS) {
      budgetExhausted = true;
      break;
    }
    const read = await input.reader.read({
      devicePath: input.devicePath,
      startLba: sample.startLba,
      sectorCount: sample.sectorCount,
      acceptedEndLbaExclusive: input.manifest.acceptedEndLbaExclusive,
    });
    insertionChanged = !input.insertionIsCurrent();
    checkpointChanged = !input.checkpointIsCurrent();
    if (read.outcome === "unreadable") {
      findings.push({
        ...sample,
        outcome: "unreadable",
        referenceDigest: sample.digest,
        observedDigest: null,
        diagnostic: read.diagnostic,
      });
      continue;
    }
    const observedDigest = createDvdSourceSampleDigest(read.bytes);
    findings.push({
      ...sample,
      outcome: observedDigest === sample.digest ? "match" : "mismatch",
      referenceDigest: sample.digest,
      observedDigest,
      diagnostic: null,
    });
  }
  const evaluated = dvdDiscVerificationOutcome({
    metadataMatches,
    coverageComplete,
    budgetExhausted,
    insertionChanged,
    checkpointChanged,
    findings,
  });
  return { ...evaluated, findings, budgetExhausted };
}

export async function pollDvdDiscVerification(input: {
  access: DataAccess;
  reader: DvdVerificationSourceReader;
  workerExecutionId: string;
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
      const header = input.access.catalog.findDvdArchiveEvidenceHeader(
        claim.originalDiscArchiveId,
      );
      return header !== null &&
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
    const result = await verifyInsertedDvdAgainstSamples({
      manifest: input.access.catalog.findDvdSourceSampleManifest(
        claim.originalDiscArchiveId,
      ),
      observedMetadataFingerprint: claim.observedMetadataFingerprint,
      devicePath: drive.devicePath,
      reader: input.reader,
      startedAtMs: claim.startedAt.getTime(),
      insertionIsCurrent: inspectionIsCurrent,
      checkpointIsCurrent,
    });
    input.access.dvdDiscVerifications.complete(claim, result);
  } catch {
    input.access.dvdDiscVerifications.fail(claim);
  } finally {
    clearInterval(heartbeat);
  }
  if (heartbeatError !== undefined) throw heartbeatError;
  return true;
}
