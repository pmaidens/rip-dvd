import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  LegacySidecarImportIssue,
  MediaItemKind,
} from "../types.js";

const DEFAULT_HANDBRAKE_PRESET = "Fast 480p30";

export interface ParsedLegacyJob {
  completed: boolean;
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
  fingerprint: string;
  issues: LegacySidecarImportIssue[];
  jobs: ParsedLegacyJob[];
  movieTitle: string;
  movieYear: number | null;
  scanData: unknown;
  sidecarPath: string;
}

export type LegacySidecarDiscovery =
  | { outcome: "parsed"; sidecar: ParsedLegacySidecar }
  | { outcome: "skipped"; issue: LegacySidecarImportIssue };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function optionalYear(value: unknown): number | null {
  const year = positiveInteger(value);
  return year !== null && year >= 1800 && year <= 9999 ? year : null;
}

function resolveRecordedPath(path: string, sidecarPath: string): string {
  return isAbsolute(path) ? path : resolve(sidecarPath, "..", path);
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
  const legacyInteger = (value: unknown, defaultValue?: number) => {
    if (value === undefined && defaultValue !== undefined) {
      return defaultValue;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      value = Number(value);
    }
    return Number.isSafeInteger(value) ? Number(value) : null;
  };
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
  const outputPath = resolveRecordedPath(output, sidecarPath);
  const jobSource = nonEmptyString(job.source);
  if (
    jobSource &&
    resolveRecordedPath(jobSource, sidecarPath) !== archivePath
  ) {
    return invalid("Encode job source does not match the sidecar archive");
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
  let completed = false;
  try {
    completed = statSync(outputPath).isFile();
  } catch {
    completed = false;
  }
  return {
    completed,
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
  const schemaVersion = data.schema_version ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return invalid("Only legacy sidecar schema versions 1 and 2 are supported");
  }
  if ((data.archive_status ?? "ready") !== "ready") {
    return invalid("Original Disc Archive is not marked ready");
  }
  const source = nonEmptyString(data.source);
  if (!source) {
    return invalid("Sidecar source must be a non-empty archive path");
  }
  const archivePath = resolveRecordedPath(source, sidecarPath);
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
    },
  };
}

function findSidecars(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
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
