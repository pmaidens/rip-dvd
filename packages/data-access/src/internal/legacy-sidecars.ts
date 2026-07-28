import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type {
  LegacySidecarImportIssue,
  MediaItemKind,
} from "../types.js";
import {
  legacyJobLogicalKey,
  legacyJobSignature,
} from "./legacy-sidecar-identity.js";

const DEFAULT_HANDBRAKE_PRESET = "Fast 480p30";
const LEGACY_QUEUE_CUTOVER_MARKER = ".rip-dvd-sqlite-catalog";
const LEGACY_QUEUE_CUTOVER_LOCK = ".rip-dvd-legacy-queue.lock";
const LEGACY_QUEUE_SHARED_LEASE_PREFIX =
  ".rip-dvd-legacy-queue.shared.";
const LEGACY_QUEUE_LOCK_POLL_MS = 10;
const LEGACY_QUEUE_LOCK_TIMEOUT_MS = 15_000;

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
  archiveSizeBytes: number;
  archivedAt: Date;
  createdAt: Date;
  fingerprint: string;
  issues: LegacySidecarImportIssue[];
  jobs: ParsedLegacyJob[];
  movieTitle: string;
  movieYear: number | null;
  scanData: unknown;
  sidecarPath: string;
  updatedAt: Date;
}

export type LegacySidecarDiscovery =
  | { outcome: "parsed"; sidecar: ParsedLegacySidecar }
  | { outcome: "skipped"; issue: LegacySidecarImportIssue };

export interface LegacyQueueCutover {
  jobSignatures: ReadonlyMap<string, string>;
  wasAlreadyPublished: boolean;
}

export function resolveLegacyOriginalsLibrary(path: string): string {
  const resolvedPath = isAbsolute(path)
    ? normalize(path)
    : resolve(path);
  let libraryStat;
  try {
    libraryStat = statSync(resolvedPath);
    readdirSync(resolvedPath);
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
  return resolvedPath;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
  const profileSeparator = logicalKey.lastIndexOf("\0");
  const sourceSeparator = logicalKey.lastIndexOf("\0", profileSeparator - 1);
  return (
    sourceSeparator > 0 &&
    profileSeparator > sourceSeparator + 1 &&
    logicalKey.slice(sourceSeparator + 1, profileSeparator) === sourceKey &&
    logicalKey.slice(profileSeparator + 1) === profile
  );
}

type RecordedPathResolution =
  | { outcome: "resolved"; path: string }
  | { outcome: "ambiguous"; message: string };

function resolveRecordedPath(
  path: string,
  sidecarPath: string,
): RecordedPathResolution {
  if (isAbsolute(path)) {
    return { outcome: "resolved", path: normalize(path) };
  }
  const candidates = [
    resolve(path),
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
  const outputResolution = resolveRecordedPath(output, sidecarPath);
  if (outputResolution.outcome === "ambiguous") {
    return invalid(outputResolution.message);
  }
  const outputPath = outputResolution.path;
  const jobSource = nonEmptyString(job.source);
  if (jobSource) {
    const sourceResolution = resolveRecordedPath(jobSource, sidecarPath);
    if (sourceResolution.outcome === "ambiguous") {
      return invalid(sourceResolution.message);
    }
    if (sourceResolution.path !== archivePath) {
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

function parseSidecar(sidecarPath: string): LegacySidecarDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch (error) {
    return {
      outcome: "skipped",
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
  const archiveResolution = resolveRecordedPath(source, sidecarPath);
  if (archiveResolution.outcome === "ambiguous") {
    return invalid(archiveResolution.message);
  }
  const archivePath = archiveResolution.path;
  let archiveStat;
  try {
    archiveStat = statSync(archivePath);
  } catch {
    return {
      outcome: "skipped",
      issue: {
        code: "missing_archive",
        message: `Original Disc Archive is missing: ${archivePath}`,
        sidecarPath,
      },
    };
  }
  if (!archiveStat.isFile()) {
    return invalid(`Original Disc Archive is not a file: ${archivePath}`);
  }
  const fingerprint =
    nonEmptyString(data.disc_fingerprint) ?? derivedFingerprint(data);
  if (!fingerprint) {
    return invalid(
      "Sidecar has neither a fingerprint nor a valid DVD title map",
    );
  }
  if (!Array.isArray(data.jobs)) {
    return invalid("Sidecar jobs must be an array");
  }
  const movieTitle =
    nonEmptyString(data.title) ??
    archivePath.split("/").at(-1)?.replace(/\.iso$/i, "") ??
    "Imported DVD";
  const parsedJobs: ParsedLegacyJob[] = [];
  const issues: LegacySidecarImportIssue[] = [];
  data.jobs.forEach((value, index) => {
    const result = parseJob(value, index, sidecarPath, archivePath, movieTitle);
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
    const logicalKey = `${job.sourceKey}\0${job.profileKey}`;
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
  return {
    outcome: "parsed",
    sidecar: {
      archivePath,
      archiveSizeBytes: archiveStat.size,
      archivedAt: updatedAt ?? archiveStat.mtime,
      createdAt: createdAt ?? archiveStat.mtime,
      fingerprint,
      issues,
      jobs,
      movieTitle,
      movieYear: optionalYear(data.year),
      scanData: {
        discTitle: data.disc_title ?? null,
        legacySchemaVersion: schemaVersion,
        titles: data.titles ?? [],
      },
      sidecarPath,
      updatedAt: updatedAt ?? archiveStat.mtime,
    },
  };
}

function findSidecars(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...findSidecars(path));
    } else if (entry.isFile() && entry.name.endsWith(".rip-dvd.json")) {
      paths.push(path);
    }
  }
  return paths.sort();
}

export function discoverLegacySidecars(
  originalsLibraryPath: string,
): LegacySidecarDiscovery[] {
  return findSidecars(originalsLibraryPath).map(parseSidecar);
}

export function acquireLegacyQueueCutoverLock(
  originalsLibraryPath: string,
): () => void {
  const lockPath = join(originalsLibraryPath, LEGACY_QUEUE_CUTOVER_LOCK);
  const ownerPath = join(
    originalsLibraryPath,
    `${LEGACY_QUEUE_CUTOVER_LOCK}.${process.pid}.${randomUUID()}.owner`,
  );
  const ownerDescriptor = openSync(ownerPath, "wx", 0o600);
  try {
    writeFileSync(
      ownerDescriptor,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, role: "cutover" })}\n`,
      { encoding: "utf8" },
    );
    fsyncSync(ownerDescriptor);
  } finally {
    closeSync(ownerDescriptor);
  }
  const deadline = Date.now() + LEGACY_QUEUE_LOCK_TIMEOUT_MS;
  const sleepState = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;

  const ownerIsDead = (path: string): boolean => {
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink()) {
        return false;
      }
      const owner = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (
        !owner ||
        typeof owner !== "object" ||
        !("schemaVersion" in owner) ||
        owner.schemaVersion !== 1 ||
        !("role" in owner) ||
        (owner.role !== "cutover" && owner.role !== "legacy-command") ||
        !("pid" in owner) ||
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0
      ) {
        return false;
      }
      try {
        process.kill(Number(owner.pid), 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      return false;
    }
  };

  const wait = (message: string): void => {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    Atomics.wait(sleepState, 0, 0, LEGACY_QUEUE_LOCK_POLL_MS);
  };

  try {
    while (true) {
      try {
        linkSync(ownerPath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "EEXIST") {
          throw error;
        }
        if (ownerIsDead(lockPath)) {
          unlinkSync(lockPath);
          continue;
        }
        wait(`Timed out waiting for another SQLite cutover: ${lockPath}`);
      }
    }
    unlinkSync(ownerPath);

    while (true) {
      const sharedLeases = readdirSync(originalsLibraryPath)
        .filter((name) => name.startsWith(LEGACY_QUEUE_SHARED_LEASE_PREFIX))
        .map((name) => join(originalsLibraryPath, name));
      for (const leasePath of sharedLeases) {
        if (ownerIsDead(leasePath)) {
          unlinkSync(leasePath);
        }
      }
      const activeLeases = sharedLeases.filter((path) => existsSync(path));
      if (activeLeases.length === 0) {
        break;
      }
      wait(
        `Timed out waiting for an active legacy queue command: ${activeLeases[0]}`,
      );
    }

    let released = false;
    return () => {
      if (!released) {
        released = true;
        unlinkSync(lockPath);
      }
    };
  } catch (error) {
    if (acquired && existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
    throw error;
  } finally {
    if (existsSync(ownerPath)) {
      unlinkSync(ownerPath);
    }
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

export function retireLegacySidecarQueue(
  originalsLibraryPath: string,
  discoveries: readonly LegacySidecarDiscovery[],
): LegacyQueueCutover {
  const markerPath = join(
    originalsLibraryPath,
    LEGACY_QUEUE_CUTOVER_MARKER,
  );
  const discoveredSignatures = new Map<string, string>();
  for (const discovery of discoveries) {
    if (discovery.outcome !== "parsed") {
      continue;
    }
    for (const job of discovery.sidecar.jobs) {
      const logicalKey = legacyJobLogicalKey(
        discovery.sidecar.fingerprint,
        job,
      );
      const signature = legacyJobSignature(job);
      if (!discoveredSignatures.has(logicalKey)) {
        discoveredSignatures.set(logicalKey, signature);
      }
    }
  }

  const legacyJobs = [...discoveredSignatures].map(
    ([logicalKey, signature]) => ({ logicalKey, signature }),
  );
  const snapshotDigest = createHash("sha256")
    .update(JSON.stringify(legacyJobs))
    .digest("hex");
  const markerContents = `${JSON.stringify({
    schemaVersion: 2,
    legacyQueueStatus: "retired",
    authoritativeStore: "sqlite",
    legacyJobs,
    snapshotDigest,
  })}\n`;

  let replaceSchemaOneMarker = false;
  if (existsSync(markerPath)) {
    synchronizeDirectory(originalsLibraryPath);
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("SQLite cutover marker must be a regular file");
    }
    let marker: unknown;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Invalid SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const value = objectValue(marker);
    const hasCutoverDiscriminators =
      value?.legacyQueueStatus === "retired" &&
      value.authoritativeStore === "sqlite";
    if (value?.schemaVersion === 1 && hasCutoverDiscriminators) {
      replaceSchemaOneMarker = true;
    } else if (value?.schemaVersion === 2 && hasCutoverDiscriminators) {
      if (!Array.isArray(value.legacyJobs)) {
        throw new Error("Invalid SQLite cutover marker: legacyJobs must be an array");
      }
      const entries: Array<{ logicalKey: string; signature: string }> = [];
      const jobSignatures = new Map<string, string>();
      for (const entry of value.legacyJobs) {
        const item = objectValue(entry);
        const logicalKey = nonEmptyString(item?.logicalKey);
        const signature = nonEmptyString(item?.signature);
        if (
          !logicalKey ||
          !signature ||
          !isValidPublishedJob(logicalKey, signature) ||
          jobSignatures.has(logicalKey)
        ) {
          throw new Error("Invalid SQLite cutover marker: malformed or duplicate legacy job");
        }
        entries.push({ logicalKey, signature });
        jobSignatures.set(logicalKey, signature);
      }
      const expectedDigest = createHash("sha256")
        .update(JSON.stringify(entries))
        .digest("hex");
      if (value.snapshotDigest !== expectedDigest) {
        throw new Error("Invalid SQLite cutover marker: snapshot digest mismatch");
      }
      return { jobSignatures, wasAlreadyPublished: true };
    } else {
      throw new Error("Invalid SQLite cutover marker: unsupported schema or status");
    }
  }

  const temporaryMarkerPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  let markerDescriptor: number | undefined;
  try {
    markerDescriptor = openSync(temporaryMarkerPath, "wx", 0o600);
    writeFileSync(
      markerDescriptor,
      markerContents,
      { encoding: "utf8" },
    );
    fsyncSync(markerDescriptor);
    closeSync(markerDescriptor);
    markerDescriptor = undefined;
    renameSync(temporaryMarkerPath, markerPath);
    synchronizeDirectory(originalsLibraryPath);
  } finally {
    if (markerDescriptor !== undefined) {
      closeSync(markerDescriptor);
    }
    if (
      existsSync(temporaryMarkerPath)
    ) {
      unlinkSync(temporaryMarkerPath);
    }
  }
  return {
    jobSignatures: discoveredSignatures,
    wasAlreadyPublished: replaceSchemaOneMarker,
  };
}
