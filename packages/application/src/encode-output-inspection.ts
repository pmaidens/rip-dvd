import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

import {
  encodeOutputFilesystemIdentity,
  matchesEncodeOutputFilesystemIdentity,
  RecordNotFoundError,
  sameEncodeOutputMutationSnapshot,
} from "@rip-dvd/data-access";
import type {
  DataAccess,
  EncodeJob,
  EncodeJobId,
  EncodeOutputFilesystemIdentity,
} from "@rip-dvd/data-access";

const ENCODE_OUTPUT_ARTIFACT_PREFIX = "encode-output-v1.";
const ENCODE_OUTPUT_ARTIFACT_PATTERN =
  /^encode-output-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
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
  | "OUTPUT_PROBE_FAILED"
  | "OUTPUT_PROVENANCE_INCOMPLETE";

export class InvalidEncodeOutputArtifactIdentityError extends Error {
  constructor() {
    super("Invalid Encode Output artifact identity.");
    this.name = "InvalidEncodeOutputArtifactIdentityError";
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
  return `${ENCODE_OUTPUT_ARTIFACT_PREFIX}${jobId}`;
}

function encodeJobIdFromArtifactIdentity(identity: unknown): EncodeJobId {
  if (typeof identity !== "string") {
    throw new InvalidEncodeOutputArtifactIdentityError();
  }
  const match = ENCODE_OUTPUT_ARTIFACT_PATTERN.exec(identity.trim());
  if (!match) {
    throw new InvalidEncodeOutputArtifactIdentityError();
  }
  return match[1] as EncodeJobId;
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
  artifactIdentity: string;
  artifactState: "published" | "retained";
  job: EncodeJob;
  originalDiscArchiveId: string | null;
  retainedOutputId: string | null;
}

interface PresentedEncodeOutputFile {
  status: "available" | "missing" | "unknown";
  identity: EncodeOutputFilesystemIdentity | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  completeness: "complete" | "unknown";
  identityContinuity: "verified" | "not_recorded" | "unknown";
}

function inspectionResponse(
  input: ResolvedEncodeOutput,
  file: PresentedEncodeOutputFile,
  validationResult: "passed" | "unknown",
  validationAppliesToObservedFile: boolean | null,
  inspection: ReturnType<typeof unknownInspection> | {
    inspectability: {
      status: "inspected";
      reasonCode: null;
      reason: null;
    };
    media: EncodeOutputMediaInspection & { playability: "not_assessed" };
  },
) {
  return {
    schemaVersion: 1 as const,
    artifact: {
      identity: input.artifactIdentity,
      type: "canonical_encode_output" as const,
      state: input.artifactState,
      encodeJob: {
        id: input.job.id,
        status: input.job.status,
        completedAt: input.job.completedAt?.toISOString() ?? null,
      },
      validation: presentedValidation(
        validationResult,
        validationAppliesToObservedFile,
      ),
      provenance: historicalProvenance(
        input.job,
        input.originalDiscArchiveId,
        input.retainedOutputId,
      ),
      file,
      ...inspection,
      availableActions: [{
        name: "export" as const,
        eligible: false,
        reason: "Canonical Encode Output export is not available.",
      }],
    },
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
      sizeBytes: null,
      modifiedAt: null,
      completeness: "unknown",
      identityContinuity: "unknown",
    },
    "unknown",
    null,
    unknownInspection(code, reason),
  );
}

function presentedValidation(
  result: "passed" | "unknown",
  appliesToObservedFile: boolean | null,
) {
  return {
    result,
    identity: null,
    evidence: null,
    evidenceAvailability: "not_recorded" as const,
    appliesToObservedFile,
  };
}

function historicalProvenance(
  job: EncodeJob,
  originalDiscArchiveId: string | null,
  retainedOutputId: string | null,
) {
  return {
    encodeJobId: job.id,
    discSelectionId: job.discSelectionId,
    originalDiscArchiveId,
    encodingProfileId: job.encodingProfileId,
    retainedOutputId,
    sourceSnapshot: null,
    sourceSnapshotAvailability: "not_recorded" as const,
  };
}

function filesystemFailure(error: unknown): {
  code: EncodeOutputInspectionReasonCode;
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
  code: EncodeOutputInspectionReasonCode;
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

export async function inspectEncodeOutput(
  access: DataAccess,
  artifactIdentityInput: unknown,
  mediaProbe: EncodeOutputMediaProbe = probeEncodeOutputMedia,
) {
  const jobId = encodeJobIdFromArtifactIdentity(artifactIdentityInput);
  const artifactIdentity = encodeOutputArtifactIdentity(jobId);
  const job = access.encodeJobs.find(jobId);
  if (job?.status !== "completed") {
    throw new RecordNotFoundError("Encode Output", artifactIdentity);
  }
  const selection = access.catalog.listDiscSelections({
    ids: [job.discSelectionId],
  })[0];
  const retainedOutputs = access.encodeJobs.listRetainedOutputs([job.id]);
  const retainedOutput = retainedOutputs.find(
    (output) => output.predecessorEncodeJobId === job.id,
  );
  const successor = access.encodeJobs.listCorrectionLinks([job.id]).find(
    (candidate) => candidate.predecessorEncodeJobId === job.id,
  );
  const artifactState = retainedOutput === undefined
    ? "published" as const
    : "retained" as const;
  const base = {
    artifactIdentity,
    artifactState,
    job,
    originalDiscArchiveId: selection?.originalDiscArchiveId ?? null,
    retainedOutputId: retainedOutput?.id ?? null,
  };
  if (successor?.status === "completed" && retainedOutput === undefined) {
    return fileUnavailable(
      base,
      "OUTPUT_PROVENANCE_INCOMPLETE",
      "The superseded Encode Output has no retained artifact provenance.",
    );
  }
  const outputPath = retainedOutput?.retainedOutputPath ?? job.outputPath;
  let before: Stats;
  try {
    before = await lstat(outputPath);
  } catch (error) {
    const failure = filesystemFailure(error);
    return fileUnavailable(base, failure.code, failure.reason);
  }
  const unsafeFile = fileIsRegularAndNonempty(before);
  if (unsafeFile !== null) {
    return fileUnavailable(base, unsafeFile.code, unsafeFile.reason);
  }
  if (
    retainedOutput !== undefined &&
    !matchesEncodeOutputFilesystemIdentity(
      retainedOutput.filesystemIdentity,
      before,
    )
  ) {
    return fileUnavailable(
      base,
      "OUTPUT_IDENTITY_CHANGED",
      "The retained Encode Output no longer matches its recorded file identity.",
    );
  }

  const identity = encodeOutputFilesystemIdentity(before);
  const identityContinuity = retainedOutput === undefined
    ? "not_recorded" as const
    : "verified" as const;
  let media: EncodeOutputMediaInspection | null = null;
  try {
    media = await mediaProbe(outputPath);
  } catch {
    // The post-probe stat below still has to prove the file stayed stable.
  }

  let after: Stats;
  try {
    after = await lstat(outputPath);
  } catch {
    return fileUnavailable(
      base,
      "OUTPUT_CHANGED_DURING_INSPECTION",
      "The Encode Output changed while it was being inspected.",
    );
  }
  if (!sameEncodeOutputMutationSnapshot(before, after)) {
    return fileUnavailable(
      base,
      "OUTPUT_CHANGED_DURING_INSPECTION",
      "The Encode Output changed while it was being inspected.",
    );
  }

  if (media === null) {
    return inspectionResponse(
      base,
      {
        status: "available",
        identity,
        sizeBytes: before.size,
        modifiedAt: before.mtime.toISOString(),
        completeness: "complete",
        identityContinuity,
      },
      "unknown",
      null,
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
      sizeBytes: before.size,
      modifiedAt: before.mtime.toISOString(),
      completeness: "complete",
      identityContinuity,
    },
    "passed",
    identityContinuity === "verified" ? true : null,
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

export type EncodeOutputInspection = Awaited<
  ReturnType<typeof inspectEncodeOutput>
>;
