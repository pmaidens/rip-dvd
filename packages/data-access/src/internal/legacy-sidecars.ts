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
  legacyJobLogicalKey,
  legacyJobSignature,
} from "./legacy-sidecar-identity.js";
import { isPathWithinDirectory } from "./path-containment.js";

const DEFAULT_HANDBRAKE_PRESET = "Fast 480p30";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_LEGACY_SIDECAR_BYTES = 1_048_576;
const MAX_LEGACY_SIDECAR_JOBS = 100;
const MAX_LEGACY_IMPORT_BYTES = 8_388_608;
const MAX_LEGACY_IMPORT_JOBS = 1_000;
const MAX_LEGACY_MARKER_BYTES = 8_388_608;
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

export interface LegacyQueueCutover {
  jobSnapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>;
  mode: "schema-one" | "snapshot";
  recoveryDiscoveries: LegacySidecarDiscovery[] | null;
  recoveryIssues: LegacySidecarImportIssue[];
  sidecarSnapshots: readonly LegacyQueueSidecarSnapshot[];
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

export interface LegacyQueueSidecarSnapshot {
  archivePath: string;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  fingerprint: string;
  pathBase: string;
  sidecarPath: string;
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

interface SidecarRecoveryExpectation {
  originalsLibraryPath: string;
  snapshot?: LegacyQueueSidecarSnapshot;
}

function parseSidecar(
  sidecarPath: string,
  recovery?: SidecarRecoveryExpectation,
): LegacySidecarDiscovery {
  let contents = "";
  let sourceBytes = 0;
  let descriptor: number | undefined;
  let readIssue: LegacySidecarDiscovery | undefined;
  try {
    descriptor = openSync(sidecarPath, "r");
    if (recovery) {
      const openedStat = fstatSync(descriptor);
      const openedPath = realpathSync(sidecarPath);
      const namedStat = statSync(openedPath);
      if (
        openedPath !== normalize(sidecarPath) ||
        !isPathWithinDirectory(recovery.originalsLibraryPath, openedPath) ||
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
  const pathBase = recovery?.snapshot?.pathBase ?? process.cwd();
  const archiveResolution = resolveRecordedPath(
    source,
    sidecarPath,
    pathBase,
  );
  if (archiveResolution.outcome === "ambiguous") {
    return invalid(archiveResolution.message);
  }
  const archivePath = archiveResolution.path;
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
    recovery?.snapshot &&
    (archivePath !== recovery.snapshot.archivePath ||
      fingerprint !== recovery.snapshot.fingerprint ||
      !sourceArchiveSnapshotsMatch(
        archiveMetadata.archiveSnapshot,
        recovery.snapshot.archiveSnapshot,
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
  let totalBytes = 0;
  let totalJobs = 0;
  let totalMarkerBytes = LEGACY_MARKER_FIXED_BYTES;
  let totalMarkerJobs = 0;
  let totalMarkerSidecars = 0;
  for (const path of found.paths.sort()) {
    const discovery = parseSidecar(path);
    discoveries.push(discovery);
    if (discovery.outcome === "parsed") {
      totalBytes += discovery.sidecar.sourceBytes;
      totalJobs += discovery.sidecar.jobs.length;
    } else {
      totalBytes += discovery.sourceBytes;
    }
    if (totalBytes > MAX_LEGACY_IMPORT_BYTES) {
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
        Buffer.byteLength(
          JSON.stringify(snapshotLegacySidecar(discovery.sidecar)),
          "utf8",
        ) + (totalMarkerSidecars === 0 ? 0 : 1);
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
  let totalBytes = 0;
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
    totalBytes +=
      discovery.outcome === "parsed"
        ? discovery.sidecar.sourceBytes
        : discovery.sourceBytes;
    totalJobs +=
      discovery.outcome === "parsed" ? discovery.sidecar.jobs.length : 0;
    if (totalBytes > MAX_LEGACY_IMPORT_BYTES) {
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
  return { discoveries, issues: [] };
}

function recoverPublishedSidecars(
  originalsLibraryPath: string,
  sidecarSnapshots: readonly LegacyQueueSidecarSnapshot[],
): {
  discoveries: LegacySidecarDiscovery[];
  issues: LegacySidecarImportIssue[];
} {
  return recoverCapturedSidecars(
    originalsLibraryPath,
    sidecarSnapshots.map((snapshot) => ({
      sidecarPath: snapshot.sidecarPath,
      snapshot,
    })),
  );
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
): LegacyQueueCutover | null {
  const { discoveries } = discoveryBatch;
  const markerPath = join(
    originalsLibraryPath,
    LEGACY_QUEUE_CUTOVER_MARKER,
  );
  if (!discoveryBatch.complete && !existsSync(markerPath)) {
    return null;
  }
  const discoveredSnapshots = new Map<string, LegacyQueueJobSnapshot>();
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

  const writeMarker = (
    snapshots: ReadonlyMap<string, LegacyQueueJobSnapshot>,
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
    const markerContents = `${LEGACY_MARKER_PREFIX}${legacySidecarsJson},"legacyJobs":${legacyJobsJson},"snapshotDigest":"${snapshotDigest}"}\n`;
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
    const hasCutoverDiscriminators =
      value?.legacyQueueStatus === "retired" &&
      value.authoritativeStore === "sqlite";
    if (value?.schemaVersion === 1 && hasCutoverDiscriminators) {
      return {
        jobSnapshots: new Map(),
        mode: "schema-one",
        recoveryDiscoveries: null,
        recoveryIssues: [],
        sidecarSnapshots: [],
        upgradeSchemaOne: writeMarker,
        wasAlreadyPublished: true,
      };
    } else if (
      (value?.schemaVersion === 2 ||
        value?.schemaVersion === 3 ||
        value?.schemaVersion === 4) &&
      hasCutoverDiscriminators
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
      const jobSnapshots = new Map<string, LegacyQueueJobSnapshot>();
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
          if (
            !sidecarPath ||
            !isAbsolute(sidecarPath) ||
            !archivePath ||
            !isAbsolute(archivePath) ||
            !archiveSnapshot ||
            !fingerprint ||
            !pathBase ||
            !isAbsolute(pathBase) ||
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
        if (
          !logicalKey ||
          !signature ||
          !sidecarPath ||
          jobIndex === null ||
          ((value.schemaVersion === 3 || value.schemaVersion === 4) &&
            !hasSnapshotLocation) ||
          (value.schemaVersion === 4 &&
            !sidecarSnapshotPaths.has(sidecarPath)) ||
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
        mode: "snapshot",
        recoveryDiscoveries:
          recovery?.discoveries ??
          (discoveryBatch.complete ? null : []),
        recoveryIssues: recovery?.issues ?? [],
        sidecarSnapshots,
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
      recoveryDiscoveries: null,
      recoveryIssues: [],
      sidecarSnapshots: [],
      upgradeSchemaOne() {},
      wasAlreadyPublished: false,
    };
  }
  writeMarker(discoveredSnapshots);
  return {
    jobSnapshots: discoveredSnapshots,
    mode: "snapshot",
    recoveryDiscoveries: null,
    recoveryIssues: [],
    sidecarSnapshots: discoveredSidecars,
    upgradeSchemaOne() {},
    wasAlreadyPublished: false,
  };
}
