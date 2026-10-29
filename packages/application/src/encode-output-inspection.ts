import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";

import {
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  RecordNotFoundError,
  sameEncodeOutputInode,
  sameEncodeOutputMutationSnapshot,
  canonicalPublicationJson,
} from "@rip-dvd/data-access";
import type {
  ConsistentReadAccess,
  DataAccess,
  EncodeJob,
  EncodeJobId,
  EncodeOutputFilesystemIdentity,
  EncodeOutputInspectionReadAccess,
  RetainedEncodeOutput,
  RetainedEncodeOutputId,
  RetainedEncodeOutputSummary,
  EncodeOutputInspectionAcknowledgement,
  EncodeOutputInspectionReceiptRecord,
  EncodeOutputValidationRecord,
  EncodeOutputSourceSnapshot,
  EncodeClaimSource,
  ValidationFailedEncodeOutput,
  ValidationFailedEncodeOutputSummary,
  ValidationFailedEncodeOutputId,
} from "@rip-dvd/data-access";
import { parseMutationKey } from "./mutation-key.js";
import { assessmentHasUnknownSourceImpact } from "./source-damage-impact.js";

const ENCODE_OUTPUT_ARTIFACT_PATTERN =
  /^encode-output-v1\.(published|retained|failed)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MEDIA_PROBE_TIMEOUT_MS = 30_000;
const MEDIA_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

export type EncodeOutputStreamKind =
  | "video"
  | "audio"
  | "subtitle"
  | "data"
  | "attachment"
  | "unknown";

export interface EncodeOutputMediaStream {
  index: number;
  kind: EncodeOutputStreamKind;
  codecName: string | null;
  language: string | null;
  title: string | null;
  default: boolean | null;
  forced: boolean | null;
}

export interface EncodeOutputMediaInspection {
  durationSeconds: number | null;
  streams: EncodeOutputMediaStream[];
}

export type EncodeOutputMediaProbe = (
  outputPath: string,
) => Promise<EncodeOutputMediaInspection>;

export type EncodeOutputInspectionReasonCode =
  | "OUTPUT_MISSING"
  | "OUTPUT_FILE_UNAVAILABLE"
  | "OUTPUT_NOT_REGULAR"
  | "OUTPUT_EMPTY"
  | "OUTPUT_IDENTITY_CHANGED"
  | "OUTPUT_CHANGED_DURING_INSPECTION"
  | "OUTPUT_AUTHORITY_CHANGED"
  | "OUTPUT_PROBE_FAILED";

export class InvalidEncodeOutputArtifactIdentityError extends Error {
  constructor() {
    super("Invalid Encode Output artifact identity.");
    this.name = "InvalidEncodeOutputArtifactIdentityError";
  }
}

export class InvalidEncodeOutputExportInputError extends Error {
  constructor(message = "Invalid Encode Output export input.") {
    super(message);
    this.name = "InvalidEncodeOutputExportInputError";
  }
}

export type EncodeOutputExportReasonCode =
  | "OUTPUT_AUTHORITY_CHANGED"
  | "OUTPUT_IDENTITY_NOT_RECORDED"
  | "OUTPUT_IDENTITY_CHANGED"
  | "OUTPUT_MISSING"
  | "OUTPUT_FILE_UNAVAILABLE"
  | "OUTPUT_NOT_REGULAR"
  | "OUTPUT_EMPTY"
  | "OUTPUT_CHANGED_DURING_EXPORT"
  | "EXPORT_DESTINATION_EXISTS"
  | "EXPORT_DESTINATION_UNAVAILABLE";

export class EncodeOutputExportRejectedError extends Error {
  constructor(
    readonly reasonCode: EncodeOutputExportReasonCode,
    message: string,
    readonly artifactIdentity: string,
    readonly currentIdentity: EncodeOutputFilesystemIdentity | null,
  ) {
    super(message);
    this.name = "EncodeOutputExportRejectedError";
  }
}

interface ProbeJsonStream {
  codec_name?: unknown;
  codec_type?: unknown;
  disposition?: unknown;
  index?: unknown;
  tags?: unknown;
}

interface ProbeJsonResult {
  format?: unknown;
  streams?: unknown;
}

function boundedMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 512 ? trimmed : null;
}

function streamKind(value: unknown): EncodeOutputStreamKind {
  return value === "video" || value === "audio" || value === "subtitle" ||
      value === "data" || value === "attachment"
    ? value
    : "unknown";
}

function probeFlag(value: unknown): boolean | null {
  return value === 0 ? false : value === 1 ? true : null;
}

function parseMediaProbe(stdout: string): EncodeOutputMediaInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Encode Output media probe returned invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Encode Output media probe returned an invalid result.");
  }
  const result = parsed as ProbeJsonResult;
  if (!Array.isArray(result.streams)) {
    throw new Error("Encode Output media probe omitted its stream inventory.");
  }
  const streams = result.streams.map((value): EncodeOutputMediaStream => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Encode Output media probe returned an invalid stream.");
    }
    const stream = value as ProbeJsonStream;
    if (!Number.isSafeInteger(stream.index) || (stream.index as number) < 0) {
      throw new Error("Encode Output media probe returned an invalid stream index.");
    }
    const tags = typeof stream.tags === "object" && stream.tags !== null &&
        !Array.isArray(stream.tags)
      ? stream.tags as Record<string, unknown>
      : {};
    const disposition = typeof stream.disposition === "object" &&
        stream.disposition !== null && !Array.isArray(stream.disposition)
      ? stream.disposition as Record<string, unknown>
      : {};
    return {
      index: stream.index as number,
      kind: streamKind(stream.codec_type),
      codecName: boundedMetadata(stream.codec_name),
      language: boundedMetadata(tags.language),
      title: boundedMetadata(tags.title),
      default: probeFlag(disposition.default),
      forced: probeFlag(disposition.forced),
    };
  }).sort((left, right) => left.index - right.index);
  const format = typeof result.format === "object" && result.format !== null &&
      !Array.isArray(result.format)
    ? result.format as Record<string, unknown>
    : {};
  const durationValue = typeof format.duration === "string"
    ? Number(format.duration)
    : typeof format.duration === "number"
      ? format.duration
      : Number.NaN;
  return {
    durationSeconds: Number.isFinite(durationValue) && durationValue >= 0
      ? durationValue
      : null,
    streams,
  };
}

export const probeEncodeOutputMedia: EncodeOutputMediaProbe =
  async (outputPath) => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default,forced",
          "-of",
          "json",
          outputPath,
        ],
        {
          encoding: "utf8",
          maxBuffer: MEDIA_PROBE_MAX_OUTPUT_BYTES,
          timeout: MEDIA_PROBE_TIMEOUT_MS,
        },
        (error, output) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(output);
        },
      );
    });
    return parseMediaProbe(stdout);
  };

export function encodeOutputArtifactIdentity(jobId: EncodeJobId): string {
  return `encode-output-v1.published.${jobId}`;
}

export function retainedEncodeOutputArtifactIdentity(
  retainedOutputId: RetainedEncodeOutputId,
): string {
  return `encode-output-v1.retained.${retainedOutputId}`;
}

type ParsedEncodeOutputArtifactIdentity =
  | { kind: "published"; jobId: EncodeJobId }
  | { kind: "retained"; retainedOutputId: RetainedEncodeOutputId }
  | { kind: "failed"; failedOutputId: ValidationFailedEncodeOutputId };

function parseEncodeOutputArtifactIdentity(
  identity: unknown,
): ParsedEncodeOutputArtifactIdentity {
  if (typeof identity !== "string") {
    throw new InvalidEncodeOutputArtifactIdentityError();
  }
  const match = ENCODE_OUTPUT_ARTIFACT_PATTERN.exec(identity.trim());
  if (!match) {
    throw new InvalidEncodeOutputArtifactIdentityError();
  }
  if (match[1] === "failed") return { kind: "failed", failedOutputId: match[2] as ValidationFailedEncodeOutputId };
  return match[1] === "published"
    ? { kind: "published", jobId: match[2] as EncodeJobId }
    : {
      kind: "retained",
      retainedOutputId: match[2] as RetainedEncodeOutputId,
    };
}

export function validationFailedEncodeOutputArtifactIdentity(id: ValidationFailedEncodeOutputId): string {
  return `encode-output-v1.failed.${id}`;
}

export interface EncodeOutputArtifactReference {
  identity: string;
  state: "published" | "retained" | "validation_failed";
}

function ownsPublishedOutput(job: EncodeJob): boolean {
  return job.status === "completed" ||
    (job.replaceExistingOutput && job.completedAt !== null);
}

function hasPublishedSuccessorOutput(job: EncodeJob): boolean {
  return job.status === "completed" || job.completedAt !== null;
}

function successorAffectsPublishedOutput(
  predecessor: EncodeJob,
  successor: EncodeJob,
): boolean {
  return successor.outputPath === predecessor.outputPath;
}

function successorReplacedPublishedOutput(
  predecessor: EncodeJob,
  successor: EncodeJob,
): boolean {
  return successorAffectsPublishedOutput(predecessor, successor) &&
    hasPublishedSuccessorOutput(successor);
}

export function encodeOutputArtifactReferences(
  job: EncodeJob,
  correctionLinks: readonly EncodeJob[],
  retainedOutputs: readonly RetainedEncodeOutputSummary[],
  failedOutputs: readonly ValidationFailedEncodeOutputSummary[] = [],
): EncodeOutputArtifactReference[] {
  const directSuccessor = correctionLinks.find(
    (candidate) => candidate.predecessorEncodeJobId === job.id,
  );
  const published = ownsPublishedOutput(job) &&
      (directSuccessor === undefined ||
        !successorAffectsPublishedOutput(job, directSuccessor) ||
        (directSuccessor.replaceExistingOutput &&
          !hasPublishedSuccessorOutput(directSuccessor)))
    ? [{
      identity: encodeOutputArtifactIdentity(job.id),
      state: "published" as const,
    }]
    : [];
  const retained = retainedOutputs
    .filter((output) => output.sourceEncodeJobId === job.id)
    .map((output) => ({
      identity: retainedEncodeOutputArtifactIdentity(output.id),
      state: "retained" as const,
    }));
  return [...published, ...retained, ...failedOutputs.filter((output) => output.encodeJobId === job.id)
    .map((output) => ({ identity: validationFailedEncodeOutputArtifactIdentity(output.id), state: "validation_failed" as const }))];
}

function unknownInspection(
  code: EncodeOutputInspectionReasonCode,
  reason: string,
) {
  return {
    inspectability: {
      status: "unknown" as const,
      reasonCode: code,
      reason,
    },
    media: {
      durationSeconds: null,
      streams: null,
      playability: "not_assessed" as const,
    },
  };
}

interface ResolvedEncodeOutput {
  validationRecord: EncodeOutputValidationRecord | null;
  artifactIdentity: string;
  artifactState: "published" | "retained" | "validation_failed";
  authorityKey: string;
  authorityUnavailableReason: string | null;
  job: EncodeJob;
  originalDiscArchiveId: string | null;
  outputPath: string;
  recordedFilesystemIdentity: EncodeOutputFilesystemIdentity | null;
  recordedValidationResult: "passed" | "failed" | null;
  failure?: ValidationFailedEncodeOutput["failure"];
  recordedChangeTimeMs?: number;
  recordedValidationFilesystemIdentity:
    | EncodeOutputFilesystemIdentity
    | null;
  recordedValidatedAt: Date | null;
  recordedCompleteness: "complete" | null;
  retainedOutputId: string | null;
}

interface PresentedEncodeOutputFile {
  status: "available" | "missing" | "unknown";
  identity: EncodeOutputFilesystemIdentity | null;
  mutationRevision: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  completeness: "complete" | "unknown";
  identityContinuity: "verified" | "not_recorded" | "unknown";
}

function inspectionResponse(
  input: ResolvedEncodeOutput,
  file: PresentedEncodeOutputFile,
  inspection: ReturnType<typeof unknownInspection> | {
    inspectability: {
      status: "inspected";
      reasonCode: null;
      reason: null;
    };
    media: EncodeOutputMediaInspection & { playability: "not_assessed" };
  },
) {
  const validation = presentedValidation(input, file, inspection);
  const presentedFile = {
    ...file,
    completeness: (validation.result === "passed" || validation.result === "failed") &&
        input.recordedCompleteness === "complete"
      ? "complete" as const
      : "unknown" as const,
  };
  return {
    schemaVersion: 1 as const,
    authorityRevision: evidenceDigest(input.authorityKey),
    artifact: {
      identity: input.artifactIdentity,
      type: "canonical_encode_output" as const,
      state: input.artifactState,
      encodeJob: {
        id: input.job.id,
        status: input.job.status,
        completedAt: input.job.completedAt?.toISOString() ?? null,
      },
      validation,
      provenance: outputProvenance(input),
      sourceDamage: recordedSourceDamage(input.validationRecord),
      file: presentedFile,
      ...inspection,
      availableActions: [encodeOutputExportAction(
        input,
        presentedFile,
        inspection,
      )],
    },
  };
}

function encodeOutputExportAction(
  input: ResolvedEncodeOutput,
  file: PresentedEncodeOutputFile,
  inspection: Parameters<typeof inspectionResponse>[2],
) {
  const base = {
    name: "export" as const,
    requiredInputs: ["destination"] as const,
  };
  if (input.recordedFilesystemIdentity === null) {
    return {
      ...base,
      eligible: false as const,
      reasonCode: "OUTPUT_IDENTITY_NOT_RECORDED" as const,
      reason: "The Encode Output has no recorded file identity.",
    };
  }
  if (
    file.status === "available" &&
    file.identityContinuity === "verified"
  ) {
    return {
      ...base,
      eligible: true as const,
      reasonCode: null,
      reason: null,
    };
  }
  return {
    ...base,
    eligible: false as const,
    reasonCode: inspection.inspectability.reasonCode,
    reason: inspection.inspectability.reason,
  };
}

function fileUnavailable(
  input: ResolvedEncodeOutput,
  code: EncodeOutputInspectionReasonCode,
  reason: string,
) {
  return inspectionResponse(
    input,
    {
      status: code === "OUTPUT_MISSING" ? "missing" : "unknown",
      identity: null,
      mutationRevision: null,
      sizeBytes: null,
      modifiedAt: null,
      completeness: "unknown",
      identityContinuity: "unknown",
    },
    unknownInspection(code, reason),
  );
}

function presentedValidationFailure(failure: ValidationFailedEncodeOutput["failure"]) {
  const { diagnostic: _privateDiagnostic, ...details } = failure;
  const diagnostic = failure.evidence.kind === "duration"
    ? "Encode Output duration validation failed."
    : failure.evidence.kind === "validation_check"
      ? `Encode Output ${failure.evidence.check.replaceAll("_", " ")} validation failed.`
      : "Encode Output validation failed.";
  return { ...details, diagnostic };
}

function presentedValidation(
  input: ResolvedEncodeOutput,
  file: PresentedEncodeOutputFile,
  inspection: Parameters<typeof inspectionResponse>[2],
) {
  const hasEvidence = input.recordedValidationResult !== null &&
    input.recordedValidationFilesystemIdentity !== null &&
    input.recordedValidatedAt !== null &&
    input.recordedCompleteness === "complete";
  const appliesToObservedFile = !hasEvidence || file.identity === null
    ? null
    : file.identity === input.recordedValidationFilesystemIdentity;
  const result = hasEvidence && appliesToObservedFile === true &&
      (input.recordedValidationResult === "failed" || inspection.inspectability.status === "inspected")
    ? input.recordedValidationResult!
    : "unknown" as const;
  return {
    result,
    ...(input.failure === undefined ? {} : { recordedResult: "failed" as const, failure: presentedValidationFailure(input.failure) }),
    recordIdentity: input.validationRecord?.id ?? null,
    checks: input.validationRecord?.evidence ?? null,
    identity: input.recordedValidationFilesystemIdentity,
    evidence: hasEvidence
      ? {
        kind: "encode_worker_validation" as const,
        schemaVersion: 1 as const,
        validatedAt: input.recordedValidatedAt!.toISOString(),
      }
      : null,
    evidenceAvailability: hasEvidence
      ? "recorded" as const
      : "not_recorded" as const,
    appliesToObservedFile,
  };
}

type InspectedEncodeOutputSourceSnapshot = Omit<EncodeOutputSourceSnapshot, "source"> & {
  source: Omit<EncodeClaimSource, "archive" | "output"> & {
    archive: Omit<EncodeClaimSource["archive"], "archivePath">;
    output: Omit<EncodeClaimSource["output"], "path">;
  };
};

function presentedSourceSnapshot(record: EncodeOutputValidationRecord | null): InspectedEncodeOutputSourceSnapshot | null {
  const snapshot = record?.sourceSnapshot;
  if (snapshot == null) return null;
  const { archivePath: _archivePath, ...archive } = snapshot.source.archive;
  const { path: _outputPath, ...output } = snapshot.source.output;
  return { ...snapshot, source: { ...snapshot.source, archive, output } };
}

function outputProvenance(input: ResolvedEncodeOutput) {
  const { job, originalDiscArchiveId, retainedOutputId, validationRecord } = input;
  const sourceSnapshot = presentedSourceSnapshot(validationRecord);
  return {
    encodeJobId: job.id,
    discSelectionId: sourceSnapshot?.source.selection.id ?? job.discSelectionId,
    originalDiscArchiveId: sourceSnapshot?.source.archive.id ?? originalDiscArchiveId,
    encodingProfileId: sourceSnapshot?.source.profile.id ?? job.encodingProfileId,
    retainedOutputId,
    sourceSnapshot,
    sourceSnapshotAvailability: sourceSnapshot === null ? "not_recorded" as const : "recorded" as const,
  };
}

function recordedSourceDamage(record: EncodeOutputValidationRecord | null) {
  const source = record?.sourceSnapshot?.source;
  const item = source?.assessment.items.find((candidate) => candidate.titleIdentityId === source.decision.titleIdentityId);
  return {
    knownSourceDamage: item === undefined ? null : item.unrecoveredUniqueSourceSectorCount > 0,
    unknownImpact: source === undefined || item === undefined || item.mappingCoverage.state !== "complete" ||
      assessmentHasUnknownSourceImpact(source.assessment),
    sourceContinuityRisk: source?.sourceContinuityRisk ?? null,
    watchability: "not_assessed" as const,
  };
}

function originalDiscArchiveId(
  access: ConsistentReadAccess,
  job: EncodeJob,
): string | null {
  return access.catalog.listDiscSelections({ ids: [job.discSelectionId] })[0]
    ?.originalDiscArchiveId ?? null;
}

function retainedOutputOwner(
  access: EncodeOutputInspectionReadAccess,
  output: RetainedEncodeOutput,
): EncodeJob | null {
  return access.encodeJobs.find(output.sourceEncodeJobId);
}

function resolvePublishedEncodeOutput(
  access: EncodeOutputInspectionReadAccess,
  jobId: EncodeJobId,
): ResolvedEncodeOutput {
  const artifactIdentity = encodeOutputArtifactIdentity(jobId);
  const job = access.encodeJobs.find(jobId);
  if (job === null || !ownsPublishedOutput(job)) {
    throw new RecordNotFoundError("Encode Output", artifactIdentity);
  }
  const successor = access.encodeJobs.listCorrectionLinks([job.id]).find(
    (candidate) => candidate.predecessorEncodeJobId === job.id,
  );
  const affectingSuccessor = successor !== undefined &&
      successorAffectsPublishedOutput(job, successor)
    ? successor
    : undefined;
  const authorityUnavailableReason = job.publicationPending === true ||
      affectingSuccessor?.publicationPending === true
    ? "A corrected Encode Output publication is changing artifact authority."
    : affectingSuccessor !== undefined &&
        !hasPublishedSuccessorOutput(affectingSuccessor) &&
        !affectingSuccessor.replaceExistingOutput
      ? "The published Encode Output no longer has recorded artifact authority."
    : null;
  if (
    authorityUnavailableReason === null &&
    affectingSuccessor !== undefined &&
    successorReplacedPublishedOutput(job, affectingSuccessor)
  ) {
    throw new RecordNotFoundError("Encode Output", artifactIdentity);
  }
  return {
    artifactIdentity,
    artifactState: "published",
    validationRecord: job.outputValidationFilesystemIdentity === null || job.outputValidatedAt === null ? null
      : access.encodeJobs.findOutputValidation(job.id, job.outputValidationFilesystemIdentity, job.outputValidatedAt),
    authorityKey: JSON.stringify([
      job.id,
      job.status,
      job.completedAt?.toISOString() ?? null,
      job.outputPath,
      job.publicationPending,
      job.publicationCompletionPending,
      job.outputValidationResult,
      job.outputValidationFilesystemIdentity,
      job.outputValidatedAt?.toISOString() ?? null,
      job.outputCompleteness,
      affectingSuccessor?.id ?? null,
      affectingSuccessor?.status ?? null,
      affectingSuccessor?.completedAt?.toISOString() ?? null,
      affectingSuccessor?.outputPath ?? null,
      affectingSuccessor?.replaceExistingOutput ?? null,
      affectingSuccessor?.publicationPending ?? null,
    ]),
    authorityUnavailableReason,
    job,
    originalDiscArchiveId: originalDiscArchiveId(access, job),
    outputPath: job.outputPath,
    recordedFilesystemIdentity: job.outputValidationFilesystemIdentity,
    recordedValidationResult: job.outputValidationResult,
    recordedValidationFilesystemIdentity:
      job.outputValidationFilesystemIdentity,
    recordedValidatedAt: job.outputValidatedAt,
    recordedCompleteness: job.outputCompleteness,
    retainedOutputId: null,
  };
}

function resolveRetainedEncodeOutput(
  access: EncodeOutputInspectionReadAccess,
  retainedOutputId: RetainedEncodeOutputId,
): ResolvedEncodeOutput {
  const artifactIdentity = retainedEncodeOutputArtifactIdentity(
    retainedOutputId,
  );
  const retainedOutput = access.encodeJobs.findRetainedOutput(retainedOutputId);
  if (retainedOutput === null) {
    throw new RecordNotFoundError("Encode Output", artifactIdentity);
  }
  const job = retainedOutputOwner(access, retainedOutput);
  if (job === null) {
    throw new RecordNotFoundError("Encode Output", artifactIdentity);
  }
  return {
    artifactIdentity,
    artifactState: "retained",
    validationRecord: retainedOutput.validationFilesystemIdentity === null || retainedOutput.validatedAt === null ? null
      : access.encodeJobs.findOutputValidation(job.id, retainedOutput.validationFilesystemIdentity, retainedOutput.validatedAt),
    authorityKey: JSON.stringify([
      retainedOutput.id,
      retainedOutput.predecessorEncodeJobId,
      retainedOutput.replacementEncodeJobId,
      retainedOutput.sourceEncodeJobId,
      retainedOutput.retainedOutputPath,
      retainedOutput.filesystemIdentity,
      retainedOutput.validationResult,
      retainedOutput.validationFilesystemIdentity,
      retainedOutput.validatedAt?.toISOString() ?? null,
      retainedOutput.completeness,
      retainedOutput.state,
      retainedOutput.retainedAt.toISOString(),
    ]),
    authorityUnavailableReason: null,
    job,
    originalDiscArchiveId: originalDiscArchiveId(access, job),
    outputPath: retainedOutput.retainedOutputPath,
    recordedFilesystemIdentity: retainedOutput.filesystemIdentity,
    recordedValidationResult: retainedOutput.validationResult,
    recordedValidationFilesystemIdentity:
      retainedOutput.validationFilesystemIdentity,
    recordedValidatedAt: retainedOutput.validatedAt,
    recordedCompleteness: retainedOutput.completeness,
    retainedOutputId: retainedOutput.id,
  };
}

function resolveValidationFailedEncodeOutput(
  access: EncodeOutputInspectionReadAccess,
  id: ValidationFailedEncodeOutputId,
): ResolvedEncodeOutput {
  const artifactIdentity = validationFailedEncodeOutputArtifactIdentity(id);
  const output = access.encodeJobs.findValidationFailedOutput(id);
  const job = output === null ? null : access.encodeJobs.find(output.encodeJobId);
  if (output === null || job === null) throw new RecordNotFoundError("Encode Output", artifactIdentity);
  return {
    artifactIdentity, artifactState: "validation_failed", job,
    validationRecord: { ...output, evidence: null }, failure: output.failure,
    authorityKey: canonicalPublicationJson(output), authorityUnavailableReason: null,
    originalDiscArchiveId: originalDiscArchiveId(access, job), outputPath: output.outputPath,
    recordedFilesystemIdentity: output.filesystemIdentity, recordedValidationResult: "failed",
    recordedValidationFilesystemIdentity: output.filesystemIdentity, recordedValidatedAt: output.validatedAt,
    recordedCompleteness: "complete", retainedOutputId: null, recordedChangeTimeMs: output.changeTimeMs,
  };
}

function resolveEncodeOutputAuthority(
  access: DataAccess,
  identity: ParsedEncodeOutputArtifactIdentity,
): ResolvedEncodeOutput {
  return access.readEncodeOutputInspectionSnapshot((snapshot) =>
    identity.kind === "published"
      ? resolvePublishedEncodeOutput(snapshot, identity.jobId)
      : identity.kind === "failed"
        ? resolveValidationFailedEncodeOutput(snapshot, identity.failedOutputId)
        : resolveRetainedEncodeOutput(snapshot, identity.retainedOutputId)
  );
}

function changedAuthorityResponse(
  access: DataAccess,
  parsedIdentity: ParsedEncodeOutputArtifactIdentity,
  base: ResolvedEncodeOutput,
) {
  return encodeOutputAuthorityChanged(access, parsedIdentity, base)
    ? fileUnavailable(
      base,
      "OUTPUT_AUTHORITY_CHANGED",
      "Encode Output authority changed while the artifact was being inspected.",
    )
    : null;
}

function encodeOutputAuthorityChanged(
  access: DataAccess,
  parsedIdentity: ParsedEncodeOutputArtifactIdentity,
  base: ResolvedEncodeOutput,
): boolean {
  let currentAuthority: ResolvedEncodeOutput | null = null;
  try {
    currentAuthority = resolveEncodeOutputAuthority(access, parsedIdentity);
  } catch (error) {
    if (!(error instanceof RecordNotFoundError)) throw error;
  }
  return currentAuthority === null ||
      currentAuthority.authorityUnavailableReason !== null ||
      currentAuthority.authorityKey !== base.authorityKey;
}

function filesystemFailure(error: unknown): {
  code: "OUTPUT_MISSING" | "OUTPUT_FILE_UNAVAILABLE";
  reason: string;
} {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT"
    ? { code: "OUTPUT_MISSING", reason: "The recorded Encode Output file is missing." }
    : {
        code: "OUTPUT_FILE_UNAVAILABLE",
        reason: "The recorded Encode Output file could not be inspected.",
      };
}

function fileIsRegularAndNonempty(metadata: Stats): {
  code: "OUTPUT_NOT_REGULAR" | "OUTPUT_EMPTY";
  reason: string;
} | null {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return {
      code: "OUTPUT_NOT_REGULAR",
      reason: "The recorded Encode Output is not a regular file.",
    };
  }
  return metadata.size === 0
    ? { code: "OUTPUT_EMPTY", reason: "The recorded Encode Output file is empty." }
    : null;
}

async function inspectEncodeOutputEvidence(
  access: DataAccess,
  artifactIdentityInput: unknown,
  mediaProbe: EncodeOutputMediaProbe = probeEncodeOutputMedia,
) {
  const parsedIdentity = parseEncodeOutputArtifactIdentity(
    artifactIdentityInput,
  );
  const base = resolveEncodeOutputAuthority(access, parsedIdentity);
  if (base.authorityUnavailableReason !== null) {
    return fileUnavailable(
      base,
      "OUTPUT_AUTHORITY_CHANGED",
      base.authorityUnavailableReason,
    );
  }
  let before: Stats;
  try {
    before = await lstat(base.outputPath);
  } catch (error) {
    const changedAuthority = changedAuthorityResponse(
      access,
      parsedIdentity,
      base,
    );
    if (changedAuthority !== null) return changedAuthority;
    const failure = filesystemFailure(error);
    return fileUnavailable(base, failure.code, failure.reason);
  }
  const unsafeFile = fileIsRegularAndNonempty(before);
  if (unsafeFile !== null) {
    const changedAuthority = changedAuthorityResponse(
      access,
      parsedIdentity,
      base,
    );
    if (changedAuthority !== null) return changedAuthority;
    return fileUnavailable(base, unsafeFile.code, unsafeFile.reason);
  }
  if (
    base.recordedFilesystemIdentity !== null &&
    (!matchesEncodeOutputFilesystemIdentity(
      base.recordedFilesystemIdentity,
      before,
    ) || (base.recordedChangeTimeMs !== undefined && before.ctimeMs !== base.recordedChangeTimeMs))
  ) {
    const changedAuthority = changedAuthorityResponse(
      access,
      parsedIdentity,
      base,
    );
    if (changedAuthority !== null) return changedAuthority;
    return fileUnavailable(
      base,
      "OUTPUT_IDENTITY_CHANGED",
      "The Encode Output no longer matches its recorded file identity.",
    );
  }

  const identity = encodeOutputFilesystemIdentity(before);
  const identityContinuity = base.recordedFilesystemIdentity === null
    ? "not_recorded" as const
    : "verified" as const;
  let media: EncodeOutputMediaInspection | null = null;
  try {
    media = await mediaProbe(base.outputPath);
  } catch {
    // The post-probe stat below still has to prove the file stayed stable.
  }

  let after: Stats;
  try {
    after = await lstat(base.outputPath);
  } catch {
    const changedAuthority = changedAuthorityResponse(
      access,
      parsedIdentity,
      base,
    );
    if (changedAuthority !== null) return changedAuthority;
    return fileUnavailable(
      base,
      "OUTPUT_CHANGED_DURING_INSPECTION",
      "The Encode Output changed while it was being inspected.",
    );
  }
  if (!sameEncodeOutputMutationSnapshot(before, after)) {
    const changedAuthority = changedAuthorityResponse(
      access,
      parsedIdentity,
      base,
    );
    if (changedAuthority !== null) return changedAuthority;
    return fileUnavailable(
      base,
      "OUTPUT_CHANGED_DURING_INSPECTION",
      "The Encode Output changed while it was being inspected.",
    );
  }
  const changedAuthority = changedAuthorityResponse(
    access,
    parsedIdentity,
    base,
  );
  if (changedAuthority !== null) return changedAuthority;

  if (media === null) {
    return inspectionResponse(
      base,
      {
        status: "available",
        identity,
        mutationRevision: fileMutationRevision(before),
        sizeBytes: before.size,
        modifiedAt: before.mtime.toISOString(),
        completeness: "unknown",
        identityContinuity,
      },
      unknownInspection(
        "OUTPUT_PROBE_FAILED",
        "The Encode Output media probe did not return usable metadata.",
      ),
    );
  }

  return inspectionResponse(
    base,
    {
      status: "available",
      identity,
      mutationRevision: fileMutationRevision(before),
      sizeBytes: before.size,
      modifiedAt: before.mtime.toISOString(),
      completeness: "unknown",
      identityContinuity,
    },
    {
      inspectability: {
        status: "inspected",
        reasonCode: null,
        reason: null,
      },
      media: {
        durationSeconds: media.durationSeconds,
        streams: media.streams,
        playability: "not_assessed",
      },
    },
  );
}

function evidenceDigest(evidence: unknown): string {
  return createHash("sha256").update(canonicalPublicationJson(evidence)).digest("hex");
}

function fileMutationRevision(metadata: Stats): string {
  return evidenceDigest([encodeOutputFilesystemIdentity(metadata), metadata.ctimeMs]);
}

type EncodeOutputAcknowledgedEvidence = Awaited<ReturnType<typeof inspectEncodeOutputEvidence>>["artifact"];

function presentInspectionReceipt(record: EncodeOutputInspectionReceiptRecord) {
  const { evidenceJson, ...receipt } = record;
  return { ...receipt, evidence: JSON.parse(evidenceJson) as EncodeOutputAcknowledgedEvidence };
}

export type EncodeOutputInspectionReceipt = ReturnType<typeof presentInspectionReceipt>;

export async function inspectEncodeOutput(
  access: DataAccess,
  artifactIdentityInput: unknown,
  mediaProbe: EncodeOutputMediaProbe = probeEncodeOutputMedia,
  page: { receiptLimit?: number; receiptOffset?: number } = {},
) {
  const limit = page.receiptLimit ?? 20;
  const offset = page.receiptOffset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0) throw new InvalidEncodeOutputInspectionInputError();
  const inspected = await inspectEncodeOutputEvidence(access, artifactIdentityInput, mediaProbe);
  const artifact = inspected.artifact;
  // File and validation evidence distinguish generations even when a job is requeued.
  // Retaining the same normal output does not create a different generation.
  const generationIdentity = artifact.file.identity === null ? null : `encode-output-generation-v1.${evidenceDigest([
    artifact.provenance.encodeJobId,
    artifact.file.identity,
    artifact.validation.identity,
    artifact.validation.evidence,
    ...(artifact.state === "validation_failed" ? [artifact.state, artifact.validation.recordIdentity] : []),
  ])}`;
  const eligible = artifact.file.status === "available" &&
    artifact.file.identityContinuity === "verified";
  const historyPage = access.encodeOutputInspectionReceipts.list(artifact.provenance.encodeJobId, { limit, offset });
  const history = historyPage.receipts.map(presentInspectionReceipt);
  const latestRecord = generationIdentity === null ? null : access.encodeOutputInspectionReceipts
    .latestForGeneration(artifact.provenance.encodeJobId, generationIdentity);
  const latest = latestRecord === null ? null : presentInspectionReceipt(latestRecord);
  const receipts = latest !== null && latest.evidence.file.mutationRevision === artifact.file.mutationRevision &&
      canonicalPublicationJson(latest.evidence.provenance) === canonicalPublicationJson(artifact.provenance)
    ? [latest] : [];
  return {
    ...inspected,
    operatorInspection: {
      generationIdentity,
      reviewToken: evidenceDigest(inspected),
      status: receipts.length === 0 ? "not_acknowledged" as const : "acknowledged" as const,
      acknowledgement: {
        eligible,
        reasonCode: eligible ? null : artifact.file.identityContinuity === "not_recorded"
          ? "OUTPUT_IDENTITY_NOT_RECORDED" : artifact.inspectability.reasonCode,
        requiredInputs: ["acknowledged", "reviewToken", "artifactIdentity", "mutationKey"],
      },
      receipts,
      history,
      historyNextOffset: historyPage.nextOffset,
    },
  };
}

export class InvalidEncodeOutputInspectionInputError extends Error {
  constructor() {
    super("Receipt history requires a limit from 1 to 100 and a nonnegative integer offset.");
    this.name = "InvalidEncodeOutputInspectionInputError";
  }
}

export class InvalidEncodeOutputAcknowledgementError extends Error {
  constructor() {
    super("Explicit acknowledgement and the exact reviewed inspection token are required.");
    this.name = "InvalidEncodeOutputAcknowledgementError";
  }
}

export class EncodeOutputAcknowledgementRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly current: EncodeOutputInspection | null,
    readonly currentIdentity: EncodeOutputFilesystemIdentity | null = current?.artifact.file.identity ?? null,
  ) {
    super("Encode Output inspection acknowledgement rejected. Inspect the current evidence again.");
    this.name = "EncodeOutputAcknowledgementRejectedError";
  }
}

function acknowledgementResult(record: EncodeOutputInspectionReceiptRecord) {
  return { schemaVersion: 1 as const, receipt: presentInspectionReceipt(record) };
}

async function rejectAcknowledgementWithCurrentEvidence(
  access: DataAccess,
  input: EncodeOutputInspectionAcknowledgement,
  mediaProbe: EncodeOutputMediaProbe,
  reasonCode: string,
) {
  let fresh: EncodeOutputInspection | null = null;
  try { fresh = await inspectEncodeOutput(access, input.artifactIdentity, mediaProbe); }
  catch (error) { if (!(error instanceof RecordNotFoundError)) throw error; }
  let currentIdentity: EncodeOutputFilesystemIdentity | null = null;
  try {
    const authority = resolveEncodeOutputAuthority(access, parseEncodeOutputArtifactIdentity(input.artifactIdentity));
    currentIdentity = await currentEncodeOutputIdentity(authority.outputPath);
  } catch (error) { if (!(error instanceof RecordNotFoundError)) throw error; }
  // Refreshing may race a successfully committed retry too.
  const replay = access.encodeOutputInspectionReceipts.replay(input);
  if (replay !== null) return acknowledgementResult(replay);
  throw new EncodeOutputAcknowledgementRejectedError(
    fresh === null ? "OUTPUT_AUTHORITY_CHANGED"
      : !fresh.operatorInspection.acknowledgement.eligible
        ? fresh.operatorInspection.acknowledgement.reasonCode ?? "OUTPUT_AUTHORITY_CHANGED"
        : reasonCode,
    fresh,
    currentIdentity,
  );
}

export async function acknowledgeEncodeOutputInspection(
  access: DataAccess,
  artifactIdentityInput: unknown,
  raw: unknown,
  mediaProbe: EncodeOutputMediaProbe = probeEncodeOutputMedia,
) {
  const parsed = parseEncodeOutputArtifactIdentity(artifactIdentityInput);
  const artifactIdentity = parsed.kind === "published"
    ? encodeOutputArtifactIdentity(parsed.jobId)
    : parsed.kind === "failed" ? validationFailedEncodeOutputArtifactIdentity(parsed.failedOutputId)
    : retainedEncodeOutputArtifactIdentity(parsed.retainedOutputId);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidEncodeOutputAcknowledgementError();
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["mutationKey", "reviewToken", "acknowledged"].includes(key)) ||
      body.acknowledged !== true || typeof body.reviewToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.reviewToken)) {
    throw new InvalidEncodeOutputAcknowledgementError();
  }
  const input: EncodeOutputInspectionAcknowledgement = {
    mutationKey: parseMutationKey(body.mutationKey), artifactIdentity,
    acknowledged: true, reviewToken: body.reviewToken,
  };
  const replayed = access.encodeOutputInspectionReceipts.replay(input);
  if (replayed !== null) return acknowledgementResult(replayed);
  let current: EncodeOutputInspection;
  try {
    current = await inspectEncodeOutput(access, artifactIdentity, mediaProbe);
  } catch (error) {
    const replay = access.encodeOutputInspectionReceipts.replay(input);
    if (replay !== null) return acknowledgementResult(replay);
    if (!(error instanceof RecordNotFoundError)) throw error;
    return rejectAcknowledgementWithCurrentEvidence(access, input, mediaProbe, "OUTPUT_AUTHORITY_CHANGED");
  }
  const concurrentReplay = access.encodeOutputInspectionReceipts.replay(input);
  if (concurrentReplay !== null) return acknowledgementResult(concurrentReplay);
  if (!current.operatorInspection.acknowledgement.eligible) {
    return rejectAcknowledgementWithCurrentEvidence(access, input, mediaProbe,
      current.operatorInspection.acknowledgement.reasonCode ?? "OUTPUT_AUTHORITY_CHANGED");
  }
  if (current.operatorInspection.reviewToken !== input.reviewToken) {
    return rejectAcknowledgementWithCurrentEvidence(access, input, mediaProbe, "OUTPUT_INSPECTION_STALE");
  }
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const base = resolveEncodeOutputAuthority(access, parsed);
    descriptor = await open(base.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = descriptor;
    const record = access.encodeOutputInspectionReceipts.record(input, () => {
      // Publication commits its authority fence before changing media. Stage
      // file checks outside SQLite, then reject a changed fence in the write.
      const file = fstatSync(opened.fd);
      const path = lstatSync(base.outputPath);
      if (fileIsRegularAndNonempty(file) !== null || fileIsRegularAndNonempty(path) !== null ||
          !sameEncodeOutputMutationSnapshot(file, path) ||
          fileMutationRevision(file) !== current.artifact.file.mutationRevision) {
        throw new EncodeOutputAcknowledgementRejectedError("OUTPUT_IDENTITY_CHANGED", current);
      }
      return {
        generationIdentity: current.operatorInspection.generationIdentity!,
        encodeJobId: current.artifact.provenance.encodeJobId,
        evidenceJson: canonicalPublicationJson(current.artifact),
        assertAuthority() {
          const authority = resolveEncodeOutputAuthority(access, parsed);
          if (authority.authorityUnavailableReason !== null ||
              evidenceDigest(authority.authorityKey) !== current.authorityRevision ||
              canonicalPublicationJson(outputProvenance(authority)) !==
                canonicalPublicationJson(current.artifact.provenance)) {
            throw new EncodeOutputAcknowledgementRejectedError("OUTPUT_AUTHORITY_CHANGED", current);
          }
        },
      };
    });
    return acknowledgementResult(record);
  } catch (error) {
    const replay = access.encodeOutputInspectionReceipts.replay(input);
    if (replay !== null) return acknowledgementResult(replay);
    const fileError = typeof error === "object" && error !== null && "code" in error &&
      ["ENOENT", "EACCES", "ELOOP", "ENOTDIR", "ESTALE"].includes(String(error.code));
    if (!(error instanceof EncodeOutputAcknowledgementRejectedError) &&
        !(error instanceof RecordNotFoundError) && !fileError) throw error;
    // The transaction has rolled back. Return fresh identities, including when
    // the change happened after the asynchronous probe or descriptor open.
    return await rejectAcknowledgementWithCurrentEvidence(access, input, mediaProbe,
      error instanceof EncodeOutputAcknowledgementRejectedError ? error.reasonCode : "OUTPUT_INSPECTION_STALE");
  } finally {
    await descriptor?.close();
  }
}

const EXPORT_BUFFER_SIZE_BYTES = 1024 * 1024;

class EncodeOutputExportCopyError extends Error {
  constructor(readonly area: "source" | "destination") {
    super(`Encode Output export ${area} failed.`);
  }
}

async function currentEncodeOutputIdentity(
  outputPath: string,
): Promise<EncodeOutputFilesystemIdentity | null> {
  try {
    return encodeOutputFilesystemIdentity(await lstat(outputPath));
  } catch {
    return null;
  }
}

async function rejectedSourceOpen(
  base: ResolvedEncodeOutput,
  error: unknown,
): Promise<EncodeOutputExportRejectedError> {
  try {
    const metadata = await lstat(base.outputPath);
    const currentIdentity = encodeOutputFilesystemIdentity(metadata);
    const unsafeFile = fileIsRegularAndNonempty(metadata);
    if (unsafeFile !== null) {
      return new EncodeOutputExportRejectedError(
        unsafeFile.code,
        unsafeFile.reason,
        base.artifactIdentity,
        currentIdentity,
      );
    }
    return new EncodeOutputExportRejectedError(
      "OUTPUT_FILE_UNAVAILABLE",
      "The recorded Encode Output file could not be inspected.",
      base.artifactIdentity,
      currentIdentity,
    );
  } catch {
    const failure = filesystemFailure(error);
    return new EncodeOutputExportRejectedError(
      failure.code,
      failure.reason,
      base.artifactIdentity,
      null,
    );
  }
}

function exportSourceRejection(
  base: ResolvedEncodeOutput,
  metadata: Stats,
): EncodeOutputExportRejectedError | null {
  const currentIdentity = encodeOutputFilesystemIdentity(metadata);
  const unsafeFile = fileIsRegularAndNonempty(metadata);
  if (unsafeFile !== null) {
    return new EncodeOutputExportRejectedError(
      unsafeFile.code,
      unsafeFile.reason,
      base.artifactIdentity,
      currentIdentity,
    );
  }
  if (base.recordedFilesystemIdentity === null) {
    return new EncodeOutputExportRejectedError(
      "OUTPUT_IDENTITY_NOT_RECORDED",
      "The Encode Output has no recorded file identity.",
      base.artifactIdentity,
      currentIdentity,
    );
  }
  return matchesEncodeOutputFilesystemIdentity(
    base.recordedFilesystemIdentity,
    metadata,
  ) && (base.recordedChangeTimeMs === undefined || metadata.ctimeMs === base.recordedChangeTimeMs)
    ? null
    : new EncodeOutputExportRejectedError(
      "OUTPUT_IDENTITY_CHANGED",
      "The Encode Output no longer matches its recorded file identity.",
      base.artifactIdentity,
      currentIdentity,
    );
}

async function removeCreatedExportDestination(
  destinationPath: string,
  openedMetadata: Stats,
): Promise<void> {
  try {
    const currentMetadata = await lstat(destinationPath);
    if (sameEncodeOutputInode(openedMetadata, currentMetadata)) {
      await unlink(destinationPath);
    }
  } catch {
    // The path is already absent or no longer safe for this operation to remove.
  }
}

async function copyOpenFile(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(EXPORT_BUFFER_SIZE_BYTES);
  let position = 0;
  while (true) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await source.read(
        buffer,
        0,
        buffer.length,
        position,
      ));
    } catch {
      throw new EncodeOutputExportCopyError("source");
    }
    if (bytesRead === 0) return position;
    let written = 0;
    while (written < bytesRead) {
      let result: { bytesWritten: number };
      try {
        result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
      } catch {
        throw new EncodeOutputExportCopyError("destination");
      }
      if (result.bytesWritten === 0) {
        throw new EncodeOutputExportCopyError("destination");
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

export async function exportEncodeOutput(
  access: DataAccess,
  input: { artifactIdentity: unknown; destination: unknown },
) {
  if (
    typeof input.destination !== "string" ||
    input.destination.trim() === "" ||
    input.destination.length > 4_096
  ) {
    throw new InvalidEncodeOutputExportInputError(
      "Encode Output export destination is required.",
    );
  }
  const parsedIdentity = parseEncodeOutputArtifactIdentity(
    input.artifactIdentity,
  );
  const initialAuthority = resolveEncodeOutputAuthority(access, parsedIdentity);
  if (initialAuthority.authorityUnavailableReason !== null) {
    throw new EncodeOutputExportRejectedError(
      "OUTPUT_AUTHORITY_CHANGED",
      initialAuthority.authorityUnavailableReason,
      initialAuthority.artifactIdentity,
      await currentEncodeOutputIdentity(initialAuthority.outputPath),
    );
  }
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let openedDestinationMetadata: Stats | undefined;
  let exportCompleted = false;
  try {
    let pathBeforeOpen: Stats;
    try {
      pathBeforeOpen = await lstat(initialAuthority.outputPath);
    } catch (error) {
      throw await rejectedSourceOpen(initialAuthority, error);
    }
    const pathRejection = exportSourceRejection(
      initialAuthority,
      pathBeforeOpen,
    );
    if (pathRejection !== null) throw pathRejection;
    try {
      source = await open(
        initialAuthority.outputPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw await rejectedSourceOpen(initialAuthority, error);
    }
    const before = await source.stat();
    const sourceRejection = exportSourceRejection(initialAuthority, before);
    if (sourceRejection !== null) throw sourceRejection;
    const sourceIdentity = encodeOutputFilesystemIdentity(before);
    try {
      destination = await open(input.destination, "wx", 0o600);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      throw new EncodeOutputExportRejectedError(
        code === "EEXIST"
          ? "EXPORT_DESTINATION_EXISTS"
          : "EXPORT_DESTINATION_UNAVAILABLE",
        code === "EEXIST"
          ? "The Encode Output export destination already exists."
          : "The Encode Output export destination is unavailable.",
        initialAuthority.artifactIdentity,
        sourceIdentity,
      );
    }
    openedDestinationMetadata = await destination.stat();
    let byteSize: number;
    try {
      byteSize = await copyOpenFile(source, destination);
    } catch (error) {
      if (!(error instanceof EncodeOutputExportCopyError)) throw error;
      throw new EncodeOutputExportRejectedError(
        error.area === "source"
          ? "OUTPUT_FILE_UNAVAILABLE"
          : "EXPORT_DESTINATION_UNAVAILABLE",
        error.area === "source"
          ? "The recorded Encode Output file could not be read."
          : "The Encode Output export destination could not be written.",
        initialAuthority.artifactIdentity,
        await currentEncodeOutputIdentity(initialAuthority.outputPath),
      );
    }
    try {
      await destination.sync();
    } catch {
      throw new EncodeOutputExportRejectedError(
        "EXPORT_DESTINATION_UNAVAILABLE",
        "The Encode Output export destination could not be synchronized.",
        initialAuthority.artifactIdentity,
        await currentEncodeOutputIdentity(initialAuthority.outputPath),
      );
    }
    try {
      const destinationAfter = await destination.stat();
      const destinationPathAfter = await lstat(input.destination);
      if (
        destinationAfter.size !== byteSize ||
        !sameEncodeOutputMutationSnapshot(
          destinationAfter,
          destinationPathAfter,
        )
      ) {
        throw new Error("destination changed");
      }
    } catch {
      throw new EncodeOutputExportRejectedError(
        "EXPORT_DESTINATION_UNAVAILABLE",
        "The Encode Output export destination changed during export.",
        initialAuthority.artifactIdentity,
        await currentEncodeOutputIdentity(initialAuthority.outputPath),
      );
    }
    let after: Stats;
    try {
      after = await source.stat();
    } catch {
      throw new EncodeOutputExportRejectedError(
        "OUTPUT_FILE_UNAVAILABLE",
        "The recorded Encode Output file could not be inspected after export.",
        initialAuthority.artifactIdentity,
        await currentEncodeOutputIdentity(initialAuthority.outputPath),
      );
    }
    let currentPath: Stats;
    try {
      currentPath = await lstat(initialAuthority.outputPath);
    } catch {
      throw new EncodeOutputExportRejectedError(
        "OUTPUT_CHANGED_DURING_EXPORT",
        "The Encode Output changed while it was being exported.",
        initialAuthority.artifactIdentity,
        null,
      );
    }
    if (
      !sameEncodeOutputMutationSnapshot(before, after) ||
      !sameEncodeOutputMutationSnapshot(before, currentPath)
    ) {
      throw new EncodeOutputExportRejectedError(
        "OUTPUT_CHANGED_DURING_EXPORT",
        "The Encode Output changed while it was being exported.",
        initialAuthority.artifactIdentity,
        encodeOutputFilesystemIdentity(currentPath),
      );
    }
    if (
      encodeOutputAuthorityChanged(access, parsedIdentity, initialAuthority)
    ) {
      throw new EncodeOutputExportRejectedError(
        "OUTPUT_AUTHORITY_CHANGED",
        "Encode Output authority changed while the artifact was being exported.",
        initialAuthority.artifactIdentity,
        encodeOutputFilesystemIdentity(currentPath),
      );
    }
    exportCompleted = true;
    return {
      schemaVersion: 1 as const,
      artifact: {
        identity: initialAuthority.artifactIdentity,
        type: "canonical_encode_output" as const,
        state: initialAuthority.artifactState,
      },
      byteSize,
      destination: input.destination,
      sourceIdentity,
      provenance: outputProvenance(initialAuthority),
    };
  } finally {
    await destination?.close().catch(() => {});
    await source?.close().catch(() => {});
    if (openedDestinationMetadata !== undefined && !exportCompleted) {
      await removeCreatedExportDestination(
        input.destination,
        openedDestinationMetadata,
      );
    }
  }
}

export type EncodeOutputInspection = Awaited<
  ReturnType<typeof inspectEncodeOutput>
>;
