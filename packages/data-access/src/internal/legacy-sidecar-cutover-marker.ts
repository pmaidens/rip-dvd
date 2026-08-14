import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { LegacySidecarImportIssue } from "../legacy-sidecar-types.js";
import type {
  LegacyQueueCutover,
  LegacyQueueJobSnapshot,
  LegacyQueueSidecarPayloadSnapshot,
  LegacyQueueSidecarSnapshot,
  LegacySidecarDiscovery,
  LegacySidecarDiscoveryBatch,
  LegacySourceArchiveSnapshot,
  ParsedLegacyJob,
  ParsedLegacySidecar,
} from "./legacy-sidecars.js";
import {
  createLegacySidecarImportBudgetAccumulator,
  MAX_LEGACY_IMPORT_BYTES,
  MAX_LEGACY_IMPORT_JOBS,
  MAX_LEGACY_SCAN_BYTES,
} from "./legacy-sidecar-import-budget.js";
import {
  createLegacyJobLogicalKey,
  legacyJobLogicalKey,
  legacyJobSignature,
  parseLegacyJobLogicalKey,
  type LegacyJobLogicalKey,
} from "./legacy-sidecar-identity.js";
import {
  LEGACY_MARKER_PREFIX,
  MAX_LEGACY_LIBRARY_ENTRIES,
  MAX_LEGACY_MARKER_BYTES,
  MAX_LEGACY_SIDECAR_BYTES,
  MAX_LEGACY_SIDECAR_JOBS,
} from "./legacy-sidecar-limits.js";
import {
  legacySourceArchiveMatchesSnapshot,
  parseLegacySidecar,
} from "./legacy-sidecar-parser.js";
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

const LEGACY_QUEUE_STATUS_REPAIR = "repair";
const LEGACY_QUEUE_STATUS_RETIRED = "retired";
const LEGACY_QUEUE_CUTOVER_MARKER = ".rip-dvd-sqlite-catalog";

export function snapshotLegacySidecar(
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
    identity.profileKey === profile &&
    (identity.outputPath === undefined ||
      identity.outputPath === job.outputPath)
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
  const importBudget = createLegacySidecarImportBudgetAccumulator();
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
    const discovery = parseLegacySidecar(sidecarPath, {
      originalsLibraryPath,
      snapshot: captured.snapshot,
    });
    const exceededImportBound = importBudget.record(discovery);
    if (exceededImportBound === "scan-bytes") {
      issues.push({
        code: "invalid_sidecar",
        message: `Aggregate recovery sidecar scan work exceeds the ${MAX_LEGACY_SCAN_BYTES}-byte limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (exceededImportBound === "retained-bytes") {
      return {
        discoveries: [],
        issues: [{
          code: "invalid_sidecar",
          message: `Aggregate recovery sidecar bytes exceed the ${MAX_LEGACY_IMPORT_BYTES}-byte import limit`,
          sidecarPath: originalsLibraryPath,
        }],
      };
    }
    if (exceededImportBound === "jobs") {
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
    options?: { allowStagedIdentityReplacement?: boolean },
  ) => boolean,
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
      let markerBoundaryIsComplete = true;
      if (value.schemaVersion === 4) {
        markerBoundaryIsComplete = stageCatalogReviewBoundary(
          sidecarSnapshots.map((snapshot) => ({
            outcome: "parsed" as const,
            sidecar: restorePublishedSidecar(snapshot),
          })),
          { allowStagedIdentityReplacement: true },
        );
      }
      if (hasRepairCutoverDiscriminators) {
        const currentParsedSidecarPaths = new Set(
          discoveries.flatMap((discovery) =>
            discovery.outcome === "parsed"
              ? [discovery.sidecar.sidecarPath]
              : [],
          ),
        );
        if (
          !discoveryBatch.complete ||
          !hasParsedSidecar ||
          discoveries.some((discovery) => discovery.outcome === "skipped") ||
          sidecarSnapshots.some(
            (snapshot) =>
              !currentParsedSidecarPaths.has(snapshot.sidecarPath),
          )
        ) {
          return null;
        }
        if (!stageCatalogReviewBoundary(discoveries)) {
          return null;
        }
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
      if (!markerBoundaryIsComplete) {
        return null;
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
    if (!stageCatalogReviewBoundary(discoveries)) {
      return null;
    }
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
  if (!stageCatalogReviewBoundary(discoveries)) {
    return null;
  }
  writeMarker(discoveredSnapshots);
  return {
    jobSnapshots: discoveredSnapshots,
    mode: "snapshot",
    recoveryDiscoveries: null,
    recoveryIssues: [],
    sidecarSnapshots: discoveredSidecars,
    withdrawPublication: markMarkerForRepair,
    wasAlreadyPublished: false,
  };
}
