import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

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
const LEGACY_QUEUE_LOCK_POLL_MS = 10;
const LEGACY_QUEUE_WORKER_STALL_MS = 2_000;
const LEGACY_QUEUE_RELEASE_ACKNOWLEDGEMENT_MS = 1_000;
const LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS = 250;
const LEGACY_QUEUE_HELPER_STATE = {
  starting: 0,
  intentReady: 1,
  ready: 2,
  released: 3,
  failed: 4,
} as const;
const LEGACY_QUEUE_HELPER_STATE_INDEX = 0;
const LEGACY_QUEUE_HELPER_RELEASE_INDEX = 1;
const LEGACY_QUEUE_HELPER_HEARTBEAT_INDEX = 2;
const LEGACY_QUEUE_SUPERVISOR_ABORT = "supervisor-abort";
const LEGACY_QUEUE_CUTOVER_WORKER = String.raw`
const { spawn } = require("node:child_process");
const {
  existsSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const STARTING = 0;
const INTENT_READY = 1;
const READY = 2;
const RELEASED = 3;
const FAILED = 4;
const STATE_INDEX = 0;
const RELEASE_INDEX = 1;
const HEARTBEAT_INDEX = 2;
const sharedState = new Int32Array(workerData.sharedState);
const statePath = (name) => join(workerData.stateDirectory, name);
let finished = false;
let releaseSent = false;
let failurePublished = false;
let terminationRequestedAt;
let terminationSignalSentAt;
let timer;

function publishHeartbeat() {
  Atomics.add(sharedState, HEARTBEAT_INDEX, 1);
  Atomics.notify(sharedState, HEARTBEAT_INDEX);
}

function publishState(state) {
  if (finished && state !== FAILED) {
    return;
  }
  Atomics.store(sharedState, STATE_INDEX, state);
  Atomics.notify(sharedState, STATE_INDEX);
}

function finish() {
  finished = true;
  if (timer) {
    clearInterval(timer);
  }
  parentPort.close();
}

function publishFailure(message) {
  if (failurePublished) {
    return;
  }
  failurePublished = true;
  try {
    writeFileSync(statePath("worker-error"), message, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {}
  publishState(FAILED);
}

function requestHelperTermination() {
  if (helper.exitCode === null && helper.signalCode === null) {
    if (terminationRequestedAt === undefined) {
      terminationRequestedAt = Date.now();
      return;
    }
    if (
      terminationSignalSentAt === undefined &&
      Date.now() - terminationRequestedAt >=
        ${LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS}
    ) {
      terminationSignalSentAt = Date.now();
      helper.kill("SIGTERM");
    } else if (
      terminationSignalSentAt !== undefined &&
      Date.now() - terminationSignalSentAt >=
      ${LEGACY_QUEUE_HELPER_TERMINATION_GRACE_MS}
    ) {
      helper.kill("SIGKILL");
    }
  }
}

function stateExists(name) {
  try {
    return existsSync(statePath(name));
  } catch (error) {
    publishFailure(
      "Legacy queue lease worker failed during " +
        phase() +
        ": could not inspect state " +
        name +
        ": " +
        error.message,
    );
    return false;
  }
}

function readState(name) {
  if (!stateExists(name)) {
    return null;
  }
  try {
    return readFileSync(statePath(name), "utf8");
  } catch (error) {
    publishFailure(
      "Legacy queue lease worker failed during " +
        phase() +
        ": could not read state " +
        name +
        ": " +
        error.message,
    );
    return null;
  }
}

function markReleased() {
  try {
    writeFileSync(statePath("released"), "", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") {
      publishFailure(
        "Could not publish legacy queue lease release: " + error.message,
      );
    }
  }
}

function phase() {
  const state = Atomics.load(sharedState, STATE_INDEX);
  if (state < INTENT_READY) {
    return "intent acquisition";
  }
  if (state < READY) {
    return "queue drain";
  }
  return "release acknowledgement";
}

function observeSentinels() {
  if (
    Atomics.load(sharedState, STATE_INDEX) < INTENT_READY &&
    stateExists("intent-ready")
  ) {
    publishState(INTENT_READY);
  }
  if (
    Atomics.load(sharedState, STATE_INDEX) < READY &&
    stateExists("ready")
  ) {
    publishState(READY);
  }
}

const helper = spawn(
  workerData.python,
  [
    workerData.helperPath,
    "hold-cutover",
    workerData.originalsLibraryPath,
    workerData.stateDirectory,
  ],
  { stdio: ["pipe", "ignore", "inherit"] },
);
publishHeartbeat();

helper.once("error", (error) => {
  publishFailure("Legacy queue lease helper failed to start: " + error.message);
});
helper.once("exit", (code, signal) => {
  const helperError = readState("error");
  const released = stateExists("released");
  const aborted = stateExists("supervisor-abort");
  if (helperError !== null) {
    publishFailure(helperError);
  } else if (!released && !aborted && !failurePublished) {
    observeSentinels();
    publishFailure(
      "Legacy queue lease helper exited during " +
        phase() +
        " (code " +
        String(code) +
        ", signal " +
        String(signal) +
        ")",
    );
  }
  markReleased();
  if (!failurePublished) {
    publishState(RELEASED);
  }
  finish();
});

timer = setInterval(() => {
  publishHeartbeat();
  const helperError = readState("error");
  if (helperError !== null) {
    publishFailure(helperError);
    return;
  }
  observeSentinels();
  if (stateExists("supervisor-abort")) {
    requestHelperTermination();
  }
  if (
    !releaseSent &&
    Atomics.load(sharedState, RELEASE_INDEX) === 1
  ) {
    releaseSent = true;
    try {
      writeFileSync(statePath("release"), "", {
        flag: "wx",
        mode: 0o600,
      });
      helper.stdin.end();
    } catch (error) {
      publishFailure(
        "Could not release the legacy queue lease: " + error.message,
      );
      return;
    }
  }
}, ${LEGACY_QUEUE_LOCK_POLL_MS});
`;

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
  jobSnapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>;
  mode: "schema-one" | "snapshot";
  upgradeSchemaOne(
    jobSnapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>,
  ): void;
  wasAlreadyPublished: boolean;
}

export interface LegacyQueueJobSnapshot {
  jobIndex: number;
  sidecarPath: string;
  signature: string;
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
  const helperCandidates = [
    resolve(process.cwd(), "rip_dvd", "legacy_queue_lease.py"),
    resolve(process.cwd(), "..", "..", "rip_dvd", "legacy_queue_lease.py"),
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "rip_dvd",
      "legacy_queue_lease.py",
    ),
  ];
  const helperPath = helperCandidates.find((path) => existsSync(path));
  if (!helperPath) {
    throw new Error("Could not locate the legacy queue lease helper");
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
      python,
      sharedState: helperState.buffer,
      stateDirectory,
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

export function retireLegacySidecarQueue(
  originalsLibraryPath: string,
  discoveries: readonly LegacySidecarDiscovery[],
): LegacyQueueCutover {
  const markerPath = join(
    originalsLibraryPath,
    LEGACY_QUEUE_CUTOVER_MARKER,
  );
  const discoveredSnapshots = new Map<string, LegacyQueueJobSnapshot>();
  let hasParsedSidecar = false;
  for (const discovery of discoveries) {
    if (discovery.outcome !== "parsed") {
      continue;
    }
    hasParsedSidecar = true;
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

  const writeMarker = (
    snapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>,
  ): void => {
    const legacyJobs = [...snapshots].map(([logicalKey, snapshot]) => ({
      logicalKey,
      ...snapshot,
    }));
    const snapshotDigest = createHash("sha256")
      .update(JSON.stringify(legacyJobs))
      .digest("hex");
    const markerContents = `${JSON.stringify({
      schemaVersion: 3,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs,
      snapshotDigest,
    })}\n`;
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
      return {
        jobSnapshots: new Map(),
        mode: "schema-one",
        upgradeSchemaOne: writeMarker,
        wasAlreadyPublished: true,
      };
    } else if (
      (value?.schemaVersion === 2 || value?.schemaVersion === 3) &&
      hasCutoverDiscriminators
    ) {
      if (!Array.isArray(value.legacyJobs)) {
        throw new Error("Invalid SQLite cutover marker: legacyJobs must be an array");
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
      const jobSnapshots = new Map<string, LegacyQueueJobSnapshot>();
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
        if (
          !logicalKey ||
          !signature ||
          !sidecarPath ||
          jobIndex === null ||
          (value.schemaVersion === 3 && !hasSnapshotLocation) ||
          !isValidPublishedJob(logicalKey, signature) ||
          jobSnapshots.has(logicalKey)
        ) {
          throw new Error("Invalid SQLite cutover marker: malformed or duplicate legacy job");
        }
        const snapshot = { jobIndex, sidecarPath, signature };
        entries.push(
          hasSnapshotLocation
            ? { logicalKey, ...snapshot }
            : { logicalKey, signature },
        );
        jobSnapshots.set(logicalKey, snapshot);
      }
      const expectedDigest = createHash("sha256")
        .update(JSON.stringify(entries))
        .digest("hex");
      if (value.snapshotDigest !== expectedDigest) {
        throw new Error("Invalid SQLite cutover marker: snapshot digest mismatch");
      }
      return {
        jobSnapshots,
        mode: "snapshot",
        upgradeSchemaOne() {},
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
      upgradeSchemaOne() {},
      wasAlreadyPublished: false,
    };
  }
  writeMarker(discoveredSnapshots);
  return {
    jobSnapshots: discoveredSnapshots,
    mode: "snapshot",
    upgradeSchemaOne() {},
    wasAlreadyPublished: false,
  };
}
