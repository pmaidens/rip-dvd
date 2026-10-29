import { acquireEncodeOutputReadOwnership } from "@rip-dvd/worker-runtime";
import { createHash } from "node:crypto";
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalPublicationJson,
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  sameEncodeOutputMutationSnapshot,
  type DataAccess,
  type EncodeJob,
  type EncodeOutputInspectionReadAccess,
  RecordNotFoundError,
} from "@rip-dvd/data-access";
import {
  inspectEncodeOutputEvidence,
  readEncodeOutputAuthority,
  encodeOutputArtifactIdentity,
  type EncodeOutputMediaProbe,
} from "./encode-output-inspection.js";

const PREVIEW_TOKEN = /^encode-output-keep-preview-v1\.[a-f0-9]{64}$/;

export class InvalidEncodeOutputKeepPreflightInputError extends Error {
  constructor() {
    super("Keep preflight accepts only an optional exact previewToken from a prior preflight.");
    this.name = "InvalidEncodeOutputKeepPreflightInputError";
  }
}

function parseInput(input: unknown): { previewToken?: string } {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InvalidEncodeOutputKeepPreflightInputError();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "previewToken") ||
      ("previewToken" in value && (typeof value.previewToken !== "string" || !PREVIEW_TOKEN.test(value.previewToken)))) {
    throw new InvalidEncodeOutputKeepPreflightInputError();
  }
  return value as { previewToken?: string };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalPublicationJson(value)).digest("hex");
}

interface Blocker { code: string; message: string }
type Authority = ReturnType<typeof readEncodeOutputAuthority>;

// Consistency/storage and ownership precede identity, validation and workflow.
const BLOCKER_ORDER = ["OUTPUT_FILE_UNAVAILABLE", "DESTINATION_EVIDENCE_UNAVAILABLE", "OUTPUT_OWNERSHIP_LOST",
  "DESTINATION_AUTHORITY_CHANGING",
  "OUTPUT_AUTHORITY_CHANGED", "OUTPUT_MISSING", "OUTPUT_IDENTITY_CHANGED", "OUTPUT_CHANGED_DURING_INSPECTION",
  "OUTPUT_CHANGED_DURING_PREFLIGHT", "OUTPUT_NOT_REGULAR", "OUTPUT_EMPTY", "OUTPUT_INCOMPLETE",
  "OUTPUT_VALIDATION_CHANGED", "KEEP_PREFLIGHT_STALE", "OUTPUT_NOT_VALIDATION_FAILED", "ENCODE_JOB_NOT_FAILED"];

export function orderedKeepBlockers(blockers: Blocker[]) {
  return [...new Map(blockers.map((blocker) => [blocker.code, blocker])).values()]
    .sort((left, right) => BLOCKER_ORDER.indexOf(left.code) - BLOCKER_ORDER.indexOf(right.code));
}

function readAuthority(access: DataAccess, identity: unknown) {
  return access.readEncodeOutputInspectionSnapshot((snapshot) => {
    const output = readEncodeOutputAuthority(snapshot, identity);
    const destination = output.validationRecord?.sourceSnapshot?.source.output.path ?? output.job.outputPath;
    return {
      output, destination,
      normal: readNormalDestinationAuthority(snapshot, destination),
      fileOwner: snapshot.encodeJobs.findReservedOutputPathOwner(output.outputPath),
      fileConflicts: snapshot.encodeJobs.readOutputFileConflicts(output.outputPath),
    };
  });
}

function readNormalDestinationAuthority(access: EncodeOutputInspectionReadAccess, destination: string) {
  const reservation = access.encodeJobs.findReservedOutputPathOwner(destination);
  const lineage: EncodeJob[] = [];
  const visited = new Set<string>();
  let candidate = reservation;
  // A corrected replacement reserves the destination before replacing its
  // predecessor's published bytes. Follow only this bounded authority chain.
  while (candidate !== null && candidate.outputPath === destination && lineage.length < 100 &&
      !visited.has(candidate.id)) {
    visited.add(candidate.id);
    lineage.push(candidate);
    try {
      return { reservation, lineage, publication: readEncodeOutputAuthority(access, encodeOutputArtifactIdentity(candidate.id)), complete: true };
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
    }
    if (!candidate.replaceExistingOutput || candidate.predecessorEncodeJobId === null) {
      return { reservation, lineage, publication: null, complete: true };
    }
    candidate = access.encodeJobs.find(candidate.predecessorEncodeJobId);
  }
  return { reservation, lineage, publication: null, complete: reservation === null || (candidate !== null && candidate.outputPath !== destination) };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function observeFile(path: string) {
  try {
    const metadata = lstatSync(path);
    return { status: "present" as const, metadata, fileIdentity: encodeOutputFilesystemIdentity(metadata),
      revision: digest([encodeOutputFilesystemIdentity(metadata), metadata.ctimeMs, metadata.mode]) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // A missing storage directory is not evidence that the destination is empty.
      try {
        if (lstatSync(dirname(path)).isDirectory()) return { status: "absent" as const, metadata: null, fileIdentity: null, revision: null };
      } catch { /* Report unavailable storage without exposing its path. */ }
    }
    return { status: "unknown" as const, metadata: null, fileIdentity: null, revision: null };
  }
}

function sameObservation(first: ReturnType<typeof observeFile>, second: ReturnType<typeof observeFile>) {
  return first.status === second.status && first.revision === second.revision;
}

async function fingerprintFile(output: Authority) {
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  let metadata: Stats | null = null;
  try {
    descriptor = await open(output.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    metadata = await descriptor.stat();
    const pathMetadata = await lstat(output.outputPath);
    if (!metadata.isFile() || metadata.size === 0 || !pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      return { metadata, sha256: null, blocker: { code: "OUTPUT_INCOMPLETE", message: "Keep requires a nonempty complete regular file." } };
    }
    if (!sameEncodeOutputMutationSnapshot(metadata, pathMetadata) ||
        !matchesEncodeOutputFilesystemIdentity(output.recordedFilesystemIdentity, metadata) ||
        metadata.ctimeMs !== output.recordedChangeTimeMs) {
      return { metadata, sha256: null, blocker: { code: "OUTPUT_IDENTITY_CHANGED", message: "The failed Encode Output no longer matches its complete-write evidence." } };
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await descriptor.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (bytesRead === 0) return { metadata, sha256: null, blocker: { code: "OUTPUT_CHANGED_DURING_PREFLIGHT", message: "The failed Encode Output changed during preflight." } };
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (!sameEncodeOutputMutationSnapshot(metadata, await descriptor.stat()) ||
        !sameEncodeOutputMutationSnapshot(metadata, await lstat(output.outputPath))) {
      return { metadata, sha256: null, blocker: { code: "OUTPUT_CHANGED_DURING_PREFLIGHT", message: "The failed Encode Output changed during preflight." } };
    }
    return { metadata, sha256: hash.digest("hex"), blocker: null };
  } catch (error) {
    return { metadata, sha256: null, blocker: { code: errorCode(error) === "ENOENT" ? "OUTPUT_MISSING" : "OUTPUT_FILE_UNAVAILABLE",
      message: "The failed Encode Output could not be read as a stable complete file." } };
  } finally { await descriptor?.close(); }
}

function normalOutput(output: Authority | null) {
  return output === null ? null : {
    artifactIdentity: output.artifactIdentity, encodeJobId: output.job.id,
    validationIdentity: output.validationRecord?.id ?? null,
    fileIdentity: output.recordedFilesystemIdentity,
    validationResult: output.recordedValidationResult,
    authorityRevision: digest(output.authorityKey),
  };
}

const ACKNOWLEDGEMENT = {
  acknowledged: true as const,
  message: "I acknowledge that this complete Encode Output failed validation, may be unplayable, and will remain separate from normal library output. Keeping it does not make the Encode Job successful.",
  requiredInputs: ["artifactIdentity", "validationIdentity", "previewToken", "acknowledged", "mutationKey"],
};

/** Read-only evidence. A later Keep must recompute this preview before any write. */
export async function prepareEncodeOutputKeepReview(
  access: DataAccess,
  artifactIdentity: unknown,
  raw?: unknown,
  mediaProbe?: EncodeOutputMediaProbe,
) {
  const input = parseInput(raw);
  const before = readAuthority(access, artifactIdentity);
  const destinationBefore = observeFile(before.destination);
  const inspected = await inspectEncodeOutputEvidence(access, artifactIdentity, mediaProbe);
  const failedArtifact = inspected.artifact.state === "validation_failed";
  const file = failedArtifact ? await fingerprintFile(before.output) : { metadata: null, sha256: null, blocker: null };
  const destinationAfter = observeFile(before.destination);
  const finalFile = observeFile(before.output.outputPath);
  const after = readAuthority(access, artifactIdentity);
  const { artifact } = inspected;
  const blockers: Blocker[] = [];
  if (failedArtifact && (before.fileOwner !== null || after.fileOwner !== null ||
      Object.values(before.fileConflicts).some((id) => id !== null) || Object.values(after.fileConflicts).some((id) => id !== null) ||
      before.output.outputPath === before.destination || before.output.job.partialCleanupOutputPath === before.output.outputPath)) {
    blockers.push({ code: "OUTPUT_OWNERSHIP_LOST", message: "The failed file shares active publication or cleanup authority." });
  }
  if (before.output.authorityKey !== after.output.authorityKey || inspected.authorityRevision !== digest(after.output.authorityKey) ||
      canonicalPublicationJson(before.output.job) !== canonicalPublicationJson(after.output.job)) {
    blockers.push({ code: "OUTPUT_AUTHORITY_CHANGED", message: "Failed Encode Output authority changed during preflight." });
  }
  if (destinationAfter.status === "unknown" || !sameObservation(destinationBefore, destinationAfter) ||
      (destinationAfter.metadata !== null && (!destinationAfter.metadata.isFile() || destinationAfter.metadata.isSymbolicLink())) ||
      !before.normal.complete || !after.normal.complete ||
      canonicalPublicationJson(before.normal) !== canonicalPublicationJson(after.normal)) {
    blockers.push({ code: "DESTINATION_EVIDENCE_UNAVAILABLE", message: "Normal destination file or authority evidence is unavailable or changed during preflight." });
  }
  if ([...before.normal.lineage, ...after.normal.lineage].some((job) => job.publicationPending || job.publicationCompletionPending) ||
      before.normal.publication?.authorityUnavailableReason != null || after.normal.publication?.authorityUnavailableReason != null) {
    blockers.push({ code: "DESTINATION_AUTHORITY_CHANGING", message: "Normal output publication authority is changing." });
  }
  if (file.blocker !== null) blockers.push(file.blocker);
  if (file.metadata !== null && file.blocker === null && (finalFile.metadata === null || !sameEncodeOutputMutationSnapshot(file.metadata, finalFile.metadata))) {
    blockers.push({ code: "OUTPUT_CHANGED_DURING_PREFLIGHT", message: "The failed Encode Output changed during preflight." });
  }
  if (artifact.file.status !== "available" && !blockers.some(({ code }) => code === artifact.inspectability.reasonCode)) {
    blockers.push({ code: artifact.inspectability.reasonCode ?? "OUTPUT_INCOMPLETE", message: artifact.inspectability.reason ?? "The failed file is incomplete." });
  }
  if (artifact.state !== "validation_failed") blockers.push({ code: "OUTPUT_NOT_VALIDATION_FAILED", message: "Keep preflight requires a retained validation-failed Encode Output." });
  if (artifact.state === "validation_failed" && (artifact.validation.result !== "failed" || artifact.file.completeness !== "complete")) {
    blockers.push({ code: "OUTPUT_INCOMPLETE", message: "Current file evidence does not prove the retained complete write." });
  }
  const source = after.output.validationRecord?.sourceSnapshot;
  if (source !== null && source !== undefined && (source.id !== after.output.validationRecord?.claimToken || source.encodeJobId !== after.output.job.id)) {
    blockers.push({ code: "OUTPUT_VALIDATION_CHANGED", message: "Validation and immutable claim evidence do not identify the same output." });
  }
  if (after.output.job.status !== "failed") blockers.push({ code: "ENCODE_JOB_NOT_FAILED", message: "Keep requires the Encode Job to remain failed." });
  const current = {
    artifactIdentity: after.output.artifactIdentity,
    validationIdentity: after.output.validationRecord?.id ?? null,
    fileIdentity: finalFile.fileIdentity,
    fileRevision: finalFile.revision,
    authorityRevision: digest([after.output.authorityKey, after.fileOwner, after.fileConflicts, after.output.job]),
    fileAuthority: { publicationEncodeJobId: after.fileOwner?.id ?? null, ...after.fileConflicts },
    sourceSnapshotIdentity: source?.id ?? null,
    destinationRevision: digest([after.destination, after.normal, destinationAfter.revision, destinationAfter.status]),
  };
  const stableCompleteFile = file.sha256 !== null && file.metadata !== null && finalFile.metadata !== null &&
    sameEncodeOutputMutationSnapshot(file.metadata, finalFile.metadata);
  const completeWrite = { status: stableCompleteFile ? "verified" as const : "unknown" as const, sha256: stableCompleteFile ? file.sha256 : null,
    recordedFileIdentity: after.output.recordedFilesystemIdentity };
  const normalDestination = { status: destinationAfter.status, fileIdentity: destinationAfter.fileIdentity, normalOutput: normalOutput(after.normal.publication) };
  const candidateToken = `encode-output-keep-preview-v1.${digest({ artifact, current, completeWrite, normalDestination,
    validation: after.output.validationRecord, acknowledgement: ACKNOWLEDGEMENT })}`;
  const stale = input.previewToken !== undefined && input.previewToken !== candidateToken;
  if (stale) blockers.push({ code: "KEEP_PREFLIGHT_STALE", message: "The reviewed Keep evidence changed. Request and review a new preflight." });
  const preview = {
    schemaVersion: 1 as const, artifact, current, completeWrite, normalDestination,
    requiredAcknowledgement: ACKNOWLEDGEMENT,
    eligible: blockers.length === 0, blockers: orderedKeepBlockers(blockers),
    previewToken: blockers.length === 0 ? candidateToken : null,
    review: { status: input.previewToken === undefined ? "not_supplied" as const : stale ? "stale" as const : "current" as const,
      reasonCode: stale ? "KEEP_PREFLIGHT_STALE" : null },
  };
  return {
    preview,
    prepareCommit(assertReadOwnership: () => void) {
      assertReadOwnership();
      if (!sameObservation(finalFile, observeFile(after.output.outputPath)) ||
          !sameObservation(destinationAfter, observeFile(after.destination))) {
        throw new EncodeOutputKeepEvidenceChangedError();
      }
      assertReadOwnership();
      // Retained failed files have no admitted writer; cleanup and publication
      // must also preserve their immutable artifact authority.
      // Authenticate those fences under SQLite's writer lock, without media I/O.
      return () => {
        if (canonicalPublicationJson(readAuthority(access, artifactIdentity)) !== canonicalPublicationJson(after)) {
          throw new EncodeOutputKeepEvidenceChangedError();
        }
      };
    },
  };
}

export class EncodeOutputKeepEvidenceChangedError extends Error {
  constructor(readonly reasonCode = "KEEP_PREFLIGHT_STALE") { super("Keep evidence changed."); }
}

/** Keep holds the retained file's read ownership; preflight stays read-only. */
export async function withEncodeOutputKeepReadOwnership<T>(
  access: DataAccess, artifactIdentity: string, task: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  const { output, destination } = readAuthority(access, artifactIdentity);
  let ownership: Awaited<ReturnType<typeof acquireEncodeOutputReadOwnership>>;
  try { ownership = await acquireEncodeOutputReadOwnership(output.outputPath, destination); }
  catch { throw new EncodeOutputKeepEvidenceChangedError("OUTPUT_OWNERSHIP_LOST"); }
  try {
    return await task(() => {
      try { ownership.assertHeld(); }
      catch { throw new EncodeOutputKeepEvidenceChangedError("OUTPUT_OWNERSHIP_LOST"); }
    });
  } finally { await ownership.release(); }
}

export async function previewEncodeOutputKeep(
  access: DataAccess, artifactIdentity: unknown, raw?: unknown, mediaProbe?: EncodeOutputMediaProbe,
) {
  return (await prepareEncodeOutputKeepReview(access, artifactIdentity, raw, mediaProbe)).preview;
}

export type EncodeOutputKeepPreflight = Awaited<ReturnType<typeof previewEncodeOutputKeep>>;
