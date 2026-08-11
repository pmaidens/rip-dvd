import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  opendirSync,
  openSync,
  realpathSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { LegacySidecarImportIssue } from "../legacy-sidecar-types.js";
import type {
  LegacyQueueSidecarSnapshot,
  LegacySidecarDiscovery,
  LegacySourceArchiveSnapshot,
  ParsedLegacyJob,
  ParsedLegacySidecar,
} from "./legacy-sidecars.js";
import {
  MAX_LEGACY_SIDECAR_BYTES,
  MAX_LEGACY_SIDECAR_JOBS,
} from "./legacy-sidecar-limits.js";
import {
  legacyInteger,
  nonEmptyString,
  nonNegativeInteger,
  objectValue,
  optionalYear,
  positiveInteger,
  recordedDate,
} from "./legacy-sidecar-validation.js";
import { isPathWithinDirectory } from "./path-containment.js";

const DEFAULT_HANDBRAKE_PRESET = "Fast 480p30";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

export function parseLegacySidecar(
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
