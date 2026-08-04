import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  opendirSync,
  openSync,
  realpathSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { Worker } from "node:worker_threads";

import type { LegacySidecarImportIssue } from "../legacy-sidecar-types.js";
import type { MediaItemKind } from "../types.js";
import {
  createLegacyJobLogicalKey,
  legacyJobLogicalKey,
  legacyJobSignature,
  parseLegacyJobLogicalKey,
  type LegacyJobLogicalKey,
} from "./legacy-sidecar-identity.js";
import { isPathWithinDirectory } from "./path-containment.js";
import {
  LEGACY_QUEUE_CUTOVER_PROTOCOL_ARGUMENT,
  LEGACY_QUEUE_CUTOVER_PROTOCOL,
  LEGACY_QUEUE_CUTOVER_WORKER,
} from "./legacy-queue-cutover-protocol.js";

const DEFAULT_HANDBRAKE_PRESET = "Fast 480p30";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_LEGACY_SIDECAR_BYTES = 1_048_576;
const MAX_LEGACY_SIDECAR_JOBS = 100;
const MAX_LEGACY_IMPORT_BYTES = 8_388_608;
const MAX_LEGACY_SCAN_BYTES = 67_108_864;
const MAX_LEGACY_IMPORT_JOBS = 1_000;
const MAX_LEGACY_MARKER_BYTES = 8_388_608;
const LEGACY_QUEUE_STATUS_REPAIR = "repair";
const LEGACY_QUEUE_STATUS_RETIRED = "retired";
const LEGACY_MARKER_PREFIX =
  '{"schemaVersion":4,"legacyQueueStatus":"retired","authoritativeStore":"sqlite","legacySidecars":';
const LEGACY_MARKER_FIXED_BYTES = Buffer.byteLength(
  `${LEGACY_MARKER_PREFIX}[],"legacyJobs":[],"snapshotDigest":"${"0".repeat(64)}"}\n`,
  "utf8",
);
const MAX_LEGACY_LIBRARY_DEPTH = 32;
const MAX_LEGACY_LIBRARY_ENTRIES = 10_000;
const LEGACY_QUEUE_CUTOVER_MARKER = ".rip-dvd-sqlite-catalog";
const LEGACY_QUEUE_LOCK_POLL_MS = 10;
const LEGACY_QUEUE_WORKER_STALL_MS = 2_000;
const LEGACY_QUEUE_RELEASE_ACKNOWLEDGEMENT_MS = 1_000;
const LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS = 250;
const LEGACY_QUEUE_HELPER_STATE = LEGACY_QUEUE_CUTOVER_PROTOCOL.states;
const LEGACY_QUEUE_HELPER_STATE_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.state;
const LEGACY_QUEUE_HELPER_RELEASE_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.release;
const LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.indexes.heartbeat;
const LEGACY_QUEUE_SUPERVISOR_ABORT =
  LEGACY_QUEUE_CUTOVER_PROTOCOL.sentinels.abort;

export interface ParsedLegacyJob {
  completedAt: Date | null;
  jobIndex: number;
  kind: "main_feature" | "dvd_title";
  label: string;
  mediaItemKind: Extract<MediaItemKind, "movie" | "bonus_feature">;
  mediaTitle: string;
  outputPath: string;
  preset: string;
  profileKey: string;
  sourceKey: string;
  titleNumber: number | null;
}

export interface ParsedLegacySidecar {
  archivePath: string;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  archiveSizeBytes: number;
  archivedAt: Date;
  createdAt: Date;
  fingerprint: string;
  issues: LegacySidecarImportIssue[];
  jobs: ParsedLegacyJob[];
  movieTitle: string;
  movieYear: number | null;
  pathBase: string;
  scanData: unknown;
  sidecarPath: string;
  sourceBytes: number;
  updatedAt: Date;
}

export type LegacySidecarDiscovery =
  | { outcome: "parsed"; sidecar: ParsedLegacySidecar }
  | {
      outcome: "skipped";
      issue: LegacySidecarImportIssue;
      sourceBytes: number;
    };

export interface LegacySidecarDiscoveryBatch {
  complete: boolean;
  discoveries: LegacySidecarDiscovery[];
  scanIssues: LegacySidecarImportIssue[];
  sidecarsFound: number;
  sidecarPaths: string[];
}

interface LegacyQueueCutoverBase {
  jobSnapshots: ReadonlyMap<LegacyJobLogicalKey, LegacyQueueJobSnapshot>;
  recoveryDiscoveries: LegacySidecarDiscovery[] | null;
  recoveryIssues: LegacySidecarImportIssue[];
  sidecarSnapshots: readonly LegacyQueueSidecarSnapshot[];
  withdrawPublication(): void;
  wasAlreadyPublished: boolean;
}

export type LegacyQueueCutover = LegacyQueueCutoverBase &
  (
    | {
        mode: "schema-one";
        upgradeSchemaOne(
          jobSnapshots: ReadonlyMap<
            LegacyJobLogicalKey,
            LegacyQueueJobSnapshot
          >,
        ): void;
      }
    | { mode: "historical-snapshot" | "snapshot" }
  );

export interface LegacyQueueJobSnapshot {
  jobIndex: number;
  sidecarPath: string;
  signature: string;
}

export interface LegacyQueueSidecarSnapshot {
  archivePath: string;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  fingerprint: string;
  pathBase: string;
  payload: LegacyQueueSidecarPayloadSnapshot;
  sidecarPath: string;
}

interface LegacyQueueSidecarPayloadSnapshot {
  archivedAt: string;
  archiveSizeBytes: number;
  createdAt: string;
  issues: LegacySidecarImportIssue[];
  jobs: Array<Omit<ParsedLegacyJob, "completedAt"> & {
    completedAt: string | null;
  }>;
  movieTitle: string;
  movieYear: number | null;
  scanData: unknown;
  sourceBytes: number;
  updatedAt: string;
}

export interface LegacySourceArchiveSnapshot {
  changedAtNanoseconds: string;
  deviceId: string;
  inode: string;
  modifiedAtNanoseconds: string;
  sizeBytes: string;
}

function snapshotLegacySidecar(
  sidecar: ParsedLegacySidecar,
): LegacyQueueSidecarSnapshot {
  return {
    archivePath: sidecar.archivePath,
    archiveSnapshot: sidecar.archiveSnapshot,
    fingerprint: sidecar.fingerprint,
    pathBase: sidecar.pathBase,
    payload: {
      archivedAt: sidecar.archivedAt.toISOString(),
      archiveSizeBytes: sidecar.archiveSizeBytes,
      createdAt: sidecar.createdAt.toISOString(),
      issues: sidecar.issues,
      jobs: sidecar.jobs.map((job) => ({
        ...job,
        completedAt: job.completedAt?.toISOString() ?? null,
      })),
      movieTitle: sidecar.movieTitle,
      movieYear: sidecar.movieYear,
      scanData: sidecar.scanData,
      sourceBytes: sidecar.sourceBytes,
      updatedAt: sidecar.updatedAt.toISOString(),
    },
    sidecarPath: sidecar.sidecarPath,
  };
}

function snapshotSourceArchive(
  archivePath: string,
): {
  archivedAt: Date;
  archiveSizeBytes: number;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  isFile: boolean;
} {
  let descriptor: number | undefined;
  let primaryError: unknown;
  try {
    descriptor = openSync(archivePath, "r");
    const openedStat = fstatSync(descriptor, { bigint: true });
    const namedStat = statSync(archivePath, { bigint: true });
    if (
      openedStat.dev !== namedStat.dev ||
      openedStat.ino !== namedStat.ino
    ) {
      throw new Error("Source archive changed while it was being captured");
    }
    return {
      archivedAt: new Date(Number(openedStat.mtimeNs / 1_000_000n)),
      archiveSizeBytes: Number(openedStat.size),
      archiveSnapshot: {
        changedAtNanoseconds: openedStat.ctimeNs.toString(),
        deviceId: openedStat.dev.toString(),
        inode: openedStat.ino.toString(),
        modifiedAtNanoseconds: openedStat.mtimeNs.toString(),
        sizeBytes: openedStat.size.toString(),
      },
      isFile: openedStat.isFile(),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (primaryError === undefined) {
          throw error;
        }
      }
    }
  }
}

function sourceArchiveSnapshotsMatch(
  left: LegacySourceArchiveSnapshot,
  right: LegacySourceArchiveSnapshot,
): boolean {
  return (
    left.changedAtNanoseconds === right.changedAtNanoseconds &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.sizeBytes === right.sizeBytes
  );
}

export function legacySourceArchiveMatchesSnapshot(
  originalsLibraryPath: string,
  sidecar: Pick<
    ParsedLegacySidecar,
    "archivePath" | "archiveSnapshot" | "archiveSizeBytes"
  >,
): boolean {
  try {
    const canonicalArchivePath = realpathSync(sidecar.archivePath);
    if (
      canonicalArchivePath !== normalize(sidecar.archivePath) ||
      !isPathWithinDirectory(originalsLibraryPath, canonicalArchivePath)
    ) {
      return false;
    }
    const current = snapshotSourceArchive(canonicalArchivePath);
    return (
      current.isFile &&
      current.archiveSizeBytes === sidecar.archiveSizeBytes &&
      sourceArchiveSnapshotsMatch(
        current.archiveSnapshot,
        sidecar.archiveSnapshot,
      )
    );
  } catch {
    return false;
  }
}

export function resolveLegacyOriginalsLibrary(path: string): string {
  const resolvedPath = isAbsolute(path)
    ? normalize(path)
    : resolve(path);
  let canonicalPath;
  let libraryStat;
  try {
    canonicalPath = realpathSync(resolvedPath);
    libraryStat = statSync(canonicalPath);
    opendirSync(canonicalPath).closeSync();
  } catch (error) {
    throw new Error(
      `Originals library does not exist or is not readable: ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!libraryStat.isDirectory()) {
    throw new Error(`Originals library is not a directory: ${resolvedPath}`);
  }
  return canonicalPath;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeDecimalString(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
    ? value
    : null;
}

function parseSourceArchiveSnapshot(
  value: unknown,
): LegacySourceArchiveSnapshot | null {
  const snapshot = objectValue(value);
  if (!snapshot) {
    return null;
  }
  const changedAtNanoseconds = nonNegativeDecimalString(
    snapshot.changedAtNanoseconds,
  );
  const deviceId = nonNegativeDecimalString(snapshot.deviceId);
  const inode = nonNegativeDecimalString(snapshot.inode);
  const modifiedAtNanoseconds = nonNegativeDecimalString(
    snapshot.modifiedAtNanoseconds,
  );
  const sizeBytes = nonNegativeDecimalString(snapshot.sizeBytes);
  return changedAtNanoseconds &&
    deviceId &&
    inode &&
    modifiedAtNanoseconds &&
    sizeBytes
    ? {
        changedAtNanoseconds,
        deviceId,
        inode,
        modifiedAtNanoseconds,
        sizeBytes,
      }
    : null;
}

function legacyInteger(value: unknown, defaultValue?: number): number | null {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function positiveInteger(value: unknown): number | null {
  const integer = legacyInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

function optionalYear(value: unknown): number | null {
  const year = positiveInteger(value);
  return year !== null && year >= 1800 && year <= 9999 ? year : null;
}

function recordedDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const integer = legacyInteger(value);
  return integer !== null && integer >= 0 ? integer : null;
}

function isValidPublishedJob(
  logicalKey: string,
  signature: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return false;
  }
  const job = objectValue(parsed);
  if (!job || JSON.stringify(job) !== signature) {
    return false;
  }
  const expectedFields = [
    "kind",
    "label",
    "mediaItemKind",
    "mediaTitle",
    "outputPath",
    "preset",
    "profileKey",
    "sourceKey",
    "titleNumber",
  ];
  const fields = Object.keys(job);
  if (
    fields.length !== expectedFields.length ||
    expectedFields.some((field, index) => fields[index] !== field)
  ) {
    return false;
  }
  const sourceKey = nonEmptyString(job.sourceKey);
  const profile = nonEmptyString(job.profileKey);
  const titleNumber =
    job.titleNumber === null ? null : positiveInteger(job.titleNumber);
  if (
    (job.kind !== "main_feature" && job.kind !== "dvd_title") ||
    (job.mediaItemKind !== "movie" &&
      job.mediaItemKind !== "bonus_feature") ||
    !nonEmptyString(job.label) ||
    !nonEmptyString(job.mediaTitle) ||
    !nonEmptyString(job.outputPath) ||
    !nonEmptyString(job.preset) ||
    !sourceKey ||
    !profile ||
    (job.titleNumber !== null && titleNumber === null) ||
    (job.kind === "main_feature" &&
      (titleNumber !== null || sourceKey !== "dvd:main-feature")) ||
    (job.kind === "dvd_title" &&
      (titleNumber === null || sourceKey !== `dvd:title:${titleNumber}`))
  ) {
    return false;
  }
  const identity = parseLegacyJobLogicalKey(logicalKey);
  return (
    identity !== null &&
    identity.sourceKey === sourceKey &&
    identity.profileKey === profile
  );
}

function canonicalRecordedDate(value: unknown): string | null {
  const date = recordedDate(value);
  return date && date.toISOString() === value ? value : null;
}

function parseSnapshotIssue(
  value: unknown,
  sidecarPath: string,
): LegacySidecarImportIssue | null {
  const issue = objectValue(value);
  const code = issue?.code;
  const jobIndex = issue?.jobIndex;
  if (
    !issue ||
    (code !== "corrupt_sidecar" &&
      code !== "invalid_sidecar" &&
      code !== "missing_archive" &&
      code !== "invalid_job" &&
      code !== "duplicate_record") ||
    issue.sidecarPath !== sidecarPath ||
    !nonEmptyString(issue.message) ||
    (jobIndex !== undefined && nonNegativeInteger(jobIndex) === null)
  ) {
    return null;
  }
  return {
    code,
    ...(jobIndex === undefined ? {} : { jobIndex: Number(jobIndex) }),
    message: issue.message as string,
    sidecarPath,
  };
}

function parseSnapshotJob(
  value: unknown,
  fingerprint: string,
): LegacyQueueSidecarPayloadSnapshot["jobs"][number] | null {
  const job = objectValue(value);
  if (!job) {
    return null;
  }
  const completedAt =
    job.completedAt === null ? null : canonicalRecordedDate(job.completedAt);
  const jobIndex = nonNegativeInteger(job.jobIndex);
  const titleNumber =
    job.titleNumber === null ? null : positiveInteger(job.titleNumber);
  if (
    (job.completedAt !== null && !completedAt) ||
    jobIndex === null ||
    (job.kind !== "main_feature" && job.kind !== "dvd_title") ||
    !nonEmptyString(job.label) ||
    (job.mediaItemKind !== "movie" &&
      job.mediaItemKind !== "bonus_feature") ||
    !nonEmptyString(job.mediaTitle) ||
    !nonEmptyString(job.outputPath) ||
    !isAbsolute(job.outputPath as string) ||
    !nonEmptyString(job.preset) ||
    !nonEmptyString(job.profileKey) ||
    !nonEmptyString(job.sourceKey) ||
    (job.titleNumber !== null && titleNumber === null)
  ) {
    return null;
  }
  const parsedJob: ParsedLegacyJob = {
    completedAt: completedAt ? new Date(completedAt) : null,
    jobIndex,
    kind: job.kind,
    label: job.label as string,
    mediaItemKind: job.mediaItemKind,
    mediaTitle: job.mediaTitle as string,
    outputPath: job.outputPath as string,
    preset: job.preset as string,
    profileKey: job.profileKey as string,
    sourceKey: job.sourceKey as string,
    titleNumber,
  };
  let logicalKey: LegacyJobLogicalKey;
  try {
    logicalKey = legacyJobLogicalKey(fingerprint, parsedJob);
  } catch {
    return null;
  }
  if (!isValidPublishedJob(logicalKey, legacyJobSignature(parsedJob))) {
    return null;
  }
  return {
    ...parsedJob,
    completedAt,
  };
}

function parseSidecarPayloadSnapshot(
  value: unknown,
  fingerprint: string,
  sidecarPath: string,
): LegacyQueueSidecarPayloadSnapshot | null {
  const payload = objectValue(value);
  if (!payload || !Array.isArray(payload.jobs) || !Array.isArray(payload.issues)) {
    return null;
  }
  const archivedAt = canonicalRecordedDate(payload.archivedAt);
  const archiveSizeBytes = nonNegativeInteger(payload.archiveSizeBytes);
  const createdAt = canonicalRecordedDate(payload.createdAt);
  const movieTitle = nonEmptyString(payload.movieTitle);
  const movieYear =
    payload.movieYear === null ? null : optionalYear(payload.movieYear);
  const sourceBytes = nonNegativeInteger(payload.sourceBytes);
  const updatedAt = canonicalRecordedDate(payload.updatedAt);
  const jobs = payload.jobs.map((job) =>
    parseSnapshotJob(job, fingerprint),
  );
  const issues = payload.issues.map((issue) =>
    parseSnapshotIssue(issue, sidecarPath),
  );
  if (
    !archivedAt ||
    archiveSizeBytes === null ||
    !createdAt ||
    !movieTitle ||
    (payload.movieYear !== null && movieYear === null) ||
    sourceBytes === null ||
    sourceBytes > MAX_LEGACY_SIDECAR_BYTES ||
    !updatedAt ||
    payload.jobs.length > MAX_LEGACY_SIDECAR_JOBS ||
    jobs.some((job) => job === null) ||
    issues.some((issue) => issue === null) ||
    new Date(updatedAt) < new Date(createdAt)
  ) {
    return null;
  }
  return {
    archivedAt,
    archiveSizeBytes,
    createdAt,
    issues: issues as LegacySidecarImportIssue[],
    jobs: jobs as LegacyQueueSidecarPayloadSnapshot["jobs"],
    movieTitle,
    movieYear,
    scanData: payload.scanData,
    sourceBytes,
    updatedAt,
  };
}

function restorePublishedSidecar(
  snapshot: LegacyQueueSidecarSnapshot,
): ParsedLegacySidecar {
  return {
    archivePath: snapshot.archivePath,
    archiveSnapshot: snapshot.archiveSnapshot,
    archiveSizeBytes: snapshot.payload.archiveSizeBytes,
    archivedAt: new Date(snapshot.payload.archivedAt),
    createdAt: new Date(snapshot.payload.createdAt),
    fingerprint: snapshot.fingerprint,
    issues: snapshot.payload.issues,
    jobs: snapshot.payload.jobs.map((job) => ({
      ...job,
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
    })),
    movieTitle: snapshot.payload.movieTitle,
    movieYear: snapshot.payload.movieYear,
    pathBase: snapshot.pathBase,
    scanData: snapshot.payload.scanData,
    sidecarPath: snapshot.sidecarPath,
    sourceBytes: snapshot.payload.sourceBytes,
    updatedAt: new Date(snapshot.payload.updatedAt),
  };
}

type RecordedPathResolution =
  | { outcome: "resolved"; path: string }
  | { outcome: "ambiguous"; message: string };

function resolveRecordedPath(
  path: string,
  sidecarPath: string,
  pathBase = process.cwd(),
): RecordedPathResolution {
  if (isAbsolute(path)) {
    return { outcome: "resolved", path: normalize(path) };
  }
  const candidates = [
    resolve(pathBase, path),
    resolve(sidecarPath, "..", path),
  ].filter((candidate, index, paths) => paths.indexOf(candidate) === index);
  const existingCandidates = candidates.filter((candidate) =>
    existsSync(candidate),
  );
  if (existingCandidates.length > 1) {
    return {
      outcome: "ambiguous",
      message: `Recorded path is ambiguous between: ${existingCandidates.join(
        ", ",
      )}`,
    };
  }
  return {
    outcome: "resolved",
    path: existingCandidates[0] ?? candidates[0]!,
  };
}

function profileKey(preset: string): string {
  const slug = preset
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(preset).digest("hex").slice(0, 12);
  return `legacy-handbrake-${slug || "preset"}-${digest}`;
}

function derivedFingerprint(data: Record<string, unknown>): string | null {
  if (
    !("disc_title" in data) ||
    !Array.isArray(data.titles) ||
    data.titles.length === 0
  ) {
    return null;
  }
  const discTitle = String(data.disc_title ?? "").trim();
  const titles = data.titles.map((value) => {
    const title = objectValue(value);
    const number = legacyInteger(title?.number);
    if (!title || number === null) {
      return null;
    }
    const integer = (field: string) => {
      return legacyInteger(title[field], 0);
    };
    const identity = {
      audio_streams: integer("audio_streams"),
      chapters: integer("chapters"),
      number,
      seconds: integer("seconds"),
      subtitles: integer("subtitles"),
    };
    return Object.values(identity).some((item) => item === null)
      ? null
      : identity;
  });
  if (titles.some((title) => title === null)) {
    return null;
  }
  titles.sort((left, right) => (left?.number ?? 0) - (right?.number ?? 0));
  return createHash("sha256")
    .update(JSON.stringify({ disc_title: discTitle, titles }))
    .digest("hex");
}

function parseJob(
  value: unknown,
  index: number,
  sidecarPath: string,
  archivePath: string,
  movieTitle: string,
  pathBase: string,
): ParsedLegacyJob | LegacySidecarImportIssue {
  const job = objectValue(value);
  const invalid = (message: string): LegacySidecarImportIssue => ({
    code: "invalid_job",
    jobIndex: index,
    message,
    sidecarPath,
  });
  if (!job) {
    return invalid("Encode job must be an object");
  }
  for (const field of ["source", "selection", "label", "preset"] as const) {
    if (field in job && typeof job[field] !== "string") {
      return invalid(`Encode job ${field} must be a string when provided`);
    }
  }
  const output = nonEmptyString(job.output);
  if (!output) {
    return invalid("Encode job output must be a non-empty path");
  }
  const outputResolution = resolveRecordedPath(output, sidecarPath, pathBase);
  if (outputResolution.outcome === "ambiguous") {
    return invalid(outputResolution.message);
  }
  const outputPath = outputResolution.path;
  const jobSource = nonEmptyString(job.source);
  if (jobSource) {
    const sourceResolution = resolveRecordedPath(
      jobSource,
      sidecarPath,
      pathBase,
    );
    if (sourceResolution.outcome === "ambiguous") {
      return invalid(sourceResolution.message);
    }
    let canonicalJobSource: string;
    try {
      canonicalJobSource = realpathSync(sourceResolution.path);
    } catch {
      return invalid("Encode job source does not match the sidecar archive");
    }
    if (canonicalJobSource !== archivePath) {
      return invalid("Encode job source does not match the sidecar archive");
    }
  }
  if (!("title_number" in job)) {
    return invalid("Encode job must include title_number");
  }
  const titleNumber =
    job.title_number === null ? null : positiveInteger(job.title_number);
  if (job.title_number !== null && titleNumber === null) {
    return invalid("Encode job title_number must be null or a positive integer");
  }
  const selection = nonEmptyString(job.selection);
  if (
    (titleNumber === null && selection !== "main_feature") ||
    (titleNumber !== null && selection !== null && selection !== "title")
  ) {
    return invalid("Encode job selection does not match title_number");
  }
  const label =
    nonEmptyString(job.label) ?? outputPath.split("/").at(-1) ?? outputPath;
  const isMovie = titleNumber === null || /^movie\s*:/i.test(label);
  const mediaTitle = isMovie
    ? movieTitle
    : label.replace(/^extra\s+\d+\s*:\s*/i, "").trim() || label;
  const preset = nonEmptyString(job.preset) ?? DEFAULT_HANDBRAKE_PRESET;
  let completedAt: Date | null = null;
  try {
    const outputStat = statSync(outputPath);
    completedAt = outputStat.isFile() ? outputStat.mtime : null;
  } catch {
    completedAt = null;
  }
  return {
    completedAt,
    jobIndex: index,
    kind: titleNumber === null ? "main_feature" : "dvd_title",
    label,
    mediaItemKind: isMovie ? "movie" : "bonus_feature",
    mediaTitle,
    outputPath,
    preset,
    profileKey: profileKey(preset),
    sourceKey:
      titleNumber === null ? "dvd:main-feature" : `dvd:title:${titleNumber}`,
    titleNumber,
  };
}

interface SidecarParseContext {
  originalsLibraryPath: string;
  snapshot?: LegacyQueueSidecarSnapshot;
}

function parseSidecar(
  sidecarPath: string,
  context: SidecarParseContext,
): LegacySidecarDiscovery {
  let contents = "";
  let sourceBytes = 0;
  let descriptor: number | undefined;
  let readIssue: LegacySidecarDiscovery | undefined;
  try {
    descriptor = openSync(sidecarPath, "r");
    if (context.snapshot) {
      const openedStat = fstatSync(descriptor);
      const openedPath = realpathSync(sidecarPath);
      const namedStat = statSync(openedPath);
      if (
        openedPath !== normalize(sidecarPath) ||
        !isPathWithinDirectory(context.originalsLibraryPath, openedPath) ||
        openedStat.dev !== namedStat.dev ||
        openedStat.ino !== namedStat.ino
      ) {
        readIssue = {
          outcome: "skipped",
          sourceBytes,
          issue: {
            code: "invalid_sidecar",
            message:
              "Captured sidecar is outside the originals library or reached through an ancestor symlink",
            sidecarPath,
          },
        };
      }
    }
    const sidecarSize = fstatSync(descriptor).size;
    if (!readIssue && sidecarSize > MAX_LEGACY_SIDECAR_BYTES) {
      sourceBytes = sidecarSize;
      readIssue = {
        outcome: "skipped",
        sourceBytes,
        issue: {
          code: "invalid_sidecar",
          message: `Sidecar exceeds the ${MAX_LEGACY_SIDECAR_BYTES}-byte limit`,
          sidecarPath,
        },
      };
    } else if (!readIssue) {
      const buffer = Buffer.alloc(MAX_LEGACY_SIDECAR_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          null,
        );
        if (count === 0) {
          break;
        }
        bytesRead += count;
        sourceBytes = bytesRead;
      }
      if (bytesRead > MAX_LEGACY_SIDECAR_BYTES) {
        readIssue = {
          outcome: "skipped",
          sourceBytes,
          issue: {
            code: "invalid_sidecar",
            message: `Sidecar exceeds the ${MAX_LEGACY_SIDECAR_BYTES}-byte limit`,
            sidecarPath,
          },
        };
      } else {
        sourceBytes = bytesRead;
        contents = UTF8_DECODER.decode(buffer.subarray(0, bytesRead));
      }
    }
  } catch (error) {
    readIssue ??= {
      outcome: "skipped",
      sourceBytes,
      issue: {
        code: "corrupt_sidecar",
        message: `Could not read JSON: ${error instanceof Error ? error.message : String(error)}`,
        sidecarPath,
      },
    };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        readIssue ??= {
          outcome: "skipped",
          sourceBytes,
          issue: {
            code: "corrupt_sidecar",
            message: `Could not close JSON: ${error instanceof Error ? error.message : String(error)}`,
            sidecarPath,
          },
        };
      }
    }
  }
  if (readIssue) {
    return readIssue;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return {
      outcome: "skipped",
      sourceBytes,
      issue: {
        code: "corrupt_sidecar",
        message: `Could not read JSON: ${error instanceof Error ? error.message : String(error)}`,
        sidecarPath,
      },
    };
  }
  const data = objectValue(parsed);
  const invalid = (message: string): LegacySidecarDiscovery => ({
    outcome: "skipped",
    sourceBytes,
    issue: { code: "invalid_sidecar", message, sidecarPath },
  });
  if (!data) {
    return invalid("Top-level sidecar value must be an object");
  }
  const schemaVersion =
    "schema_version" in data ? data.schema_version : 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return invalid("Only legacy sidecar schema versions 1 and 2 are supported");
  }
  const archiveStatus =
    "archive_status" in data ? data.archive_status : "ready";
  if (typeof archiveStatus !== "string") {
    return invalid("Sidecar archive_status must be a string when provided");
  }
  if (archiveStatus !== "ready") {
    return invalid("Original Disc Archive is not marked ready");
  }
  for (const field of [
    "movie_dir",
    "title",
    "disc_hint",
    "disc_title",
  ] as const) {
    if (field in data && typeof data[field] !== "string") {
      return invalid(`Sidecar ${field} must be a string when provided`);
    }
  }
  if ("title" in data && !nonEmptyString(data.title)) {
    return invalid("Sidecar title must be non-empty when provided");
  }
  if (
    "year" in data &&
    data.year !== null &&
    data.year !== "" &&
    optionalYear(data.year) === null
  ) {
    return invalid("Sidecar year must be a valid year when provided");
  }
  const createdAt =
    "created_at" in data ? recordedDate(data.created_at) : null;
  if ("created_at" in data && !createdAt) {
    return invalid("Sidecar created_at must be a valid date when provided");
  }
  const updatedAt =
    "updated_at" in data ? recordedDate(data.updated_at) : null;
  if ("updated_at" in data && !updatedAt) {
    return invalid("Sidecar updated_at must be a valid date when provided");
  }
  if (createdAt && updatedAt && updatedAt < createdAt) {
    return invalid("Sidecar updated_at must not be earlier than created_at");
  }
  if (
    "disc_fingerprint" in data &&
    data.disc_fingerprint !== null &&
    typeof data.disc_fingerprint !== "string"
  ) {
    return invalid(
      "Sidecar disc_fingerprint must be a string or null when provided",
    );
  }
  const rawTitles = "titles" in data ? data.titles : [];
  if (!Array.isArray(rawTitles)) {
    return invalid("Sidecar titles must be an array when provided");
  }
  for (const [index, value] of rawTitles.entries()) {
    const title = objectValue(value);
    if (!title || positiveInteger(title.number) === null) {
      return invalid(`Sidecar title ${index} must have a positive number`);
    }
    if (
      "duration_text" in title &&
      typeof title.duration_text !== "string"
    ) {
      return invalid(`Sidecar title ${index} duration_text must be a string`);
    }
    for (const field of [
      "seconds",
      "chapters",
      "audio_streams",
      "subtitles",
    ] as const) {
      if (field in title && nonNegativeInteger(title[field]) === null) {
        return invalid(
          `Sidecar title ${index} ${field} must be a non-negative integer`,
        );
      }
    }
  }
  const source = nonEmptyString(data.source);
  if (!source) {
    return invalid("Sidecar source must be a non-empty archive path");
  }
  const pathBase = context.snapshot?.pathBase ?? process.cwd();
  const archiveResolution = resolveRecordedPath(
    source,
    sidecarPath,
    pathBase,
  );
  if (archiveResolution.outcome === "ambiguous") {
    return invalid(archiveResolution.message);
  }
  const recordedArchivePath = archiveResolution.path;
  let archivePath: string;
  try {
    archivePath = realpathSync(recordedArchivePath);
  } catch {
    return {
      outcome: "skipped",
      sourceBytes,
      issue: {
        code: "missing_archive",
        message: `Original Disc Archive is missing: ${recordedArchivePath}`,
        sidecarPath,
      },
    };
  }
  if (
    !isPathWithinDirectory(context.originalsLibraryPath, archivePath)
  ) {
    return invalid(
      "Source archive is outside the originals library or reached through an ancestor symlink",
    );
  }
  let archiveMetadata;
  try {
    archiveMetadata = snapshotSourceArchive(archivePath);
  } catch {
    return {
      outcome: "skipped",
      sourceBytes,
      issue: {
        code: "missing_archive",
        message: `Original Disc Archive is missing: ${archivePath}`,
        sidecarPath,
      },
    };
  }
  if (!archiveMetadata.isFile) {
    return invalid(`Original Disc Archive is not a file: ${archivePath}`);
  }
  const fingerprint =
    nonEmptyString(data.disc_fingerprint) ?? derivedFingerprint(data);
  if (!fingerprint) {
    return invalid(
      "Sidecar has neither a fingerprint nor a valid DVD title map",
    );
  }
  if (fingerprint.includes("\0")) {
    return invalid("Sidecar disc_fingerprint contains an invalid delimiter");
  }
  if (!Array.isArray(data.jobs)) {
    return invalid("Sidecar jobs must be an array");
  }
  if (data.jobs.length > MAX_LEGACY_SIDECAR_JOBS) {
    return invalid(
      `Sidecar jobs exceed the ${MAX_LEGACY_SIDECAR_JOBS}-job limit`,
    );
  }
  const movieTitle =
    nonEmptyString(data.title) ??
    archivePath.split("/").at(-1)?.replace(/\.iso$/i, "") ??
    "Imported DVD";
  const parsedJobs: ParsedLegacyJob[] = [];
  const issues: LegacySidecarImportIssue[] = [];
  data.jobs.forEach((value, index) => {
    const result = parseJob(
      value,
      index,
      sidecarPath,
      archivePath,
      movieTitle,
      pathBase,
    );
    if ("code" in result) {
      issues.push(result);
    } else {
      parsedJobs.push(result);
    }
  });
  const jobs: ParsedLegacyJob[] = [];
  const outputPaths = new Set<string>();
  const logicalJobs = new Set<string>();
  for (const job of parsedJobs) {
    const logicalKey = JSON.stringify([job.sourceKey, job.profileKey]);
    if (outputPaths.has(job.outputPath) || logicalJobs.has(logicalKey)) {
      issues.push({
        code: "duplicate_record",
        jobIndex: job.jobIndex,
        message:
          "Encode job duplicates an earlier output or selection/profile mapping",
        sidecarPath,
      });
      continue;
    }
    outputPaths.add(job.outputPath);
    logicalJobs.add(logicalKey);
    jobs.push(job);
  }
  const parsedSidecar: ParsedLegacySidecar = {
    archivePath,
    archiveSnapshot: archiveMetadata.archiveSnapshot,
    archiveSizeBytes: archiveMetadata.archiveSizeBytes,
    archivedAt: updatedAt ?? archiveMetadata.archivedAt,
    createdAt: createdAt ?? archiveMetadata.archivedAt,
    fingerprint,
    issues,
    jobs,
    movieTitle,
    movieYear: optionalYear(data.year),
    pathBase,
    scanData: {
      discTitle: data.disc_title ?? null,
      legacySchemaVersion: schemaVersion,
      titles: data.titles ?? [],
    },
    sidecarPath,
    sourceBytes,
    updatedAt: updatedAt ?? archiveMetadata.archivedAt,
  };
  if (
    context.snapshot &&
    (archivePath !== context.snapshot.archivePath ||
      fingerprint !== context.snapshot.fingerprint ||
      !sourceArchiveSnapshotsMatch(
        archiveMetadata.archiveSnapshot,
        context.snapshot.archiveSnapshot,
      ))
  ) {
    return {
      outcome: "skipped",
      sourceBytes,
      issue: {
        code: "duplicate_record",
        message:
          "Legacy sidecar conflicts with the source archive identity captured at SQLite cutover",
        sidecarPath,
      },
    };
  }
  return {
    outcome: "parsed",
    sidecar: parsedSidecar,
  };
}

interface LegacySidecarSearchState {
  complete: boolean;
  entriesVisited: number;
  issues: LegacySidecarImportIssue[];
  limitReached: boolean;
  paths: string[];
  rootPath: string;
}

function findSidecars(
  directory: string,
  depth = 0,
  state: LegacySidecarSearchState = {
    complete: true,
    entriesVisited: 0,
    issues: [],
    limitReached: false,
    paths: [],
    rootPath: directory,
  },
): LegacySidecarSearchState {
  const directoryHandle = opendirSync(directory);
  try {
    let entry;
    while (!state.limitReached && (entry = directoryHandle.readSync())) {
      state.entriesVisited += 1;
      if (state.entriesVisited > MAX_LEGACY_LIBRARY_ENTRIES) {
        state.complete = false;
        state.limitReached = true;
        state.issues.push({
          code: "invalid_sidecar",
          message: `Library traversal entries exceed the ${MAX_LEGACY_LIBRARY_ENTRIES}-entry limit`,
          sidecarPath: state.rootPath,
        });
        break;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_LEGACY_LIBRARY_DEPTH) {
          state.complete = false;
          state.issues.push({
            code: "invalid_sidecar",
            message: `Library traversal depth exceeds the ${MAX_LEGACY_LIBRARY_DEPTH}-level limit`,
            sidecarPath: path,
          });
        } else {
          findSidecars(path, depth + 1, state);
        }
      } else if (entry.isFile() && entry.name.endsWith(".rip-dvd.json")) {
        state.paths.push(path);
      }
    }
  } finally {
    directoryHandle.closeSync();
  }
  return state;
}

export function discoverLegacySidecars(
  originalsLibraryPath: string,
): LegacySidecarDiscoveryBatch {
  const found = findSidecars(originalsLibraryPath);
  const discoveries: LegacySidecarDiscovery[] = [];
  let retainedBytes = 0;
  let scanBytes = 0;
  let totalJobs = 0;
  let totalMarkerBytes = LEGACY_MARKER_FIXED_BYTES;
  let totalMarkerJobs = 0;
  let totalMarkerSidecars = 0;
  for (const path of found.paths.sort()) {
    let discovery = parseSidecar(path, { originalsLibraryPath });
    let markerSnapshotBytes = 0;
    if (discovery.outcome === "parsed") {
      try {
        markerSnapshotBytes = Buffer.byteLength(
          JSON.stringify(snapshotLegacySidecar(discovery.sidecar)),
          "utf8",
        );
      } catch (error) {
        discovery = {
          outcome: "skipped",
          sourceBytes: discovery.sidecar.sourceBytes,
          issue: {
            code: "invalid_sidecar",
            message: `Sidecar cannot be serialized safely for the SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
            sidecarPath: discovery.sidecar.sidecarPath,
          },
        };
      }
    }
    discoveries.push(discovery);
    scanBytes +=
      discovery.outcome === "parsed"
        ? discovery.sidecar.sourceBytes
        : discovery.sourceBytes;
    if (discovery.outcome === "parsed") {
      retainedBytes += discovery.sidecar.sourceBytes;
      totalJobs += discovery.sidecar.jobs.length;
    }
    if (scanBytes > MAX_LEGACY_SCAN_BYTES) {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate sidecar scan work exceeds the ${MAX_LEGACY_SCAN_BYTES}-byte limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (retainedBytes > MAX_LEGACY_IMPORT_BYTES) {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate sidecar bytes exceed the ${MAX_LEGACY_IMPORT_BYTES}-byte import limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (totalJobs > MAX_LEGACY_IMPORT_JOBS) {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate legacy jobs exceed the ${MAX_LEGACY_IMPORT_JOBS}-job import limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (discovery.outcome === "parsed") {
      totalMarkerBytes +=
        markerSnapshotBytes + (totalMarkerSidecars === 0 ? 0 : 1);
      totalMarkerSidecars += 1;
      if (totalMarkerBytes > MAX_LEGACY_MARKER_BYTES) {
        found.complete = false;
        found.issues.push({
          code: "invalid_sidecar",
          message: `Aggregate cutover marker bytes exceed the ${MAX_LEGACY_MARKER_BYTES}-byte import limit`,
          sidecarPath: originalsLibraryPath,
        });
        break;
      }
      for (const job of discovery.sidecar.jobs) {
        totalMarkerBytes +=
          Buffer.byteLength(
            JSON.stringify({
              logicalKey: legacyJobLogicalKey(
                discovery.sidecar.fingerprint,
                job,
              ),
              jobIndex: job.jobIndex,
              sidecarPath: discovery.sidecar.sidecarPath,
              signature: legacyJobSignature(job),
            }),
            "utf8",
          ) + (totalMarkerJobs === 0 ? 0 : 1);
        totalMarkerJobs += 1;
        if (totalMarkerBytes > MAX_LEGACY_MARKER_BYTES) {
          found.complete = false;
          found.issues.push({
            code: "invalid_sidecar",
            message: `Aggregate cutover marker bytes exceed the ${MAX_LEGACY_MARKER_BYTES}-byte import limit`,
            sidecarPath: originalsLibraryPath,
          });
          break;
        }
      }
      if (!found.complete) {
        break;
      }
    }
  }
  return {
    complete: found.complete,
    discoveries,
    scanIssues: found.issues,
    sidecarsFound: found.paths.length,
    sidecarPaths: found.paths,
  };
}

export function acquireLegacyQueueCutoverLock(
  originalsLibraryPath: string,
): () => void {
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const repositoryRoot = realpathSync(
    resolve(dirname(modulePath), "..", "..", "..", ".."),
  );
  const expectedHelperPath = resolve(
    repositoryRoot,
    "rip_dvd",
    "legacy_queue_lease.py",
  );
  let helperPath: string;
  try {
    const expectedHelperStat = lstatSync(expectedHelperPath);
    helperPath = realpathSync(expectedHelperPath);
    if (
      !expectedHelperStat.isFile() ||
      expectedHelperStat.isSymbolicLink() ||
      !isPathWithinDirectory(repositoryRoot, helperPath)
    ) {
      throw new Error("helper is not a trusted regular file");
    }
  } catch (error) {
    throw new Error(
      `Could not locate the trusted legacy queue lease helper: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const python = process.env.RIP_DVD_PYTHON?.trim() || "python3";
  const pythonProbe = spawnSync(python, ["--version"], { stdio: "ignore" });
  if (pythonProbe.status !== 0) {
    throw new Error(`Could not run the legacy queue lease helper with ${python}`);
  }
  const stateDirectory = mkdtempSync(join(tmpdir(), "rip-dvd-cutover-"));
  const statePath = (name: string) => join(stateDirectory, name);
  const helperState = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(LEGACY_QUEUE_CUTOVER_WORKER, {
    eval: true,
    workerData: {
      helperPath,
      originalsLibraryPath,
      pollMs: LEGACY_QUEUE_LOCK_POLL_MS,
      protocol: LEGACY_QUEUE_CUTOVER_PROTOCOL,
      protocolArgument: LEGACY_QUEUE_CUTOVER_PROTOCOL_ARGUMENT,
      python,
      sharedState: helperState.buffer,
      stateDirectory,
      terminationGraceMs: LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS,
    },
  });
  let workerFailure: string | undefined;
  worker.on("error", (error) => {
    workerFailure = `Legacy queue lease worker failed: ${error.message}`;
  });
  worker.on("exit", (code) => {
    if (code !== 0 && !workerFailure) {
      workerFailure = `Legacy queue lease worker exited with code ${code}`;
    }
  });
  const helperFailure = () => {
    if (workerFailure) {
      return workerFailure;
    }
    for (const name of ["worker-error", "error"]) {
      if (existsSync(statePath(name))) {
        try {
          return readFileSync(statePath(name), "utf8");
        } catch (error) {
          return `Could not read the legacy queue lease failure record: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }
    return "Legacy queue lease helper terminated unexpectedly";
  };
  const waitPhase = (expectedState: number): string => {
    if (expectedState === LEGACY_QUEUE_HELPER_STATE.intentReady) {
      return "intent acquisition";
    }
    if (expectedState === LEGACY_QUEUE_HELPER_STATE.ready) {
      return "queue drain";
    }
    return "release acknowledgement";
  };
  const waitForState = (
    expectedState: number,
    maximumWaitMilliseconds?: number,
  ): void => {
    const phaseStartedAt = process.hrtime.bigint();
    let heartbeat = Atomics.load(
      helperState,
      LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX,
    );
    let heartbeatObservedAt = process.hrtime.bigint();
    while (true) {
      const state = Atomics.load(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
      );
      if (state === LEGACY_QUEUE_HELPER_STATE.failed) {
        throw new Error(helperFailure());
      }
      if (state >= expectedState) {
        return;
      }
      if (
        maximumWaitMilliseconds !== undefined &&
        Number(process.hrtime.bigint() - phaseStartedAt) / 1_000_000 >=
          maximumWaitMilliseconds
      ) {
        throw new Error(
          `Legacy queue lease helper did not complete ${waitPhase(expectedState)} within ${maximumWaitMilliseconds}ms`,
        );
      }
      const currentHeartbeat = Atomics.load(
        helperState,
        LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX,
      );
      if (currentHeartbeat !== heartbeat) {
        heartbeat = currentHeartbeat;
        heartbeatObservedAt = process.hrtime.bigint();
      } else {
        const stalledForMilliseconds = Number(
          process.hrtime.bigint() - heartbeatObservedAt,
        ) / 1_000_000;
        if (stalledForMilliseconds >= LEGACY_QUEUE_WORKER_STALL_MS) {
          throw new Error(
            `Legacy queue lease worker stopped responding during ${waitPhase(expectedState)}`,
          );
        }
      }
      Atomics.wait(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
        state,
        LEGACY_QUEUE_LOCK_POLL_MS,
      );
    }
  };
  const stopUnresponsiveWorker = (): boolean => {
    for (const name of ["release", LEGACY_QUEUE_SUPERVISOR_ABORT]) {
      if (existsSync(statePath(name))) {
        continue;
      }
      try {
        writeFileSync(statePath(name), "", { flag: "wx", mode: 0o600 });
      } catch {
        // The helper may have concurrently published or consumed the state.
      }
    }
    Atomics.store(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX, 1);
    Atomics.notify(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX);
    const deadline =
      process.hrtime.bigint() +
      BigInt(LEGACY_QUEUE_WORKER_STALL_MS) * 1_000_000n;
    while (
      !existsSync(statePath("released")) &&
      process.hrtime.bigint() < deadline
    ) {
      Atomics.wait(
        helperState,
        LEGACY_QUEUE_HELPER_STATE_INDEX,
        Atomics.load(helperState, LEGACY_QUEUE_HELPER_STATE_INDEX),
        LEGACY_QUEUE_LOCK_POLL_MS,
      );
    }
    const helperReleased = existsSync(statePath("released"));
    void worker.terminate();
    return helperReleased;
  };
  const cleanUpUnresponsiveWorker = (): void => {
    const helperReleased = stopUnresponsiveWorker();
    if (helperReleased) {
      rmSync(stateDirectory, { force: true, recursive: true });
      return;
    }
    const cleanupTimer = setInterval(() => {
      if (!existsSync(statePath("released"))) {
        return;
      }
      clearInterval(cleanupTimer);
      rmSync(stateDirectory, { force: true, recursive: true });
    }, LEGACY_QUEUE_LOCK_POLL_MS);
    cleanupTimer.unref();
  };
  const cleanUpResponsiveWorker = (): void => {
    void worker.terminate();
    rmSync(stateDirectory, { force: true, recursive: true });
  };

  try {
    waitForState(LEGACY_QUEUE_HELPER_STATE.intentReady);
    waitForState(LEGACY_QUEUE_HELPER_STATE.ready);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      Atomics.store(
        helperState,
        LEGACY_QUEUE_HELPER_RELEASE_INDEX,
        1,
      );
      Atomics.notify(helperState, LEGACY_QUEUE_HELPER_RELEASE_INDEX);
      try {
        waitForState(
          LEGACY_QUEUE_HELPER_STATE.released,
          LEGACY_QUEUE_RELEASE_ACKNOWLEDGEMENT_MS,
        );
      } catch (error) {
        cleanUpUnresponsiveWorker();
        throw error;
      }
      cleanUpResponsiveWorker();
    };
  } catch (error) {
    cleanUpUnresponsiveWorker();
    throw error;
  }
}

function synchronizeDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedUtf8File(
  path: string,
  maximumBytes: number,
  label: string,
): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    if (fstatSync(descriptor).size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    if (bytesRead > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary read or size-limit failure.
      }
    }
    throw error;
  }
}

function recoverCapturedSidecars(
  originalsLibraryPath: string,
  capturedSidecars: readonly {
    sidecarPath: string;
    snapshot?: LegacyQueueSidecarSnapshot;
  }[],
): {
  discoveries: LegacySidecarDiscovery[];
  issues: LegacySidecarImportIssue[];
} {
  const capturedByPath = new Map(
    capturedSidecars.map((captured) => [captured.sidecarPath, captured]),
  );
  const discoveries: LegacySidecarDiscovery[] = [];
  const issues: LegacySidecarImportIssue[] = [];
  let retainedBytes = 0;
  let scanBytes = 0;
  let totalJobs = 0;
  for (const recordedPath of [...capturedByPath.keys()].sort()) {
    const captured = capturedByPath.get(recordedPath)!;
    const sidecarPath = resolve(recordedPath);
    if (!isPathWithinDirectory(originalsLibraryPath, sidecarPath)) {
      throw new Error(
        "Invalid SQLite cutover marker: sidecar path is outside the originals library",
      );
    }
    try {
      lstatSync(sidecarPath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const discovery = parseSidecar(sidecarPath, {
      originalsLibraryPath,
      snapshot: captured.snapshot,
    });
    scanBytes += discovery.outcome === "parsed"
      ? discovery.sidecar.sourceBytes
      : discovery.sourceBytes;
    retainedBytes += discovery.outcome === "parsed"
      ? discovery.sidecar.sourceBytes
      : 0;
    totalJobs +=
      discovery.outcome === "parsed" ? discovery.sidecar.jobs.length : 0;
    if (scanBytes > MAX_LEGACY_SCAN_BYTES) {
      issues.push({
        code: "invalid_sidecar",
        message: `Aggregate recovery sidecar scan work exceeds the ${MAX_LEGACY_SCAN_BYTES}-byte limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (retainedBytes > MAX_LEGACY_IMPORT_BYTES) {
      return {
        discoveries: [],
        issues: [{
          code: "invalid_sidecar",
          message: `Aggregate recovery sidecar bytes exceed the ${MAX_LEGACY_IMPORT_BYTES}-byte import limit`,
          sidecarPath: originalsLibraryPath,
        }],
      };
    }
    if (totalJobs > MAX_LEGACY_IMPORT_JOBS) {
      return {
        discoveries: [],
        issues: [{
          code: "invalid_sidecar",
          message: `Aggregate recovery legacy jobs exceed the ${MAX_LEGACY_IMPORT_JOBS}-job import limit`,
          sidecarPath: originalsLibraryPath,
        }],
      };
    }
    discoveries.push(discovery);
  }
  return { discoveries, issues };
}

function recoverPublishedSidecars(
  originalsLibraryPath: string,
  sidecarSnapshots: readonly LegacyQueueSidecarSnapshot[],
): {
  discoveries: LegacySidecarDiscovery[];
  issues: LegacySidecarImportIssue[];
} {
  const discoveries = [...sidecarSnapshots]
    .sort((left, right) => left.sidecarPath.localeCompare(right.sidecarPath))
    .map((snapshot): LegacySidecarDiscovery => {
      if (
        !isPathWithinDirectory(
          originalsLibraryPath,
          resolve(snapshot.sidecarPath),
        )
      ) {
        throw new Error(
          "Invalid SQLite cutover marker: sidecar path is outside the originals library",
        );
      }
      const sidecar = restorePublishedSidecar(snapshot);
      if (!legacySourceArchiveMatchesSnapshot(originalsLibraryPath, sidecar)) {
        return {
          outcome: "skipped",
          sourceBytes: sidecar.sourceBytes,
          issue: {
            code: "duplicate_record",
            message:
              "Legacy source archive conflicts with the object captured at SQLite cutover",
            sidecarPath: sidecar.sidecarPath,
          },
        };
      }
      return { outcome: "parsed", sidecar };
    });
  return { discoveries, issues: [] };
}

function recoverPublishedJobSidecars(
  originalsLibraryPath: string,
  jobSnapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>,
): {
  discoveries: LegacySidecarDiscovery[];
  issues: LegacySidecarImportIssue[];
} {
  const sidecarPaths = new Set<string>();
  for (const snapshot of jobSnapshots.values()) {
    sidecarPaths.add(snapshot.sidecarPath);
  }
  return recoverCapturedSidecars(
    originalsLibraryPath,
    [...sidecarPaths].map((sidecarPath) => ({ sidecarPath })),
  );
}

export function retireLegacySidecarQueue(
  originalsLibraryPath: string,
  discoveryBatch: LegacySidecarDiscoveryBatch,
  stageCatalogReviewBoundary: (
    discoveries: readonly LegacySidecarDiscovery[],
  ) => void,
): LegacyQueueCutover | null {
  const { discoveries } = discoveryBatch;
  const markerPath = join(
    originalsLibraryPath,
    LEGACY_QUEUE_CUTOVER_MARKER,
  );
  if (
    !existsSync(markerPath) &&
    (!discoveryBatch.complete ||
      discoveries.some((discovery) => discovery.outcome === "skipped"))
  ) {
    return null;
  }
  const discoveredSnapshots = new Map<
    LegacyJobLogicalKey,
    LegacyQueueJobSnapshot
  >();
  const discoveredSidecars: LegacyQueueSidecarSnapshot[] = [];
  let hasParsedSidecar = false;
  for (const discovery of discoveries) {
    if (discovery.outcome !== "parsed") {
      continue;
    }
    hasParsedSidecar = true;
    discoveredSidecars.push(snapshotLegacySidecar(discovery.sidecar));
    for (const job of discovery.sidecar.jobs) {
      const logicalKey = legacyJobLogicalKey(
        discovery.sidecar.fingerprint,
        job,
      );
      const signature = legacyJobSignature(job);
      if (!discoveredSnapshots.has(logicalKey)) {
        discoveredSnapshots.set(logicalKey, {
          jobIndex: job.jobIndex,
          sidecarPath: discovery.sidecar.sidecarPath,
          signature,
        });
      }
    }
  }

  const publishMarkerContents = (markerContents: string): void => {
    if (Buffer.byteLength(markerContents, "utf8") > MAX_LEGACY_MARKER_BYTES) {
      throw new Error(
        `SQLite cutover marker exceeds the ${MAX_LEGACY_MARKER_BYTES}-byte limit`,
      );
    }
    const temporaryMarkerPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
    let markerDescriptor: number | undefined;
    try {
      markerDescriptor = openSync(temporaryMarkerPath, "wx", 0o600);
      writeFileSync(markerDescriptor, markerContents, { encoding: "utf8" });
      fsyncSync(markerDescriptor);
      closeSync(markerDescriptor);
      markerDescriptor = undefined;
      renameSync(temporaryMarkerPath, markerPath);
      synchronizeDirectory(originalsLibraryPath);
    } finally {
      if (markerDescriptor !== undefined) {
        closeSync(markerDescriptor);
      }
      if (existsSync(temporaryMarkerPath)) {
        unlinkSync(temporaryMarkerPath);
      }
    }
  };
  const writeMarker = (
    snapshots: ReadonlyMap<LegacyJobLogicalKey, LegacyQueueJobSnapshot>,
  ): void => {
    if (snapshots.size > MAX_LEGACY_IMPORT_JOBS) {
      throw new Error(
        `SQLite cutover marker legacyJobs exceed the ${MAX_LEGACY_IMPORT_JOBS}-entry limit`,
      );
    }
    const serializedLegacySidecars = discoveredSidecars.map((snapshot) =>
      JSON.stringify(snapshot),
    );
    const serializedLegacyJobs: string[] = [];
    for (const [logicalKey, snapshot] of snapshots) {
      const serializedEntry = JSON.stringify({ logicalKey, ...snapshot });
      serializedLegacyJobs.push(serializedEntry);
    }
    const legacySidecarsJson = `[${serializedLegacySidecars.join(",")}]`;
    const legacyJobsJson = `[${serializedLegacyJobs.join(",")}]`;
    const snapshotPayload = `${legacySidecarsJson}\n${legacyJobsJson}`;
    const snapshotDigest = createHash("sha256")
      .update(snapshotPayload)
      .digest("hex");
    publishMarkerContents(
      `${LEGACY_MARKER_PREFIX}${legacySidecarsJson},"legacyJobs":${legacyJobsJson},"snapshotDigest":"${snapshotDigest}"}\n`,
    );
  };
  const markMarkerForRepair = (): void => {
    if (!existsSync(markerPath)) {
      return;
    }
    let currentMarker: unknown;
    try {
      currentMarker = JSON.parse(
        readBoundedUtf8File(
          markerPath,
          MAX_LEGACY_MARKER_BYTES,
          "SQLite cutover marker",
        ),
      );
    } catch (error) {
      throw new Error(
        `Invalid SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const currentValue = objectValue(currentMarker);
    if (
      currentValue?.schemaVersion !== 4 ||
      currentValue.authoritativeStore !== "sqlite" ||
      (currentValue.legacyQueueStatus !== LEGACY_QUEUE_STATUS_RETIRED &&
        currentValue.legacyQueueStatus !== LEGACY_QUEUE_STATUS_REPAIR)
    ) {
      throw new Error(
        "Only a schema-4 SQLite cutover marker can be marked for repair",
      );
    }
    if (currentValue.legacyQueueStatus === LEGACY_QUEUE_STATUS_REPAIR) {
      return;
    }
    publishMarkerContents(`${JSON.stringify({
      ...currentValue,
      legacyQueueStatus: LEGACY_QUEUE_STATUS_REPAIR,
    })}\n`);
  };

  if (existsSync(markerPath)) {
    synchronizeDirectory(originalsLibraryPath);
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("SQLite cutover marker must be a regular file");
    }
    let marker: unknown;
    try {
      marker = JSON.parse(
        readBoundedUtf8File(
          markerPath,
          MAX_LEGACY_MARKER_BYTES,
          "SQLite cutover marker",
        ),
      );
    } catch (error) {
      throw new Error(
        `Invalid SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const value = objectValue(marker);
    const hasRetiredCutoverDiscriminators =
      value?.legacyQueueStatus === LEGACY_QUEUE_STATUS_RETIRED &&
      value.authoritativeStore === "sqlite";
    const hasRepairCutoverDiscriminators =
      value?.legacyQueueStatus === LEGACY_QUEUE_STATUS_REPAIR &&
      value.authoritativeStore === "sqlite";
    if (value?.schemaVersion === 1 && hasRetiredCutoverDiscriminators) {
      return {
        jobSnapshots: new Map(),
        mode: "schema-one",
        recoveryDiscoveries: null,
        recoveryIssues: [],
        sidecarSnapshots: [],
        upgradeSchemaOne: writeMarker,
        withdrawPublication() {},
        wasAlreadyPublished: true,
      };
    } else if (
      (value?.schemaVersion === 2 ||
        value?.schemaVersion === 3 ||
        value?.schemaVersion === 4) &&
      (hasRetiredCutoverDiscriminators ||
        (value.schemaVersion === 4 && hasRepairCutoverDiscriminators))
    ) {
      if (!Array.isArray(value.legacyJobs)) {
        throw new Error("Invalid SQLite cutover marker: legacyJobs must be an array");
      }
      if (value.legacyJobs.length > MAX_LEGACY_IMPORT_JOBS) {
        throw new Error(
          `Invalid SQLite cutover marker: legacyJobs exceed the ${MAX_LEGACY_IMPORT_JOBS}-entry limit`,
        );
      }
      const entries: Array<
        | {
            jobIndex: number;
            logicalKey: string;
            sidecarPath: string;
            signature: string;
          }
        | { logicalKey: string; signature: string }
      > = [];
      const jobSnapshots = new Map<
        LegacyJobLogicalKey,
        LegacyQueueJobSnapshot
      >();
      const sidecarSnapshots: LegacyQueueSidecarSnapshot[] = [];
      const sidecarSnapshotPaths = new Set<string>();
      if (value.schemaVersion === 4) {
        if (!Array.isArray(value.legacySidecars)) {
          throw new Error(
            "Invalid SQLite cutover marker: legacySidecars must be an array",
          );
        }
        if (value.legacySidecars.length > MAX_LEGACY_LIBRARY_ENTRIES) {
          throw new Error(
            `Invalid SQLite cutover marker: legacySidecars exceed the ${MAX_LEGACY_LIBRARY_ENTRIES}-entry limit`,
          );
        }
        for (const entry of value.legacySidecars) {
          const item = objectValue(entry);
          const sidecarPath = nonEmptyString(item?.sidecarPath);
          const archivePath = nonEmptyString(item?.archivePath);
          const archiveSnapshot = parseSourceArchiveSnapshot(
            item?.archiveSnapshot,
          );
          const fingerprint = nonEmptyString(item?.fingerprint);
          const pathBase = nonEmptyString(item?.pathBase);
          const payload =
            fingerprint && sidecarPath
              ? parseSidecarPayloadSnapshot(
                  item?.payload,
                  fingerprint,
                  sidecarPath,
                )
              : null;
          if (
            !sidecarPath ||
            !isAbsolute(sidecarPath) ||
            !archivePath ||
            !isAbsolute(archivePath) ||
            !archiveSnapshot ||
            !fingerprint ||
            !pathBase ||
            !isAbsolute(pathBase) ||
            !payload ||
            sidecarSnapshotPaths.has(sidecarPath)
          ) {
            throw new Error(
              "Invalid SQLite cutover marker: malformed or duplicate legacy sidecar",
            );
          }
          sidecarSnapshotPaths.add(sidecarPath);
          sidecarSnapshots.push({
            archivePath,
            archiveSnapshot,
            fingerprint,
            pathBase,
            payload,
            sidecarPath,
          });
        }
      }
      for (const entry of value.legacyJobs) {
        const item = objectValue(entry);
        const logicalKey = nonEmptyString(item?.logicalKey);
        const signature = nonEmptyString(item?.signature);
        const hasSnapshotLocation =
          item !== null &&
          ("sidecarPath" in item || "jobIndex" in item);
        const sidecarPath = hasSnapshotLocation
          ? nonEmptyString(item?.sidecarPath)
          : markerPath;
        const jobIndex = hasSnapshotLocation
          ? nonNegativeInteger(item?.jobIndex)
          : 0;
        const logicalIdentity = logicalKey
          ? parseLegacyJobLogicalKey(logicalKey)
          : null;
        const canonicalLogicalKey = logicalIdentity
          ? createLegacyJobLogicalKey(logicalIdentity)
          : null;
        if (
          !logicalKey ||
          canonicalLogicalKey !== logicalKey ||
          !signature ||
          !sidecarPath ||
          jobIndex === null ||
          ((value.schemaVersion === 3 || value.schemaVersion === 4) &&
            !hasSnapshotLocation) ||
          (value.schemaVersion === 4 &&
            !sidecarSnapshotPaths.has(sidecarPath)) ||
          !isValidPublishedJob(logicalKey, signature) ||
          jobSnapshots.has(canonicalLogicalKey)
        ) {
          throw new Error("Invalid SQLite cutover marker: malformed or duplicate legacy job");
        }
        const snapshot = { jobIndex, sidecarPath, signature };
        entries.push(
          hasSnapshotLocation
            ? { logicalKey, ...snapshot }
            : { logicalKey, signature },
        );
        jobSnapshots.set(canonicalLogicalKey, snapshot);
      }
      const digestPayload =
        value.schemaVersion === 4
          ? `${JSON.stringify(sidecarSnapshots)}\n${JSON.stringify(entries)}`
          : JSON.stringify(entries);
      const expectedDigest = createHash("sha256")
        .update(digestPayload)
        .digest("hex");
      if (value.snapshotDigest !== expectedDigest) {
        throw new Error("Invalid SQLite cutover marker: snapshot digest mismatch");
      }
      if (hasRepairCutoverDiscriminators) {
        if (
          !discoveryBatch.complete ||
          !hasParsedSidecar ||
          discoveries.some((discovery) => discovery.outcome === "skipped")
        ) {
          return null;
        }
        stageCatalogReviewBoundary(discoveries);
        writeMarker(discoveredSnapshots);
        return {
          jobSnapshots: discoveredSnapshots,
          mode: "snapshot",
          recoveryDiscoveries: null,
          recoveryIssues: [],
          sidecarSnapshots: discoveredSidecars,
          withdrawPublication: markMarkerForRepair,
          wasAlreadyPublished: true,
        };
      }
      if (value.schemaVersion === 4) {
        stageCatalogReviewBoundary(
          sidecarSnapshots.map((snapshot) => ({
            outcome: "parsed" as const,
            sidecar: restorePublishedSidecar(snapshot),
          })),
        );
      }
      const recovery =
        value.schemaVersion === 4
          ? recoverPublishedSidecars(originalsLibraryPath, sidecarSnapshots)
          : value.schemaVersion === 3 && !discoveryBatch.complete
            ? recoverPublishedJobSidecars(
                originalsLibraryPath,
                jobSnapshots,
              )
            : null;
      return {
        jobSnapshots,
        mode:
          value.schemaVersion === 4
            ? "snapshot"
            : "historical-snapshot",
        recoveryDiscoveries:
          recovery?.discoveries ??
          (discoveryBatch.complete ? null : []),
        recoveryIssues: recovery?.issues ?? [],
        sidecarSnapshots,
        withdrawPublication:
          value.schemaVersion === 4
            ? markMarkerForRepair
            : () => {},
        wasAlreadyPublished: true,
      };
    } else {
      throw new Error("Invalid SQLite cutover marker: unsupported schema or status");
    }
  }
  if (!hasParsedSidecar) {
    return {
      jobSnapshots: new Map(),
      mode: "snapshot",
      recoveryDiscoveries: null,
      recoveryIssues: [],
      sidecarSnapshots: [],
      withdrawPublication() {},
      wasAlreadyPublished: false,
    };
  }
  stageCatalogReviewBoundary(discoveries);
  writeMarker(discoveredSnapshots);
  return {
    jobSnapshots: discoveredSnapshots,
    mode: "snapshot",
    recoveryDiscoveries: null,
    recoveryIssues: [],
    sidecarSnapshots: discoveredSidecars,
    withdrawPublication() {
      if (!existsSync(markerPath)) {
        return;
      }
      unlinkSync(markerPath);
      synchronizeDirectory(originalsLibraryPath);
    },
    wasAlreadyPublished: false,
  };
}
