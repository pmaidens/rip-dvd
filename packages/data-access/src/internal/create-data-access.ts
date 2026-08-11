import {
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

import {
  createBoundedFilesystemPathProbe,
  type FilesystemPathProbe,
} from "./bounded-filesystem-path-probe.js";
import { createArchivedDvdSelectionValidator } from "./archived-dvd-selection-validator.js";
import { listWithBoundedOffset } from "./bounded-offset-pagination.js";
import {
  createBoundedChronologicalList,
  createJobList,
} from "./bounded-chronological-list.js";
import {
  evaluateDetectedDiscRediscovery,
  normalizeDetectedDiscScan,
  requiresLegacyDiscSelectionRepair,
  toDiscSelection,
} from "./dvd-contract-provenance.js";
import {
  archiveJobs,
  detectedDiscs,
  discSelections,
  encodeJobs,
  encodingProfiles,
  legacyCutoverStagedSidecars,
  mediaItems,
  opticalDrives,
  originalDiscArchiveContentIds,
  originalDiscArchives,
} from "./schema.js";
import {
  reconcileLegacyRepairCutover,
  type PublicationMutationRecoveryLock,
} from "./legacy-cutover-reconciliation.js";
import {
  dvdArchiveFileMatchesIdentity,
  hashDvdArchiveFile,
  isCurrentDvdContentSize,
  readDvdArchiveFileSize,
} from "./dvd-content-identity.js";
import {
  createJobQueueController,
  type JobQueueAdapter,
} from "./job-queue.js";
import type { LegacySidecarImportAccessFactory } from "./legacy-sidecar-catalog-adapter.js";
import { planOpticalDriveReconciliation } from "./optical-drive-reconciliation.js";
import {
  requireNonEmpty,
  requirePositiveSafeInteger,
} from "./validation.js";
import { validateMediaItem } from "./media-item-validation.js";
import { isDvdContentId } from "../dvd-scan.js";
import {
  ENCODE_PROGRESS_PHASES,
} from "../domain-values.js";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  StaleJobAttemptError,
} from "../errors.js";
import type { LegacySidecarDataAccess } from "../legacy-sidecar-types.js";
import type {
  ArchiveJobClaimToken,
  ArchiveJobId,
  ArchiveJob,
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscId,
  DetectedDiscListOptions,
  DetectedDiscStatus,
  DiscSelectionId,
  EncodeJobClaimToken,
  EncodeJobCleanupClaimToken,
  EncodeJobId,
  EncodeJob,
  EncodeJobFailureOptions,
  EncodeJobPartialCleanup,
  EncodeJobProgress,
  EncodingProfileId,
  MediaDomain,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "../types.js";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  ENCODE_JOB_LEASE_DURATION_MS,
} from "../types.js";
import { newId, requireRow } from "./persistence.js";

const BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const JOB_RECOVERY_LIMIT = 100;
const LEGACY_ARCHIVE_RECONCILIATION_LIMIT = 4;
const LEGACY_ARCHIVE_RECONCILIATION_BYTES = 9_000_000_000;
const DISC_SELECTION_REVIEW_BATCH_SIZE = 100;
const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const opticalDriveSelection = {
  id: opticalDrives.id,
  devicePath: opticalDrives.devicePath,
  displayName: opticalDrives.displayName,
  vendor: opticalDrives.vendor,
  product: opticalDrives.product,
  serialNumber: opticalDrives.serialNumber,
  isEnabled: opticalDrives.isEnabled,
  isPresent: opticalDrives.isPresent,
  lastSeenAt: opticalDrives.lastSeenAt,
  createdAt: opticalDrives.createdAt,
  updatedAt: opticalDrives.updatedAt,
};

const detectedDiscTransitions: Readonly<
  Record<DetectedDiscStatus, readonly DetectedDiscStatus[]>
> = {
  detected: ["scanned", "rejected"],
  scanned: ["approved", "rejected"],
  approved: ["rejected"],
  archived: [],
  rejected: ["detected"],
};

function asRunningArchiveJob(job: ArchiveJob): RunningArchiveJob {
  if (job.status !== "running" || job.claimToken === null) {
    throw new DomainInvariantError("Claimed Archive Job is not running");
  }
  return job as RunningArchiveJob;
}

function asRunningEncodeJob(job: EncodeJob): RunningEncodeJob {
  if (job.status !== "running" || job.claimToken === null) {
    throw new DomainInvariantError("Claimed Encode Job is not running");
  }
  return job as RunningEncodeJob;
}

function queuedArchiveJobsForFingerprint(fingerprint: string) {
  return sql`${archiveJobs.status} = 'queued'
    and ${archiveJobs.detectedDiscId} in (
      select ${detectedDiscs.id}
      from ${detectedDiscs}
      where ${detectedDiscs.fingerprint} = ${fingerprint}
    )`;
}

const archiveUsesCurrentDvdContentId = sql<boolean>`
  length(${originalDiscArchives.fingerprint}) = 71
  and substr(${originalDiscArchives.fingerprint}, 1, 7) = 'sha256:'
  and substr(${originalDiscArchives.fingerprint}, 8) not glob '*[^0-9a-f]*'
`;

const detectedDiscUsesCurrentDvdContentId = sql<boolean>`
  length(${detectedDiscs.fingerprint}) = 71
  and substr(${detectedDiscs.fingerprint}, 1, 7) = 'sha256:'
  and substr(${detectedDiscs.fingerprint}, 8) not glob '*[^0-9a-f]*'
`;

const unresolvedLegacyDvdArchiveIdentity = and(
  eq(originalDiscArchives.discKind, "dvd"),
  sql`not (${archiveUsesCurrentDvdContentId})`,
  sql<boolean>`not exists (
      select 1
      from ${originalDiscArchiveContentIds}
      where ${originalDiscArchiveContentIds.originalDiscArchiveId} = ${originalDiscArchives.id}
    )`,
);

function nextCatalogMutationTimestamp(timestamp: Date) {
  // Review restoration uses updatedAt as a compare-and-set version. Advance it
  // even when the wall clock is frozen or moves backward.
  return sql`max(${originalDiscArchives.updatedAt} + 1, ${timestamp.getTime()})`;
}

export interface CreateDataAccessOptions {
  databasePath: string;
  migrationsFolder?: string;
  mediaLibraryPath?: string;
  originalsLibraryPath?: string;
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock;
  filesystemPathProbe?: FilesystemPathProbe;
}

export type { PublicationMutationRecoveryLock };

function isContainedPath(root: string, path: string): boolean {
  const relativePath = relative(root, resolve(path));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export type LegacySidecarMigrationAdapter = LegacySidecarImportAccessFactory;

function acquireMigrationLock(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.migrate.lock`;
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  const sleepState = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "EEXIST") {
        throw error;
      }
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age >= MIGRATION_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for SQLite migration lock: ${lockPath}`,
        );
      }
      Atomics.wait(sleepState, 0, 0, MIGRATION_LOCK_POLL_MS);
    }
  }
}

function openMigratedDatabase(
  databasePath: string,
  migrationsFolder: string,
  originalsLibraryPath?: string,
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock,
) {
  const releaseMigrationLock =
    databasePath === ":memory:"
      ? () => undefined
      : acquireMigrationLock(databasePath);
  let sqlite: DatabaseSync | undefined;

  try {
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.exec("PRAGMA foreign_keys = ON");
    if (sqlite.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error(
        "SQLite foreign key integrity check failed before migration",
      );
    }
    const journal = sqlite.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    if (databasePath !== ":memory:" && journal.journal_mode !== "wal") {
      throw new Error(
        `SQLite did not enable WAL mode (reported ${journal.journal_mode})`,
      );
    }
    sqlite.exec("PRAGMA synchronous = NORMAL");

    const database = drizzle({ client: sqlite });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(database, { migrationsFolder });
    if (sqlite.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error(
        "SQLite foreign key integrity check failed after migration",
      );
    }
    sqlite.exec("PRAGMA foreign_keys = ON");
    if (originalsLibraryPath !== undefined) {
      reconcileLegacyRepairCutover(
        sqlite,
        originalsLibraryPath,
        publicationMutationRecoveryLock,
      );
    }
    releaseMigrationLock();
    return { database, sqlite };
  } catch (error) {
    sqlite?.close();
    releaseMigrationLock();
    throw error;
  }
}

export function createDataAccessInternal(
  options: CreateDataAccessOptions,
): DataAccess;
export function createDataAccessInternal(
  options: CreateDataAccessOptions,
  legacySidecarMigration: LegacySidecarMigrationAdapter,
): LegacySidecarDataAccess;
export function createDataAccessInternal(
  {
    databasePath,
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
    mediaLibraryPath,
    originalsLibraryPath,
    publicationMutationRecoveryLock,
    filesystemPathProbe = createBoundedFilesystemPathProbe(),
  }: CreateDataAccessOptions,
  legacySidecarMigration?: LegacySidecarMigrationAdapter,
): DataAccess | LegacySidecarDataAccess {
  const normalizedDatabasePath = requireNonEmpty(databasePath, "databasePath");
  const normalizedOriginalsLibraryPath =
    originalsLibraryPath === undefined
      ? undefined
      : realpathSync(originalsLibraryPath);
  const originalsVerificationRoot =
    originalsLibraryPath === undefined
      ? undefined
      : {
          resolvedPath: resolve(originalsLibraryPath),
        };
  const mediaVerificationRoot =
    mediaLibraryPath === undefined
      ? undefined
      : {
          resolvedPath: resolve(mediaLibraryPath),
        };
  if (normalizedDatabasePath !== ":memory:") {
    mkdirSync(dirname(resolve(normalizedDatabasePath)), { recursive: true });
  }

  const { database, sqlite } = openMigratedDatabase(
    normalizedDatabasePath,
    migrationsFolder,
    normalizedOriginalsLibraryPath,
    publicationMutationRecoveryLock,
  );

  function now(): Date {
    return new Date();
  }

  async function inspectFilesystemPath(
    path: string,
    configuredRoot?: { resolvedPath: string },
  ): Promise<{
    verificationStatus: "accessible" | "missing" | "inaccessible" | "error";
    verificationMessage: string;
    verifiedAt: Date;
  }> {
    try {
      const inspection = await filesystemPathProbe.inspect(
        path,
        configuredRoot?.resolvedPath,
      );
      if (inspection === "unsafe") {
        return {
          verificationStatus: "error",
          verificationMessage:
            "Recorded path is outside the configured library.",
          verifiedAt: now(),
        };
      }
      if (inspection !== "file") {
        return {
          verificationStatus: "error",
          verificationMessage: "Recorded path is not a regular file.",
          verifiedAt: now(),
        };
      }
      return {
        verificationStatus: "accessible",
        verificationMessage: "File is accessible.",
        verifiedAt: now(),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          verificationStatus: "missing",
          verificationMessage: "File is missing at the recorded path.",
          verifiedAt: now(),
        };
      }
      if (code === "EACCES" || code === "EPERM") {
        return {
          verificationStatus: "inaccessible",
          verificationMessage:
            "The web process cannot access the recorded path.",
          verifiedAt: now(),
        };
      }
      return {
        verificationStatus: "error",
        verificationMessage: "Verification failed unexpectedly.",
        verifiedAt: now(),
      };
    }
  }

  function legacyCutoverFenceCondition(
    fingerprint: string,
    archivePath: string,
  ) {
    return normalizedOriginalsLibraryPath === undefined
      ? or(
          eq(legacyCutoverStagedSidecars.fingerprint, fingerprint),
          eq(legacyCutoverStagedSidecars.archivePath, archivePath),
        )
      : eq(
          legacyCutoverStagedSidecars.originalsLibraryPath,
          normalizedOriginalsLibraryPath,
        );
  }

  function optionalSafeInteger(
    value: number | null | undefined,
    field: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number | null | undefined {
    if (value === null || value === undefined) {
      return value;
    }
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new DomainInvariantError(
        `${field} must be a safe integer between ${minimum} and ${maximum}`,
      );
    }
    return value;
  }

  function requireReviewableDiscSelections(
    archiveId: OriginalDiscArchiveId,
    querySource: Pick<typeof database, "select"> = database,
  ): typeof originalDiscArchives.$inferSelect {
    const archive = requireRow(
      querySource
        .select()
        .from(originalDiscArchives)
        .where(eq(originalDiscArchives.id, archiveId))
        .get(),
      "original disc archive",
      archiveId,
    );
    if (archive.discKind !== "dvd") {
      throw new DomainInvariantError(
        "Catalog review currently requires a DVD Original Disc Archive",
      );
    }
    const scanData = requireRow(
      querySource
        .select({ scanData: detectedDiscs.scanData })
        .from(detectedDiscs)
        .where(eq(detectedDiscs.id, archive.detectedDiscId))
        .get(),
      "detected disc",
      archive.detectedDiscId,
    ).scanData;
    const duplicateLogicalSelection = querySource
      .select({ id: discSelections.id })
      .from(discSelections)
      .where(and(
        eq(discSelections.originalDiscArchiveId, archiveId),
        eq(discSelections.isCatalogActive, true),
      ))
      .groupBy(
        discSelections.kind,
        discSelections.titleNumber,
        discSelections.chapterStart,
        discSelections.chapterEnd,
      )
      .having(sql`count(*) > 1`)
      .limit(1)
      .get();
    if (duplicateLogicalSelection) {
      throw new DomainInvariantError(
        "Catalog review cannot contain duplicate logical Disc Selections",
      );
    }

    const validator = createArchivedDvdSelectionValidator(scanData);
    let lastSelectionId: DiscSelectionId | undefined;
    let selectionCount = 0;
    while (true) {
      const rows = querySource
        .select()
        .from(discSelections)
        .where(
          and(
            eq(discSelections.originalDiscArchiveId, archiveId),
            eq(discSelections.isCatalogActive, true),
            lastSelectionId === undefined
              ? undefined
              : gt(discSelections.id, lastSelectionId),
          ),
        )
        .orderBy(asc(discSelections.id))
        .limit(DISC_SELECTION_REVIEW_BATCH_SIZE)
        .all();
      for (const row of rows) {
        const selection = toDiscSelection(row);
        validator.validate(
          selection,
          { persistedSourceKey: selection.sourceKey },
        );
        selectionCount += 1;
      }
      if (rows.length < DISC_SELECTION_REVIEW_BATCH_SIZE) {
        break;
      }
      lastSelectionId = rows.at(-1)!.id;
    }
    if (selectionCount === 0) {
      throw new DomainInvariantError(
        "Catalog review requires at least one Disc Selection",
      );
    }
    return archive;
  }

  function validateDiscSelectionsOutsideWriter(
    archiveId: OriginalDiscArchiveId,
  ): typeof originalDiscArchives.$inferSelect {
    return database.transaction(
      (transaction) =>
        requireReviewableDiscSelections(archiveId, transaction),
      { behavior: "deferred" },
    );
  }

  function requireCurrentCatalogValidation(
    validatedArchive: typeof originalDiscArchives.$inferSelect,
    querySource: Pick<typeof database, "select">,
  ): typeof originalDiscArchives.$inferSelect {
    const currentArchive = querySource
      .select()
      .from(originalDiscArchives)
      .where(and(
        eq(originalDiscArchives.id, validatedArchive.id),
        eq(originalDiscArchives.updatedAt, validatedArchive.updatedAt),
      ))
      .get();
    if (currentArchive) {
      return currentArchive;
    }
    throw new DomainInvariantError(
      "Catalog changed during validation; retry the operation",
    );
  }

  /**
   * Matches an Original Disc Archive by either its stored legacy/current
   * fingerprint or a recorded current content-ID alias.
   */
  function findOriginalArchiveByFingerprintOrContentIdAlias(
    fingerprintOrContentIdAlias: string,
    querySource: Pick<typeof database, "select"> = database,
  ) {
    return querySource
      .select({
        detectedDiscId: originalDiscArchives.detectedDiscId,
        discKind: originalDiscArchives.discKind,
        id: originalDiscArchives.id,
      })
      .from(originalDiscArchives)
      .leftJoin(
        originalDiscArchiveContentIds,
        eq(
          originalDiscArchiveContentIds.originalDiscArchiveId,
          originalDiscArchives.id,
        ),
      )
      .where(
        or(
          eq(
            originalDiscArchives.fingerprint,
            fingerprintOrContentIdAlias,
          ),
          eq(
            originalDiscArchiveContentIds.contentId,
            fingerprintOrContentIdAlias,
          ),
        ),
      )
      .get();
  }

  function hasUnresolvedLegacyDvdArchiveIdentity(
    querySource: Pick<typeof database, "select"> = database,
  ): boolean {
    return querySource
      .select({ id: originalDiscArchives.id })
      .from(originalDiscArchives)
      .where(unresolvedLegacyDvdArchiveIdentity)
      .limit(1)
      .get() !== undefined;
  }

  function requireLegacyDvdArchiveIdentitiesResolved(
    discKind: (typeof detectedDiscs.$inferSelect)["discKind"],
    fingerprint: string,
    querySource: Pick<typeof database, "select"> = database,
  ): void {
    if (
      discKind === "dvd" &&
      isDvdContentId(fingerprint) &&
      hasUnresolvedLegacyDvdArchiveIdentity(querySource)
    ) {
      throw new DomainInvariantError(
        "Legacy DVD archive content identities must be reconciled before Archive Jobs can advance",
      );
    }
  }

  function reconcileLegacyDvdArchiveContentId(
    fingerprint: string,
    sizeBytes: number | undefined,
  ): void {
    if (
      sizeBytes === undefined ||
      !isDvdContentId(fingerprint) ||
      findOriginalArchiveByFingerprintOrContentIdAlias(fingerprint) !==
        undefined
    ) {
      return;
    }
    if (!isCurrentDvdContentSize(sizeBytes)) {
      throw new DomainInvariantError("DVD content size is invalid");
    }

    const unresolvedCandidates = database
      .select({
        archivePath: originalDiscArchives.archivePath,
        fingerprint: originalDiscArchives.fingerprint,
        id: originalDiscArchives.id,
        sizeBytes: originalDiscArchives.sizeBytes,
      })
      .from(originalDiscArchives)
      .where(unresolvedLegacyDvdArchiveIdentity)
      .orderBy(
        desc(sql`${originalDiscArchives.sizeBytes} = ${sizeBytes}`),
        desc(sql`${originalDiscArchives.sizeBytes} is null`),
        asc(originalDiscArchives.id),
      )
      .limit(LEGACY_ARCHIVE_RECONCILIATION_LIMIT + 1)
      .all();
    const candidates: Array<
      (typeof unresolvedCandidates)[number] & { resolvedSizeBytes: number }
    > = [];
    let candidateBytes = 0;
    for (const candidate of unresolvedCandidates) {
      if (candidates.length >= LEGACY_ARCHIVE_RECONCILIATION_LIMIT) {
        break;
      }
      let candidateSizeBytes = candidate.sizeBytes;
      if (
        candidateSizeBytes === null ||
        !isCurrentDvdContentSize(candidateSizeBytes)
      ) {
        try {
          candidateSizeBytes = readDvdArchiveFileSize(candidate.archivePath);
        } catch {
          throw new DomainInvariantError(
            "Legacy DVD archive content identity requires operator remediation because its size cannot be safely derived",
          );
        }
      }
      if (
        candidateBytes + candidateSizeBytes >
          LEGACY_ARCHIVE_RECONCILIATION_BYTES
      ) {
        break;
      }
      candidates.push({ ...candidate, resolvedSizeBytes: candidateSizeBytes });
      candidateBytes += candidateSizeBytes;
    }

    for (const candidate of candidates) {
      const candidateSizeBytes = candidate.resolvedSizeBytes;
      const hashed = hashDvdArchiveFile(
        candidate.archivePath,
        candidateSizeBytes,
      );
      database.transaction((transaction) => {
        const candidateSizeCondition = candidate.sizeBytes === null
          ? isNull(originalDiscArchives.sizeBytes)
          : eq(originalDiscArchives.sizeBytes, candidate.sizeBytes);
        const current = transaction
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(
            and(
              eq(originalDiscArchives.id, candidate.id),
              eq(originalDiscArchives.archivePath, candidate.archivePath),
              eq(originalDiscArchives.fingerprint, candidate.fingerprint),
              candidateSizeCondition,
              eq(originalDiscArchives.discKind, "dvd"),
            ),
          )
          .get();
        if (
          !current ||
          !dvdArchiveFileMatchesIdentity(
            candidate.archivePath,
            hashed.identity,
          )
        ) {
          throw new DomainInvariantError(
            "Legacy DVD archive changed during content identity reconciliation",
          );
        }
        if (candidate.sizeBytes !== candidateSizeBytes) {
          const updated = transaction
            .update(originalDiscArchives)
            .set({ sizeBytes: candidateSizeBytes, updatedAt: now() })
            .where(
              and(
                eq(originalDiscArchives.id, candidate.id),
                candidateSizeCondition,
              ),
            )
            .returning({ id: originalDiscArchives.id })
            .get();
          if (!updated) {
            throw new DomainInvariantError(
              "Legacy DVD archive changed during content identity reconciliation",
            );
          }
        }
        const archiveWithFingerprint = transaction
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(eq(originalDiscArchives.fingerprint, hashed.contentId))
          .get();
        if (
          archiveWithFingerprint &&
          archiveWithFingerprint.id !== candidate.id
        ) {
          throw new DomainInvariantError(
            "DVD content identity is already stored as a different Original Disc Archive fingerprint",
          );
        }
        transaction
          .insert(originalDiscArchiveContentIds)
          .values({
            originalDiscArchiveId: candidate.id,
            contentId: hashed.contentId,
          })
          .onConflictDoNothing()
          .run();
        const archiveForContentId = transaction
          .select({
            originalDiscArchiveId:
              originalDiscArchiveContentIds.originalDiscArchiveId,
          })
          .from(originalDiscArchiveContentIds)
          .where(
            eq(
              originalDiscArchiveContentIds.contentId,
              hashed.contentId,
            ),
          )
          .get();
        if (archiveForContentId?.originalDiscArchiveId !== candidate.id) {
          throw new DomainInvariantError(
            "DVD content identity is already assigned to a different Original Disc Archive",
          );
        }
      }, { behavior: "immediate" });
      if (hashed.contentId === fingerprint) {
        return;
      }
    }
    if (hasUnresolvedLegacyDvdArchiveIdentity()) {
      throw new DomainInvariantError(
        "Legacy DVD archive reconciliation made bounded progress; retry detection to continue",
      );
    }
  }

  function requireEncodingProfileInDomain(
    querySource: Pick<typeof database, "select">,
    id: EncodingProfileId,
    mediaDomain: MediaDomain,
  ): typeof encodingProfiles.$inferSelect {
    const profile = querySource
      .select()
      .from(encodingProfiles)
      .where(
        and(
          eq(encodingProfiles.id, id),
          eq(encodingProfiles.mediaDomain, mediaDomain),
        ),
      )
      .get();
    if (profile) {
      return profile;
    }

    const existing = querySource
      .select({ mediaDomain: encodingProfiles.mediaDomain })
      .from(encodingProfiles)
      .where(eq(encodingProfiles.id, id))
      .get();
    if (existing) {
      throw new DomainInvariantError(
        "Encoding Profile does not belong to the requested media domain",
      );
    }
    throw new RecordNotFoundError("encoding profile", id);
  }

  const insertApprovedArchiveJob = sqlite.prepare(`
    insert into archive_jobs (
      id, detected_disc_id, priority, created_at, updated_at
    )
    select ?, detected_discs.id, ?, ?, ?
    from detected_discs
    where detected_discs.id = ?
      and detected_discs.status = 'approved'
      and not exists (
        select 1
        from original_disc_archives
        where original_disc_archives.fingerprint = detected_discs.fingerprint
          or exists (
            select 1
            from original_disc_archive_content_ids
            where original_disc_archive_content_ids.original_disc_archive_id = original_disc_archives.id
              and original_disc_archive_content_ids.content_id = detected_discs.fingerprint
          )
      )
      and not (
        detected_discs.disc_kind = 'dvd'
        and length(detected_discs.fingerprint) = 71
        and substr(detected_discs.fingerprint, 1, 7) = 'sha256:'
        and substr(detected_discs.fingerprint, 8) not glob '*[^0-9a-f]*'
        and exists (
          select 1
          from original_disc_archives as unresolved_legacy_archives
          where unresolved_legacy_archives.disc_kind = 'dvd'
            and not (
              length(unresolved_legacy_archives.fingerprint) = 71
              and substr(unresolved_legacy_archives.fingerprint, 1, 7) = 'sha256:'
              and substr(unresolved_legacy_archives.fingerprint, 8) not glob '*[^0-9a-f]*'
            )
            and not exists (
              select 1
              from original_disc_archive_content_ids
              where original_disc_archive_content_ids.original_disc_archive_id = unresolved_legacy_archives.id
            )
        )
      )
    on conflict (detected_disc_id) do nothing
  `);

  const listArchiveJobs = createJobList<ArchiveJob>({
    readQueue(statuses) {
      return database
        .select()
        .from(archiveJobs)
        .where(
          statuses?.length
            ? inArray(archiveJobs.status, statuses)
            : undefined,
        )
        .orderBy(desc(archiveJobs.priority), asc(archiveJobs.createdAt))
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(archiveJobs)
        .where(
          statuses?.length
            ? inArray(archiveJobs.status, statuses)
            : undefined,
        )
        .orderBy(desc(archiveJobs.updatedAt), desc(archiveJobs.id))
        .limit(limit)
        .all();
    },
  });

  type ArchiveJobCompletion =
    | OriginalDiscArchiveId
    | { archivePath: string; sizeBytes: number };

  const archiveJobAdapter = {
    recordType: "archive job",
    find: (id) =>
      database.select().from(archiveJobs).where(eq(archiveJobs.id, id)).get(),
    list: listArchiveJobs,
    claim: (workerId, token, timestamp, eligibility) => {
      const eligibilityCondition = eligibility
        ? and(
            eq(detectedDiscs.opticalDriveId, eligibility.opticalDriveId),
            eq(
              detectedDiscs.fingerprint,
              requireNonEmpty(eligibility.fingerprint, "fingerprint"),
            ),
          )
        : sql`1`;
      const nextApprovedJobId = sql<ArchiveJobId>`(
        select ${archiveJobs.id}
        from ${archiveJobs}
        inner join ${detectedDiscs}
          on ${detectedDiscs.id} = ${archiveJobs.detectedDiscId}
        inner join ${opticalDrives}
          on ${opticalDrives.id} = ${detectedDiscs.opticalDriveId}
        where ${archiveJobs.status} = 'queued'
          and ${detectedDiscs.status} = 'approved'
          and ${opticalDrives.isEnabled} = true
          and ${opticalDrives.isPresent} = true
          and ${eligibilityCondition}
          and (
            ${detectedDiscs.discKind} <> 'dvd'
            or not (${detectedDiscUsesCurrentDvdContentId})
            or not exists (
              select 1
              from ${originalDiscArchives}
              where ${unresolvedLegacyDvdArchiveIdentity}
            )
          )
          and not exists (
            select 1
            from ${originalDiscArchives}
            where ${originalDiscArchives.fingerprint} = ${detectedDiscs.fingerprint}
              or exists (
                select 1
                from ${originalDiscArchiveContentIds}
                where ${originalDiscArchiveContentIds.originalDiscArchiveId} = ${originalDiscArchives.id}
                  and ${originalDiscArchiveContentIds.contentId} = ${detectedDiscs.fingerprint}
              )
          )
          and not exists (
            select 1
            from archive_jobs as running_archive_jobs
            inner join detected_discs as running_detected_discs
              on running_detected_discs.id = running_archive_jobs.detected_disc_id
            where running_archive_jobs.status = 'running'
              and (
                running_detected_discs.fingerprint = ${detectedDiscs.fingerprint}
                or running_detected_discs.optical_drive_id = ${detectedDiscs.opticalDriveId}
              )
          )
        order by ${archiveJobs.priority} desc,
          ${archiveJobs.createdAt} asc,
          ${archiveJobs.id} asc
        limit 1
      )`;
      const claimed = database
        .update(archiveJobs)
        .set({
          status: "running",
          claimedBy: workerId,
          claimToken: token,
          claimedAt: timestamp,
          startedAt: timestamp,
          errorMessage: null,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(archiveJobs.status, "queued"),
            eq(archiveJobs.id, nextApprovedJobId),
          ),
        )
        .returning()
        .get();
      return claimed ? asRunningArchiveJob(claimed) : undefined;
    },
    isAttemptCurrent: (current, _claim, timestamp) =>
      current.updatedAt.getTime() >
      timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
    updateAttempt: (claim, update, completion) => {
      const attemptCondition = and(
        eq(archiveJobs.id, claim.id),
        eq(archiveJobs.status, "running"),
        eq(archiveJobs.claimToken, claim.claimToken),
        gt(
          archiveJobs.updatedAt,
          new Date(
            update.updatedAt.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
          ),
        ),
      );
      if (update.status !== "completed") {
        return database
          .update(archiveJobs)
          .set(update)
          .where(attemptCondition)
          .returning()
          .get();
      }
      if (!completion) {
        throw new DomainInvariantError(
          "Completing an Archive Job requires an Original Disc Archive",
        );
      }
      if (typeof completion !== "string") {
        const disc = requireRow(
          database
            .select({
              discKind: detectedDiscs.discKind,
              fingerprint: detectedDiscs.fingerprint,
            })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.id, claim.detectedDiscId))
            .get(),
          "detected disc",
          claim.detectedDiscId,
        );
        if (disc.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            disc.fingerprint,
            completion.sizeBytes,
          );
        }
      }

      return database.transaction((transaction) => {
        const current = transaction
          .select()
          .from(archiveJobs)
          .where(attemptCondition)
          .get();
        if (!current) {
          return undefined;
        }
        if (typeof completion !== "string") {
          const disc = requireRow(
            transaction
              .select()
              .from(detectedDiscs)
              .where(eq(detectedDiscs.id, current.detectedDiscId))
              .get(),
            "detected disc",
            current.detectedDiscId,
          );
          if (disc.status !== "approved") {
            throw new InvalidStatusTransitionError(
              "detected disc",
              disc.status,
              "archived",
            );
          }
          if (
            findOriginalArchiveByFingerprintOrContentIdAlias(
              disc.fingerprint,
              transaction,
            )
          ) {
            throw new DomainInvariantError(
              "DVD content already has Original Disc Archive provenance",
            );
          }
          requireLegacyDvdArchiveIdentitiesResolved(
            disc.discKind,
            disc.fingerprint,
            transaction,
          );
          const archivePath = requireNonEmpty(
            completion.archivePath,
            "archivePath",
          );
          const archive = requireRow(
            transaction
              .insert(originalDiscArchives)
              .values({
                id: newId<OriginalDiscArchiveId>(),
                detectedDiscId: disc.id,
                discKind: disc.discKind,
                archiveFormat: "iso",
                archivePath,
                fingerprint: disc.fingerprint,
                legacyCutoverPending:
                  transaction
                    .select({
                      sidecarPath:
                        legacyCutoverStagedSidecars.sidecarPath,
                    })
                    .from(legacyCutoverStagedSidecars)
                    .where(legacyCutoverFenceCondition(
                      disc.fingerprint,
                      archivePath,
                    ))
                    .limit(1)
                    .get() !== undefined,
                sizeBytes: requirePositiveSafeInteger(
                  completion.sizeBytes,
                  "sizeBytes",
                ),
                archivedAt: update.updatedAt,
                createdAt: update.updatedAt,
                updatedAt: update.updatedAt,
              })
              .returning()
              .get(),
            "original disc archive",
            disc.id,
          );
          transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: update.updatedAt })
            .where(eq(detectedDiscs.fingerprint, disc.fingerprint))
            .run();
          transaction
            .delete(archiveJobs)
            .where(queuedArchiveJobsForFingerprint(disc.fingerprint))
            .run();
          return transaction
            .update(archiveJobs)
            .set({ ...update, originalDiscArchiveId: archive.id })
            .where(attemptCondition)
            .returning()
            .get();
        }
        const matchingArchive = transaction
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(
            and(
              eq(originalDiscArchives.id, completion),
              eq(
                originalDiscArchives.detectedDiscId,
                current.detectedDiscId,
              ),
            ),
          )
          .get();
        if (!matchingArchive) {
          throw new DomainInvariantError(
            "Archive Job result must belong to the job's Detected Disc",
          );
        }
        return transaction
          .update(archiveJobs)
          .set({ ...update, originalDiscArchiveId: completion })
          .where(attemptCondition)
          .returning()
          .get();
      }, { behavior: "immediate" });
    },
    requeue: (id, expectedStatus, _current, update) =>
      database
        .update(archiveJobs)
        .set(update)
        .where(
          and(
            eq(archiveJobs.id, id),
            eq(archiveJobs.status, expectedStatus),
            exists(
              database
                .select({ id: detectedDiscs.id })
                .from(detectedDiscs)
                .where(
                  and(
                    eq(detectedDiscs.id, archiveJobs.detectedDiscId),
                    eq(detectedDiscs.status, "approved"),
                    notExists(
                      database
                        .select({ id: originalDiscArchives.id })
                        .from(originalDiscArchives)
                        .where(
                          or(
                            eq(
                              originalDiscArchives.fingerprint,
                              detectedDiscs.fingerprint,
                            ),
                            exists(
                              database
                                .select({
                                  originalDiscArchiveId:
                                    originalDiscArchiveContentIds.originalDiscArchiveId,
                                })
                                .from(originalDiscArchiveContentIds)
                                .where(
                                  and(
                                    eq(
                                      originalDiscArchiveContentIds.originalDiscArchiveId,
                                      originalDiscArchives.id,
                                    ),
                                    eq(
                                      originalDiscArchiveContentIds.contentId,
                                      detectedDiscs.fingerprint,
                                    ),
                                  ),
                                ),
                            ),
                          ),
                        ),
                    ),
                  ),
                ),
            ),
          ),
        )
        .returning()
        .get(),
  } satisfies JobQueueAdapter<
    ArchiveJob,
    RunningArchiveJob,
    ArchiveJobId,
    ArchiveJobClaimToken,
    ArchiveJobCompletion,
    void,
    {
      opticalDriveId: OpticalDriveId;
      fingerprint: string;
    }
  >;

  type EncodeRequeueOptions = {
    outputPath?: string;
    priority?: number;
  };

  const listEncodeJobs = createJobList<EncodeJob>({
    readQueue(statuses) {
      return database
        .select()
        .from(encodeJobs)
        .where(
          statuses?.length ? inArray(encodeJobs.status, statuses) : undefined,
        )
        .orderBy(desc(encodeJobs.priority), asc(encodeJobs.createdAt))
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(encodeJobs)
        .where(
          statuses?.length ? inArray(encodeJobs.status, statuses) : undefined,
        )
        .orderBy(desc(encodeJobs.updatedAt), desc(encodeJobs.id))
        .limit(limit)
        .all();
    },
  });

  const encodeAttemptCondition = (
    claim: RunningEncodeJob,
    timestamp: Date,
  ) =>
    and(
      eq(encodeJobs.id, claim.id),
      eq(encodeJobs.status, "running"),
      eq(encodeJobs.claimToken, claim.claimToken),
      gt(
        encodeJobs.updatedAt,
        new Date(timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS),
      ),
      exists(
        database
          .select({ id: discSelections.id })
          .from(discSelections)
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .where(
            and(
              eq(discSelections.id, encodeJobs.discSelectionId),
              eq(discSelections.isCatalogActive, true),
              eq(originalDiscArchives.legacyCutoverPending, false),
            ),
          ),
      ),
    );

  const encodeJobAdapter = {
    recordType: "encode job",
    find: (id) =>
      database.select().from(encodeJobs).where(eq(encodeJobs.id, id)).get(),
    list: listEncodeJobs,
    claim: (workerId, token, timestamp) => {
      const nextReviewedJob = database
        .select({ id: encodeJobs.id })
        .from(encodeJobs)
        .innerJoin(
          discSelections,
          eq(discSelections.id, encodeJobs.discSelectionId),
        )
        .innerJoin(
          originalDiscArchives,
          eq(
            originalDiscArchives.id,
            discSelections.originalDiscArchiveId,
          ),
        )
        .where(
          and(
            eq(encodeJobs.status, "queued"),
            isNull(encodeJobs.partialCleanupClaimToken),
            isNull(encodeJobs.partialCleanupOutputPath),
            isNull(encodeJobs.partialCleanupLeaseToken),
            eq(discSelections.isCatalogActive, true),
            isNotNull(originalDiscArchives.catalogReviewedAt),
            eq(originalDiscArchives.legacyCutoverPending, false),
          ),
        )
        .orderBy(
          desc(encodeJobs.priority),
          asc(encodeJobs.createdAt),
          asc(encodeJobs.id),
        )
        .limit(1);
      const claimed = database
        .update(encodeJobs)
        .set({
          status: "running",
          claimedBy: workerId,
          claimToken: token,
          claimedAt: timestamp,
          startedAt: timestamp,
          errorMessage: null,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(encodeJobs.status, "queued"),
            eq(encodeJobs.id, nextReviewedJob),
          ),
        )
        .returning()
        .get();
      return claimed ? asRunningEncodeJob(claimed) : undefined;
    },
    isAttemptCurrent: (current, _claim, timestamp) =>
      current.updatedAt.getTime() >
      timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
    updateAttempt: (claim, update, _completion, failureOptions) =>
      database
        .update(encodeJobs)
        .set({
          ...update,
          ...(update.status === "completed"
            ? {
                progressEtaSeconds: null,
                replaceExistingOutput: false,
                replacementOutputIdentity: null,
              }
            : update.status === "failed"
              ? {
                  progressEtaSeconds: null,
                  ...(failureOptions?.preserveReplacementAuthority
                    ? {}
                    : {
                        replaceExistingOutput: false,
                        replacementOutputIdentity: null,
                      }),
                }
              : {}),
        })
        .where(encodeAttemptCondition(claim, update.updatedAt))
        .returning()
        .get(),
    updateProgressAttempt: (claim, update, details, failureOptions) =>
      database
        .update(encodeJobs)
        .set({
          ...update,
          progressPhase: details.phase,
          progressEtaSeconds:
            update.status === "failed" ? null : details.etaSeconds,
          ...(update.status === "failed" &&
            !failureOptions?.preserveReplacementAuthority
            ? {
                replaceExistingOutput: false,
                replacementOutputIdentity: null,
              }
            : {}),
        })
        .where(encodeAttemptCondition(claim, update.updatedAt))
        .returning()
        .get(),
    progressDetailsChanged: (current, previous) =>
      current?.phase !== previous?.phase,
    requeue: (id, expectedStatus, current, update, options) => {
      const keepsOutputPath =
        options?.outputPath === undefined ||
        options.outputPath === current.outputPath;
      const preservesFailedReplacement =
        expectedStatus === "failed" &&
        keepsOutputPath &&
        current.replaceExistingOutput;
      return database
        .update(encodeJobs)
        .set({
          ...update,
          outputPath: options?.outputPath,
          priority: options?.priority,
          progressPhase: null,
          progressEtaSeconds: null,
          replaceExistingOutput:
            (expectedStatus === "completed" && keepsOutputPath) ||
            preservesFailedReplacement,
          replacementOutputIdentity: preservesFailedReplacement
            ? current.replacementOutputIdentity
            : null,
          ...(keepsOutputPath
            ? {}
            : {
                verificationStatus: null,
                verificationMessage: null,
                verifiedAt: null,
              }),
        })
        .where(
          and(
            eq(encodeJobs.id, id),
            eq(encodeJobs.status, expectedStatus),
            isNull(encodeJobs.partialCleanupOutputPath),
            isNull(encodeJobs.partialCleanupClaimToken),
            isNull(encodeJobs.partialCleanupLeaseToken),
            eq(encodeJobs.publicationPending, false),
            exists(
              database
                .select({ id: discSelections.id })
                .from(discSelections)
                .innerJoin(
                  originalDiscArchives,
                  eq(
                    originalDiscArchives.id,
                    discSelections.originalDiscArchiveId,
                  ),
                )
                .where(
                  and(
                    eq(discSelections.id, encodeJobs.discSelectionId),
                    eq(discSelections.isCatalogActive, true),
                    isNotNull(originalDiscArchives.catalogReviewedAt),
                    eq(originalDiscArchives.legacyCutoverPending, false),
                  ),
                ),
            ),
          ),
        )
        .returning()
        .get();
    },
  } satisfies JobQueueAdapter<
    EncodeJob,
    RunningEncodeJob,
    EncodeJobId,
    EncodeJobClaimToken,
    void,
    EncodeRequeueOptions,
    void,
    Pick<EncodeJobProgress, "etaSeconds" | "phase">,
    EncodeJobFailureOptions
  >;

  const archiveJobQueue = createJobQueueController({
    adapter: archiveJobAdapter,
    createToken: () => newId<ArchiveJobClaimToken>(),
    now,
    requeueFrom: ["failed"],
  });
  const encodeJobQueue = createJobQueueController({
    adapter: encodeJobAdapter,
    createToken: () => newId<EncodeJobClaimToken>(),
    now,
    requeueFrom: ["failed", "completed"],
  });

  const detectedDiscConditionFor = (
    statuses: DetectedDiscStatus[] | undefined,
    options: DetectedDiscListOptions | undefined,
  ) => {
    const conditions = [
      statuses?.length ? inArray(detectedDiscs.status, statuses) : undefined,
      options?.ids ? inArray(detectedDiscs.id, [...options.ids]) : undefined,
    ].filter((condition) => condition !== undefined);
    return conditions.length > 0 ? and(...conditions) : undefined;
  };
  const listDetectedDiscRecords = createBoundedChronologicalList<
    typeof detectedDiscs.$inferSelect,
    DetectedDiscStatus,
    DetectedDiscListOptions
  >({
    activeStatuses: ["detected", "scanned", "approved"],
    historyStatuses: ["archived", "rejected"],
    chronologicalAt: (disc) => disc.detectedAt,
    readAll(statuses, options) {
      return database
        .select()
        .from(detectedDiscs)
        .where(detectedDiscConditionFor(statuses, options))
        .orderBy(asc(detectedDiscs.detectedAt), asc(detectedDiscs.id))
        .all();
    },
    readNewest(statuses, limit, options) {
      return database
        .select()
        .from(detectedDiscs)
        .where(detectedDiscConditionFor(statuses, options))
        .orderBy(desc(detectedDiscs.detectedAt), desc(detectedDiscs.id))
        .limit(limit)
        .all();
    },
  });

  function approveDetectedDisc(input: {
    detectedDiscId: DetectedDiscId;
    priority?: number;
    allowAlreadyApproved: boolean;
  }) {
    const timestamp = now();
    return database.transaction((transaction) => {
      const disc = requireRow(
        transaction
          .select()
          .from(detectedDiscs)
          .where(eq(detectedDiscs.id, input.detectedDiscId))
          .get(),
        "detected disc",
        input.detectedDiscId,
      );
      if (
        disc.status !== "scanned" &&
        !(input.allowAlreadyApproved && disc.status === "approved")
      ) {
        throw new InvalidStatusTransitionError(
          "detected disc",
          disc.status,
          "approved",
        );
      }
      const contentIdentityArchive =
        findOriginalArchiveByFingerprintOrContentIdAlias(
          disc.fingerprint,
          transaction,
        );
      if (contentIdentityArchive) {
        throw new DomainInvariantError(
          "A Detected Disc with existing archive provenance cannot be approved",
        );
      }
      requireLegacyDvdArchiveIdentitiesResolved(
        disc.discKind,
        disc.fingerprint,
        transaction,
      );
      const approvedDisc = disc.status === "scanned"
        ? requireRow(
            transaction
              .update(detectedDiscs)
              .set({ status: "approved", updatedAt: timestamp })
              .where(
                and(
                  eq(detectedDiscs.id, disc.id),
                  eq(detectedDiscs.status, "scanned"),
                ),
              )
              .returning()
              .get(),
            "detected disc",
            disc.id,
          )
        : disc;

      const existing = transaction
        .select()
        .from(archiveJobs)
        .where(eq(archiveJobs.detectedDiscId, disc.id))
        .get();
      if (!existing) {
        const job = requireRow(
          transaction
            .insert(archiveJobs)
            .values({
              id: newId<ArchiveJobId>(),
              detectedDiscId: disc.id,
              priority: input.priority ?? 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
            .get(),
          "archive job",
          disc.id,
        );
        return { disc: approvedDisc, job };
      }
      if (existing.status === "failed") {
        const job = requireRow(
          transaction
            .update(archiveJobs)
            .set({
              status: "queued",
              priority: input.priority ?? existing.priority,
              progressPercent: 0,
              claimedBy: null,
              claimToken: null,
              claimedAt: null,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, existing.id),
                eq(archiveJobs.status, "failed"),
              ),
            )
            .returning()
            .get(),
          "archive job",
          existing.id,
        );
        return { disc: approvedDisc, job };
      }
      if (existing.status === "completed") {
        throw new DomainInvariantError(
          "A completed Archive Job cannot be approved without archive provenance",
        );
      }
      if (
        input.priority !== undefined &&
        existing.status === "queued" &&
        input.priority !== existing.priority
      ) {
        const job = requireRow(
          transaction
            .update(archiveJobs)
            .set({ priority: input.priority, updatedAt: timestamp })
            .where(
              and(
                eq(archiveJobs.id, existing.id),
                eq(archiveJobs.status, "queued"),
              ),
            )
            .returning()
            .get(),
          "archive job",
          existing.id,
        );
        return { disc: approvedDisc, job };
      }
      return { disc: approvedDisc, job: existing };
    }, { behavior: "immediate" });
  }

  const access: LegacySidecarDataAccess = {
    readConsistentSnapshot(read) {
      const snapshotAccess: ConsistentReadAccess = {
        catalog: {
          listOpticalDrives: (options) =>
            access.catalog.listOpticalDrives(options),
          listDetectedDiscs: (statuses, options) =>
            access.catalog.listDetectedDiscs(statuses, options),
          listOriginalDiscArchives: (options) =>
            access.catalog.listOriginalDiscArchives(options),
          listMediaItems: (options) => access.catalog.listMediaItems(options),
          listDiscSelections: (options) =>
            access.catalog.listDiscSelections(options),
        },
        encodingProfiles: {
          list: (input) => access.encodingProfiles.list(input),
        },
        archiveJobs: {
          list: (statuses, options) => access.archiveJobs.list(statuses, options),
        },
        encodeJobs: {
          list: (statuses, options) => access.encodeJobs.list(statuses, options),
        },
      };
      sqlite.exec("BEGIN");
      try {
        const result = read(snapshotAccess);
        if (result instanceof Promise) {
          throw new DomainInvariantError(
            "Consistent snapshot reads must be synchronous",
          );
        }
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },

    checkHealth() {
      const version = sqlite
        .prepare("select sqlite_version() as version")
        .get() as { version: string };
      const journal = sqlite.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      const timeout = sqlite.prepare("PRAGMA busy_timeout").get() as {
        timeout: number;
      };

      return {
        status: "ok",
        sqliteVersion: version.version,
        journalMode: journal.journal_mode,
        busyTimeoutMs: timeout.timeout,
      };
    },

    catalog: {
      reconcileOpticalDrives(discovered) {
        const timestamp = now();

        return database.transaction((transaction) => {
          const existingDrives = transaction
            .select({
              devicePath: opticalDrives.devicePath,
              configurationDefaultResolved:
                opticalDrives.configurationDefaultResolved,
              isConfiguredTarget: opticalDrives.isConfiguredTarget,
              isPresent: opticalDrives.isPresent,
              serialNumber: opticalDrives.serialNumber,
              vendor: opticalDrives.vendor,
              product: opticalDrives.product,
            })
            .from(opticalDrives)
            .all();
          const plan = planOpticalDriveReconciliation(
            discovered,
            existingDrives,
          );
          if (plan.configuredTargetPath !== undefined) {
            transaction
              .update(opticalDrives)
              .set({ isConfiguredTarget: false })
              .where(eq(opticalDrives.isConfiguredTarget, true))
              .run();
          }
          transaction
            .update(opticalDrives)
            .set({ isPresent: false, updatedAt: timestamp })
            .where(eq(opticalDrives.isPresent, true))
            .run();

          for (const decision of plan.drives) {
            const { drive } = decision;
            transaction
              .insert(opticalDrives)
              .values({
                id: newId<OpticalDriveId>(),
                devicePath: drive.devicePath,
                displayName: drive.displayName,
                vendor: drive.vendor,
                product: drive.product,
                serialNumber: drive.serialNumber,
                ...decision.insertAuthorization,
                isConfiguredTarget: drive.isConfiguredDevice,
                isPresent: true,
                lastSeenAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .onConflictDoUpdate({
                target: opticalDrives.devicePath,
                set: {
                  displayName: drive.displayName,
                  vendor: drive.vendor ?? null,
                  product: drive.product ?? null,
                  serialNumber: drive.serialNumber ?? null,
                  ...(drive.isConfiguredDevice
                    ? { isConfiguredTarget: true }
                    : {}),
                  ...decision.authorizationUpdate,
                  isPresent: true,
                  lastSeenAt: timestamp,
                  updatedAt: timestamp,
                },
              })
              .run();
          }

          return transaction
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .orderBy(asc(opticalDrives.devicePath))
            .all();
        }, { behavior: "immediate" });
      },

      upsertOpticalDrive(input) {
        const timestamp = now();
        const devicePath = requireNonEmpty(input.devicePath, "devicePath");
        const inserted = database
          .insert(opticalDrives)
          .values({
            id: newId<OpticalDriveId>(),
            devicePath,
            displayName: input.displayName,
            vendor: input.vendor,
            product: input.product,
            serialNumber: input.serialNumber,
            isEnabled: input.isEnabled ?? false,
            configurationDefaultResolved: true,
            isPresent: input.isPresent,
            lastSeenAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: opticalDrives.devicePath,
            set: {
              displayName: input.displayName,
              vendor: input.vendor,
              product: input.product,
              serialNumber: input.serialNumber,
              isEnabled: input.isEnabled,
              ...(input.isEnabled !== undefined
                ? { configurationDefaultResolved: true }
                : {}),
              isPresent: input.isPresent,
              lastSeenAt: timestamp,
              updatedAt: timestamp,
            },
          })
          .returning(opticalDriveSelection)
          .get();
        return requireRow(inserted, "optical drive", devicePath);
      },

      listOpticalDrives(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const condition = options?.ids
          ? inArray(opticalDrives.id, [...options.ids])
          : undefined;
        if (options?.historicalLimit !== undefined) {
          const current = database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(
              and(
                condition,
                or(
                  eq(opticalDrives.isPresent, true),
                  eq(opticalDrives.isEnabled, true),
                ),
              ),
            )
            .all();
          const history = database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(
              and(
                condition,
                eq(opticalDrives.isPresent, false),
                eq(opticalDrives.isEnabled, false),
              ),
            )
            .orderBy(
              desc(opticalDrives.lastSeenAt),
              desc(opticalDrives.id),
            )
            .limit(
              requirePositiveSafeInteger(
                options.historicalLimit,
                "historicalLimit",
              ),
            )
            .all();
          return [...current, ...history].sort((left, right) =>
            left.devicePath.localeCompare(right.devicePath),
          );
        }
        if (options?.limit !== undefined) {
          return database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(condition)
            .orderBy(desc(opticalDrives.lastSeenAt), desc(opticalDrives.id))
            .limit(requirePositiveSafeInteger(options.limit, "limit"))
            .all()
            .reverse();
        }
        return database
          .select(opticalDriveSelection)
          .from(opticalDrives)
          .where(condition)
          .orderBy(asc(opticalDrives.devicePath))
          .all();
      },

      registerDetectedDisc(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
        const scanData = normalizeDetectedDiscScan({
          discKind: input.discKind,
          fingerprint,
          scanData: input.scanData,
        });
        if (input.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            fingerprint,
            input.sizeBytes,
          );
        }
        return database.transaction((transaction) => {
          const contentIdentityArchive =
            findOriginalArchiveByFingerprintOrContentIdAlias(
              fingerprint,
              transaction,
            );
          const matchingObservation = transaction
            .select({ discKind: detectedDiscs.discKind })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.fingerprint, fingerprint))
            .get();
          const existing = transaction
            .select({
              id: detectedDiscs.id,
              discKind: detectedDiscs.discKind,
              scanData: detectedDiscs.scanData,
              status: detectedDiscs.status,
              volumeLabel: detectedDiscs.volumeLabel,
              detectedAt: detectedDiscs.detectedAt,
              updatedAt: detectedDiscs.updatedAt,
            })
            .from(detectedDiscs)
            .where(
              and(
                eq(detectedDiscs.opticalDriveId, input.opticalDriveId),
                eq(detectedDiscs.fingerprint, fingerprint),
              ),
            )
            .get();
          const { observationChanged, statusChanged } =
            evaluateDetectedDiscRediscovery({
              discKind: input.discKind,
              existing,
              fingerprintObservationDiscKind: matchingObservation?.discKind,
              isNewMediumObservation: input.isNewMediumObservation,
              matchingArchive: contentIdentityArchive,
              scanData,
              volumeLabel: input.volumeLabel,
            });

          transaction
            .insert(detectedDiscs)
            .values({
              id: newId<DetectedDiscId>(),
              opticalDriveId: input.opticalDriveId,
              discKind: input.discKind,
              fingerprint,
              volumeLabel: input.volumeLabel,
              scanData,
              status: contentIdentityArchive ? "archived" : "detected",
              detectedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoNothing({
              target: [detectedDiscs.opticalDriveId, detectedDiscs.fingerprint],
            })
            .run();

          const registered = transaction
            .update(detectedDiscs)
            .set({
              discKind: input.discKind,
              volumeLabel: input.volumeLabel,
              scanData,
              ...(contentIdentityArchive
                ? { status: "archived" as const }
                : {}),
              ...(observationChanged
                ? { detectedAt: timestamp, updatedAt: timestamp }
                : statusChanged
                  ? { updatedAt: timestamp }
                  : {}),
            })
            .where(
              and(
                eq(detectedDiscs.opticalDriveId, input.opticalDriveId),
                eq(detectedDiscs.fingerprint, fingerprint),
                contentIdentityArchive
                  ? undefined
                  : or(
                      eq(detectedDiscs.discKind, input.discKind),
                      and(
                        ne(detectedDiscs.status, "archived"),
                        notExists(
                          transaction
                            .select({ id: originalDiscArchives.id })
                            .from(originalDiscArchives)
                            .where(
                              eq(
                                originalDiscArchives.detectedDiscId,
                                detectedDiscs.id,
                              ),
                            ),
                        ),
                      ),
                    ),
              ),
            )
            .returning()
            .get();
          if (!registered) {
            throw new DomainInvariantError(
              "Rediscovery cannot change a Detected Disc kind with archive provenance",
            );
          }
          if (contentIdentityArchive) {
            transaction
              .delete(archiveJobs)
              .where(queuedArchiveJobsForFingerprint(fingerprint))
              .run();
          }
          return registered;
        }, { behavior: "immediate" });
      },

      listDetectedDiscs(statuses, options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        return listDetectedDiscRecords(statuses, options);
      },

      updateDetectedDiscStatus(id, status) {
        if (status === "approved") {
          return approveDetectedDisc({
            detectedDiscId: id,
            allowAlreadyApproved: false,
          }).disc;
        }
        const allowedFrom = Object.entries(detectedDiscTransitions)
          .filter(([, targets]) => targets.includes(status))
          .map(([source]) => source as DetectedDiscStatus);
        return database.transaction((transaction) => {
          const updated = transaction
            .update(detectedDiscs)
            .set({ status, updatedAt: now() })
            .where(
              and(
                eq(detectedDiscs.id, id),
                inArray(detectedDiscs.status, allowedFrom),
              ),
            )
            .returning()
            .get();
          if (!updated) {
            const current = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, id))
                .get(),
              "detected disc",
              id,
            );
            throw new InvalidStatusTransitionError(
              "detected disc",
              current.status,
              status,
            );
          }
          transaction
            .delete(archiveJobs)
            .where(
              and(
                eq(archiveJobs.detectedDiscId, id),
                eq(archiveJobs.status, "queued"),
              ),
            )
            .run();
          return updated;
        });
      },

      createOriginalDiscArchive(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
        const archivePath = requireNonEmpty(input.archivePath, "archivePath");
        if (input.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            fingerprint,
            input.sizeBytes,
          );
        }
        return database.transaction((transaction) => {
          if (
            findOriginalArchiveByFingerprintOrContentIdAlias(
              fingerprint,
              transaction,
            )
          ) {
            throw new DomainInvariantError(
              "DVD content already has Original Disc Archive provenance",
            );
          }
          requireLegacyDvdArchiveIdentitiesResolved(
            input.discKind,
            fingerprint,
            transaction,
          );
          const transitioned = transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: timestamp })
            .where(
              and(
                eq(detectedDiscs.id, input.detectedDiscId),
                eq(detectedDiscs.status, "approved"),
                eq(detectedDiscs.discKind, input.discKind),
                eq(detectedDiscs.fingerprint, fingerprint),
              ),
            )
            .returning({ id: detectedDiscs.id })
            .get();
          if (!transitioned) {
            const disc = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, input.detectedDiscId))
                .get(),
              "detected disc",
              input.detectedDiscId,
            );
            if (disc.status !== "approved") {
              throw new InvalidStatusTransitionError(
                "detected disc",
                disc.status,
                "archived",
              );
            }
            if (disc.discKind !== input.discKind) {
              throw new DomainInvariantError(
                "Original Disc Archive kind must match its Detected Disc",
              );
            }
            if (disc.fingerprint !== fingerprint) {
              throw new DomainInvariantError(
                "Original Disc Archive fingerprint must match its Detected Disc",
              );
            }
            throw new InvalidStatusTransitionError(
              "detected disc",
              "approved",
              "archived",
            );
          }

          const archive = requireRow(
            transaction
              .insert(originalDiscArchives)
              .values({
                id: newId<OriginalDiscArchiveId>(),
                detectedDiscId: input.detectedDiscId,
                discKind: input.discKind,
                archiveFormat: input.archiveFormat,
                archivePath,
                fingerprint,
                legacyCutoverPending:
                  transaction
                    .select({
                      sidecarPath:
                        legacyCutoverStagedSidecars.sidecarPath,
                    })
                    .from(legacyCutoverStagedSidecars)
                    .where(legacyCutoverFenceCondition(
                      fingerprint,
                      archivePath,
                    ))
                    .limit(1)
                    .get() !== undefined,
                sizeBytes: input.sizeBytes,
                archivedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "original disc archive",
            input.detectedDiscId,
          );
          transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: timestamp })
            .where(eq(detectedDiscs.fingerprint, fingerprint))
            .run();
          transaction
            .delete(archiveJobs)
            .where(queuedArchiveJobsForFingerprint(fingerprint))
            .run();
          return archive;
        });
      },

      listOriginalDiscArchives(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        if (options?.cursor !== undefined && options.limit === undefined) {
          throw new DomainInvariantError(
            "Original Disc Archive cursor requires a bounded limit",
          );
        }
        if (options?.cursor !== undefined && options.offset !== undefined) {
          throw new DomainInvariantError(
            "Original Disc Archive cursor cannot be combined with an offset",
          );
        }
        const conditions = [
          options?.ids
            ? inArray(originalDiscArchives.id, [...options.ids])
            : undefined,
          options?.uncatalogedOnly
            ? notExists(
                database
                  .select({ id: discSelections.id })
                  .from(discSelections)
                  .where(
                    and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        originalDiscArchives.id,
                      ),
                      eq(discSelections.isCatalogActive, true),
                    ),
                  ),
              )
            : undefined,
          options?.needsCatalogReviewOnly
            ? isNull(originalDiscArchives.catalogReviewedAt)
            : undefined,
          options?.cursor
            ? or(
                options.cursor.direction === "older"
                  ? lt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    )
                  : gt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    ),
                and(
                  eq(
                    originalDiscArchives.archivedAt,
                    options.cursor.archivedAt,
                  ),
                  options.cursor.direction === "older"
                    ? lt(originalDiscArchives.id, options.cursor.id)
                    : gt(originalDiscArchives.id, options.cursor.id),
                ),
              )
            : undefined,
        ].filter((condition) => condition !== undefined);
        const condition =
          conditions.length > 0 ? and(...conditions) : undefined;
        const isBounded = options?.limit !== undefined;
        const readsNewer = options?.cursor?.direction === "newer";
        const query = database
          .select()
          .from(originalDiscArchives)
          .where(condition)
          .orderBy(
            ...(isBounded
              ? readsNewer
                ? [
                    asc(originalDiscArchives.archivedAt),
                    asc(originalDiscArchives.id),
                  ]
                : [
                    desc(originalDiscArchives.archivedAt),
                    desc(originalDiscArchives.id),
                  ]
              : [asc(originalDiscArchives.archivedAt)]),
          );
        const rows = listWithBoundedOffset(
          query,
          options,
          "Original Disc Archive",
        );
        return isBounded && !readsNewer ? rows.reverse() : rows;
      },

      completeCatalogReview(id, catalogRevision) {
        if (
          !(catalogRevision instanceof Date) ||
          !Number.isSafeInteger(catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Catalog review revision must be a valid timestamp",
          );
        }
        const timestamp = now();
        const validatedArchive = validateDiscSelectionsOutsideWriter(id);
        return database.transaction((transaction) => {
          const archive = requireCurrentCatalogValidation(
            validatedArchive,
            transaction,
          );
          if (archive.legacyCutoverPending) {
            throw new DomainInvariantError(
              "Catalog review cannot be completed while legacy cutover repair is pending",
            );
          }
          if (archive.updatedAt.getTime() !== catalogRevision.getTime()) {
            throw new DomainInvariantError(
              "Catalog review changed; reload before completing review",
            );
          }
          if (archive.catalogReviewedAt !== null) {
            return archive;
          }
          const completed = transaction
            .update(originalDiscArchives)
            .set({
              catalogReviewedAt: timestamp,
              updatedAt: nextCatalogMutationTimestamp(timestamp),
            })
            .where(
              and(
                eq(originalDiscArchives.id, id),
                eq(originalDiscArchives.updatedAt, catalogRevision),
                isNull(originalDiscArchives.catalogReviewedAt),
              ),
            )
            .returning()
            .get();
          if (!completed) {
            throw new DomainInvariantError(
              "Catalog review changed; reload before completing review",
            );
          }
          return completed;
        }, { behavior: "immediate" });
      },

      createMediaItem(input) {
        const timestamp = now();
        const id = newId<MediaItemId>();
        return database.transaction((transaction) => {
          const values = validateMediaItem(
            { ...input, id },
            transaction,
            { titleNormalization: "trim" },
          );
          return requireRow(
            transaction
              .insert(mediaItems)
              .values({
                id,
                ...values,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "media item",
            id,
          );
        }, { behavior: "immediate" });
      },

      updateMediaItem(id, input) {
        return database.transaction((transaction) => {
          const current = requireRow(
            transaction
              .select()
              .from(mediaItems)
              .where(eq(mediaItems.id, id))
              .get(),
            "media item",
            id,
          );
          const values = validateMediaItem(
            {
              ...current,
              ...input,
              id,
              parentId:
                input.parentId === undefined
                  ? current.parentId
                  : input.parentId,
              kind: input.kind === undefined ? current.kind : input.kind,
              title: input.title === undefined ? current.title : input.title,
              year: input.year === undefined ? current.year : input.year,
              seasonNumber:
                input.seasonNumber === undefined
                  ? current.seasonNumber
                  : input.seasonNumber,
              episodeNumber:
                input.episodeNumber === undefined
                  ? current.episodeNumber
                  : input.episodeNumber,
            },
            transaction,
            {
              titleNormalization:
                input.title === undefined ? "preserve" : "trim",
            },
          );
          return requireRow(
            transaction
              .update(mediaItems)
              .set({
                ...values,
                updatedAt: now(),
              })
              .where(eq(mediaItems.id, id))
              .returning()
              .get(),
            "media item",
            id,
          );
        }, { behavior: "immediate" });
      },

      listMediaItems(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const query = database
          .select()
          .from(mediaItems)
          .where(
            options?.ids
              ? inArray(mediaItems.id, [...options.ids])
              : undefined,
          )
          .orderBy(
            asc(mediaItems.parentId),
            asc(mediaItems.createdAt),
            asc(mediaItems.id),
          );
        return listWithBoundedOffset(
          query,
          options,
          "Media Item",
        );
      },

      createDiscSelection(input) {
        const timestamp = now();
        const id = newId<DiscSelectionId>();
        return database.transaction(
          (transaction) => {
            const source = requireRow(
              transaction
                .select({
                  discKind: originalDiscArchives.discKind,
                  scanData: detectedDiscs.scanData,
                })
                .from(originalDiscArchives)
                .innerJoin(
                  detectedDiscs,
                  eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
                )
                .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
                .get(),
              "original disc archive",
              input.originalDiscArchiveId,
            );
            requireRow(
              transaction
                .select({ id: mediaItems.id })
                .from(mediaItems)
                .where(eq(mediaItems.id, input.mediaItemId))
                .get(),
              "media item",
              input.mediaItemId,
            );
            if (source.discKind !== "dvd") {
              throw new DomainInvariantError(
                "DVD Disc Selections require a DVD Original Disc Archive",
              );
            }
            const { coordinates, sourceKey } =
              createArchivedDvdSelectionValidator(source.scanData).validate(
                input,
              );
            const selection = toDiscSelection(
              requireRow(
                transaction
                  .insert(discSelections)
                  .values({
                    id,
                    originalDiscArchiveId: input.originalDiscArchiveId,
                    mediaItemId: input.mediaItemId,
                    sourceKey,
                    kind: input.kind,
                    ...coordinates,
                    label: input.label,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .returning()
                  .get(),
                "disc selection",
                id,
              ),
            );
            transaction
              .update(originalDiscArchives)
              .set({
                catalogReviewedAt: null,
                updatedAt: nextCatalogMutationTimestamp(timestamp),
              })
              .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
              .run();
            return selection;
          },
          { behavior: "immediate" },
        );
      },

      repairDiscSelection(id, input) {
        const timestamp = now();
        return database.transaction(
          (transaction) => {
            const current = requireRow(
              transaction
                .select()
                .from(discSelections)
                .where(and(
                  eq(discSelections.id, id),
                  eq(discSelections.isCatalogActive, true),
                ))
                .get(),
              "disc selection",
              id,
            );
            if (
              current.originalDiscArchiveId !== input.originalDiscArchiveId
            ) {
              throw new DomainInvariantError(
                "A Disc Selection repair cannot move between Original Disc Archives",
              );
            }
            const activeJob = transaction
              .select({ id: encodeJobs.id, status: encodeJobs.status })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.discSelectionId, id),
                  inArray(encodeJobs.status, ["queued", "running"]),
                ),
              )
              .limit(1)
              .get();
            if (activeJob) {
              throw new DomainInvariantError(
                `Disc Selection ${id} cannot be repaired while Encode Job ${activeJob.id} is ${activeJob.status}`,
              );
            }
            const historicalJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .limit(1)
              .get();
            const source = requireRow(
              transaction
                .select({
                  discKind: originalDiscArchives.discKind,
                  legacyCutoverPending:
                    originalDiscArchives.legacyCutoverPending,
                  scanData: detectedDiscs.scanData,
                })
                .from(originalDiscArchives)
                .innerJoin(
                  detectedDiscs,
                  eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
                )
                .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
                .get(),
              "original disc archive",
              input.originalDiscArchiveId,
            );
            if (source.legacyCutoverPending) {
              throw new DomainInvariantError(
                "Disc Selections cannot be changed while legacy cutover repair is pending",
              );
            }
            requireRow(
              transaction
                .select({ id: mediaItems.id })
                .from(mediaItems)
                .where(eq(mediaItems.id, input.mediaItemId))
                .get(),
              "media item",
              input.mediaItemId,
            );
            if (source.discKind !== "dvd") {
              throw new DomainInvariantError(
                "DVD Disc Selections require a DVD Original Disc Archive",
              );
            }
            const validator = createArchivedDvdSelectionValidator(
              source.scanData,
            );
            const { coordinates, sourceKey } = validator.validate(input);
            if (historicalJob) {
              if (!requiresLegacyDiscSelectionRepair(
                current,
                validator,
              )) {
                throw new DomainInvariantError(
                  `Disc Selection ${id} cannot be repaired because ordinary Encode Job history must keep its retry identity (job ${historicalJob.id})`,
                );
              }
            }
            let selectionRow: typeof discSelections.$inferSelect;
            if (historicalJob) {
              requireRow(
                transaction
                  .update(discSelections)
                  .set({
                    isCatalogActive: false,
                  })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning({ id: discSelections.id })
                  .get(),
                "disc selection",
                id,
              );
              transaction
                .update(encodeJobs)
                .set({ reservesOutputPath: false })
                .where(and(
                  eq(encodeJobs.discSelectionId, id),
                  eq(encodeJobs.status, "failed"),
                ))
                .run();
              const replacementId = newId<DiscSelectionId>();
              selectionRow = requireRow(
                transaction
                  .insert(discSelections)
                  .values({
                    id: replacementId,
                    originalDiscArchiveId: input.originalDiscArchiveId,
                    mediaItemId: input.mediaItemId,
                    sourceKey,
                    kind: input.kind,
                    ...coordinates,
                    label: input.label ?? null,
                    isCatalogActive: true,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .returning()
                  .get(),
                "disc selection",
                replacementId,
              );
            } else {
              selectionRow = requireRow(
                transaction
                  .update(discSelections)
                  .set({
                    mediaItemId: input.mediaItemId,
                    sourceKey,
                    kind: input.kind,
                    ...coordinates,
                    label: input.label ?? null,
                    updatedAt: timestamp,
                  })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning()
                  .get(),
                "disc selection",
                id,
              );
            }
            const selection = toDiscSelection(selectionRow);
            transaction
              .update(originalDiscArchives)
              .set({
                catalogReviewedAt: null,
                updatedAt: nextCatalogMutationTimestamp(timestamp),
              })
              .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
              .run();
            return selection;
          },
          { behavior: "immediate" },
        );
      },

      deleteDiscSelection(id) {
        const timestamp = now();
        return database.transaction(
          (transaction) => {
            const selection = requireRow(
              transaction
                .select()
                .from(discSelections)
                .where(and(
                  eq(discSelections.id, id),
                  eq(discSelections.isCatalogActive, true),
                ))
                .get(),
              "disc selection",
              id,
            );
            const archiveState = requireRow(
              transaction
                .select({
                  legacyCutoverPending:
                    originalDiscArchives.legacyCutoverPending,
                  scanData: detectedDiscs.scanData,
                })
                .from(originalDiscArchives)
                .innerJoin(
                  detectedDiscs,
                  eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
                )
                .where(eq(
                  originalDiscArchives.id,
                  selection.originalDiscArchiveId,
                ))
                .get(),
              "original disc archive",
              selection.originalDiscArchiveId,
            );
            if (archiveState.legacyCutoverPending) {
              throw new DomainInvariantError(
                "Disc Selections cannot be changed while legacy cutover repair is pending",
              );
            }
            const dependentJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .limit(1)
              .get();
            if (dependentJob) {
              if (!requiresLegacyDiscSelectionRepair(
                selection,
                createArchivedDvdSelectionValidator(archiveState.scanData),
              )) {
                throw new DomainInvariantError(
                  `Disc Selection ${id} cannot be deleted because Encode Job history must be preserved (job ${dependentJob.id})`,
                );
              }
              requireRow(
                transaction
                  .update(discSelections)
                  .set({ isCatalogActive: false })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning({ id: discSelections.id })
                  .get(),
                "disc selection",
                id,
              );
              transaction
                .update(encodeJobs)
                .set({ reservesOutputPath: false })
                .where(and(
                  eq(encodeJobs.discSelectionId, id),
                  eq(encodeJobs.status, "failed"),
                ))
                .run();
            } else {
              requireRow(
                transaction
                  .delete(discSelections)
                  .where(eq(discSelections.id, id))
                  .returning({ id: discSelections.id })
                  .get(),
                "disc selection",
                id,
              );
            }
            transaction
              .update(originalDiscArchives)
              .set({
                catalogReviewedAt: null,
                updatedAt: nextCatalogMutationTimestamp(timestamp),
              })
              .where(
                eq(
                  originalDiscArchives.id,
                  selection.originalDiscArchiveId,
                ),
              )
              .run();
            return {
              ...toDiscSelection(selection),
              deletedEncodeJobs: 0,
              deletionComplete: true,
            };
          },
          { behavior: "immediate" },
        );
      },

      listDiscSelections(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const conditions = [
          options?.ids
            ? inArray(discSelections.id, [...options.ids])
            : undefined,
          options?.originalDiscArchiveId
            ? eq(
                discSelections.originalDiscArchiveId,
                options.originalDiscArchiveId,
              )
            : undefined,
          options?.ids === undefined || options.encodeEligibleOnly
            ? eq(discSelections.isCatalogActive, true)
            : undefined,
          options?.encodeEligibleOnly
            ? exists(
                database
                  .select({ id: originalDiscArchives.id })
                  .from(originalDiscArchives)
                  .where(
                    and(
                      eq(
                        originalDiscArchives.id,
                        discSelections.originalDiscArchiveId,
                      ),
                      isNotNull(originalDiscArchives.catalogReviewedAt),
                      eq(originalDiscArchives.legacyCutoverPending, false),
                    ),
                  ),
              )
            : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(discSelections)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id));
        const rows = listWithBoundedOffset(
          query,
          options,
          "Disc Selection",
        );
        return rows.map(toDiscSelection);
      },
    },

    encodingProfiles: {
      create(input) {
        const timestamp = now();
        const id = newId<EncodingProfileId>();
        const key = requireNonEmpty(input.key, "key");
        return database.transaction(
          (transaction) => {
            const existing = transaction
              .select({ id: encodingProfiles.id })
              .from(encodingProfiles)
              .where(
                and(
                  eq(encodingProfiles.mediaDomain, input.mediaDomain),
                  eq(encodingProfiles.key, key),
                ),
              )
              .get();
            if (existing) {
              throw new DomainInvariantError(
                "Encoding Profile key already exists in this media domain",
              );
            }
            return requireRow(
              transaction
                .insert(encodingProfiles)
                .values({
                  id,
                  key,
                  displayName: requireNonEmpty(
                    input.displayName,
                    "displayName",
                  ),
                  mediaDomain: input.mediaDomain,
                  version: 1,
                  isActive: true,
                  settings: input.settings,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .returning()
                .get(),
              "encoding profile",
              id,
            );
          },
          { behavior: "immediate" },
        );
      },

      createVersion(input) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const source = requireEncodingProfileInDomain(
            transaction,
            input.sourceProfileId,
            input.mediaDomain,
          );
          const latest = requireRow(
            transaction
              .select({ version: encodingProfiles.version })
              .from(encodingProfiles)
              .where(
                and(
                  eq(encodingProfiles.mediaDomain, source.mediaDomain),
                  eq(encodingProfiles.key, source.key),
                ),
              )
              .orderBy(desc(encodingProfiles.version))
              .limit(1)
              .get(),
            "encoding profile",
            source.id,
          );
          const version = requirePositiveSafeInteger(
            latest.version + 1,
            "version",
          );
          const id = newId<EncodingProfileId>();
          return requireRow(
            transaction
              .insert(encodingProfiles)
              .values({
                id,
                key: source.key,
                displayName: source.displayName,
                mediaDomain: source.mediaDomain,
                version,
                isActive: false,
                settings: input.settings,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "encoding profile",
            id,
          );
        }, { behavior: "immediate" });
      },

      find(input) {
        const key = requireNonEmpty(input.key, "key");
        const version = requirePositiveSafeInteger(input.version, "version");
        return (
          database
            .select()
            .from(encodingProfiles)
            .where(
              and(
                eq(encodingProfiles.mediaDomain, input.mediaDomain),
                eq(encodingProfiles.key, key),
                eq(encodingProfiles.version, version),
              ),
            )
            .get() ?? null
        );
      },

      setActive(input) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const profile = requireEncodingProfileInDomain(
            transaction,
            input.id,
            input.mediaDomain,
          );

          if (input.isActive) {
            transaction
              .update(encodingProfiles)
              .set({ isActive: false, updatedAt: timestamp })
              .where(
                and(
                  eq(encodingProfiles.mediaDomain, profile.mediaDomain),
                  eq(encodingProfiles.key, profile.key),
                  eq(encodingProfiles.isActive, true),
                  ne(encodingProfiles.id, profile.id),
                ),
              )
              .run();
          }

          return requireRow(
            transaction
              .update(encodingProfiles)
              .set({ isActive: input.isActive, updatedAt: timestamp })
              .where(eq(encodingProfiles.id, profile.id))
              .returning()
              .get(),
            "encoding profile",
            profile.id,
          );
        }, { behavior: "immediate" });
      },

      list(input = {}) {
        if (input.ids !== undefined && input.ids.length === 0) {
          return [];
        }
        const conditions = [
          input.ids
            ? inArray(encodingProfiles.id, [...input.ids])
            : undefined,
          input.mediaDomain
            ? eq(encodingProfiles.mediaDomain, input.mediaDomain)
            : undefined,
          input.activeOnly ? eq(encodingProfiles.isActive, true) : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(encodingProfiles)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            asc(encodingProfiles.mediaDomain),
            asc(encodingProfiles.key),
            asc(encodingProfiles.version),
          );
        if (input.limit === undefined) {
          return query.all();
        }
        const limited = query.limit(
          requirePositiveSafeInteger(input.limit, "limit"),
        );
        if (input.offset === undefined) {
          return limited.all();
        }
        const offset = optionalSafeInteger(input.offset, "offset", 0);
        if (offset === null || offset === undefined) {
          throw new DomainInvariantError("offset must be a safe integer");
        }
        return limited.offset(offset).all();
      },
    },

    archiveJobs: {
      approve(input) {
        return approveDetectedDisc({
          ...input,
          allowAlreadyApproved: true,
        }).job;
      },

      enqueue(input) {
        const timestamp = now();
        insertApprovedArchiveJob.run(
          newId<ArchiveJobId>(),
          input.priority ?? 0,
          timestamp.getTime(),
          timestamp.getTime(),
          input.detectedDiscId,
        );
        const eligible = database
          .select({ job: archiveJobs })
          .from(archiveJobs)
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, archiveJobs.detectedDiscId),
          )
          .where(
            and(
              eq(archiveJobs.detectedDiscId, input.detectedDiscId),
              eq(detectedDiscs.status, "approved"),
              or(
                ne(detectedDiscs.discKind, "dvd"),
                sql`not (${detectedDiscUsesCurrentDvdContentId})`,
                notExists(
                  database
                    .select({ id: originalDiscArchives.id })
                    .from(originalDiscArchives)
                    .where(unresolvedLegacyDvdArchiveIdentity),
                ),
              ),
              notExists(
                database
                  .select({ id: originalDiscArchives.id })
                  .from(originalDiscArchives)
                  .where(
                    or(
                      eq(
                        originalDiscArchives.fingerprint,
                        detectedDiscs.fingerprint,
                      ),
                      exists(
                        database
                          .select({
                            originalDiscArchiveId:
                              originalDiscArchiveContentIds.originalDiscArchiveId,
                          })
                          .from(originalDiscArchiveContentIds)
                          .where(
                            and(
                              eq(
                                originalDiscArchiveContentIds.originalDiscArchiveId,
                                originalDiscArchives.id,
                              ),
                              eq(
                                originalDiscArchiveContentIds.contentId,
                                detectedDiscs.fingerprint,
                              ),
                            ),
                          ),
                      ),
                    ),
                  ),
              ),
            ),
          )
          .get()?.job;
        if (eligible) {
          return eligible;
        }
        requireRow(
          database
            .select({ id: detectedDiscs.id })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.id, input.detectedDiscId))
            .get(),
          "detected disc",
          input.detectedDiscId,
        );
        throw new DomainInvariantError(
          "Only an approved, unarchived Detected Disc can be queued for archiving",
        );
      },

      claimNext: archiveJobQueue.claimNext,
      renewClaim(claim) {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const renewed = database
          .update(archiveJobs)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
              gt(archiveJobs.updatedAt, expiredBefore),
            ),
          )
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        return asRunningArchiveJob(renewed);
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        return database.transaction((transaction) => {
          const expiredIds = transaction
            .select({ id: archiveJobs.id })
            .from(archiveJobs)
            .where(
              and(
                eq(archiveJobs.status, "running"),
                lte(archiveJobs.updatedAt, expiredBefore),
              ),
            )
            .orderBy(asc(archiveJobs.updatedAt), asc(archiveJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all()
            .map(({ id }) => id);
          if (expiredIds.length === 0) {
            return [];
          }
          return transaction
            .update(archiveJobs)
            .set({
              status: "failed",
              errorMessage: "Archive worker lease expired",
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(archiveJobs.id, expiredIds),
                eq(archiveJobs.status, "running"),
                lte(archiveJobs.updatedAt, expiredBefore),
              ),
            )
            .returning()
            .all();
        }, { behavior: "immediate" });
      },
      list: archiveJobQueue.list,
      updateProgress: archiveJobQueue.updateProgress,
      publish(claim, input) {
        return archiveJobQueue.complete(claim, input);
      },
      complete: archiveJobQueue.complete,
      fail: archiveJobQueue.fail,
      requeue: archiveJobQueue.requeue,
    },

    encodeJobs: {
      enqueue(input) {
        const timestamp = now();
        const outputPath = requireNonEmpty(input.outputPath, "outputPath");
        const selectReviewState = (
          querySource: Pick<typeof database, "select">,
        ) =>
          requireRow(
            querySource
              .select({
                catalogReviewedAt: originalDiscArchives.catalogReviewedAt,
                legacyCutoverPending:
                  originalDiscArchives.legacyCutoverPending,
                originalDiscArchiveId: originalDiscArchives.id,
              })
              .from(discSelections)
              .innerJoin(
                originalDiscArchives,
                eq(
                  originalDiscArchives.id,
                  discSelections.originalDiscArchiveId,
                ),
              )
              .where(and(
                eq(discSelections.id, input.discSelectionId),
                eq(discSelections.isCatalogActive, true),
              ))
              .get(),
            "disc selection",
            input.discSelectionId,
          );
        const requireCompletedReview = (
          selectionReview: ReturnType<typeof selectReviewState>,
        ) => {
          if (
            selectionReview.catalogReviewedAt === null ||
            selectionReview.legacyCutoverPending
          ) {
            throw new DomainInvariantError(
              "Encode Jobs require a completed catalog review",
            );
          }
          return selectionReview;
        };
        const validatedArchive = database.transaction(
          (transaction) => {
            const selectionReview = requireCompletedReview(
              selectReviewState(transaction),
            );
            return requireReviewableDiscSelections(
              selectionReview.originalDiscArchiveId,
              transaction,
            );
          },
          { behavior: "deferred" },
        );
        return database.transaction(
          (transaction) => {
            const selectionReview = requireCompletedReview(
              selectReviewState(transaction),
            );
            if (
              selectionReview.originalDiscArchiveId !== validatedArchive.id
            ) {
              throw new DomainInvariantError(
                "Catalog changed during validation; retry the operation",
              );
            }
            requireCurrentCatalogValidation(
              validatedArchive,
              transaction,
            );
            const existing = transaction
              .select()
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.discSelectionId, input.discSelectionId),
                  eq(encodeJobs.encodingProfileId, input.encodingProfileId),
                ),
              )
              .get();
            if (
              existing &&
              existing.status !== "failed" &&
              existing.status !== "completed"
            ) {
              return existing;
            }
            const effectiveOutputPath =
              existing &&
              (existing.status === "completed" ||
                existing.replaceExistingOutput)
                ? existing.outputPath
                : outputPath;
            const outputOwner = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.outputPath, effectiveOutputPath),
                  eq(encodeJobs.reservesOutputPath, true),
                  or(
                    ne(encodeJobs.discSelectionId, input.discSelectionId),
                    ne(encodeJobs.encodingProfileId, input.encodingProfileId),
                  ),
                ),
              )
              .limit(1)
              .get();
            if (outputOwner) {
              throw new DomainInvariantError(
                `Encode Job output is already assigned: ${effectiveOutputPath}`,
              );
            }
            if (existing) {
              return encodeJobQueue.requeue(existing.id, {
                outputPath: effectiveOutputPath,
                priority: input.priority ?? 0,
              });
            }
            const profile = requireRow(
              transaction
                .select({
                  id: encodingProfiles.id,
                  isActive: encodingProfiles.isActive,
                  mediaDomain: encodingProfiles.mediaDomain,
                })
                .from(encodingProfiles)
                .where(eq(encodingProfiles.id, input.encodingProfileId))
                .get(),
              "encoding profile",
              input.encodingProfileId,
            );
            if (!profile.isActive || profile.mediaDomain !== "dvd_video") {
              throw new DomainInvariantError(
                "Encode Jobs require an active DVD video Encoding Profile",
              );
            }
            transaction
              .insert(encodeJobs)
              .values({
                id: newId<EncodeJobId>(),
                discSelectionId: input.discSelectionId,
                encodingProfileId: input.encodingProfileId,
                outputPath: effectiveOutputPath,
                priority: input.priority ?? 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .onConflictDoNothing({
                target: [
                  encodeJobs.discSelectionId,
                  encodeJobs.encodingProfileId,
                ],
              })
              .run();

            return requireRow(
              transaction
                .select()
                .from(encodeJobs)
                .where(
                  and(
                    eq(encodeJobs.discSelectionId, input.discSelectionId),
                    eq(encodeJobs.encodingProfileId, input.encodingProfileId),
                  ),
                )
                .get(),
              "encode job",
              `${input.discSelectionId}/${input.encodingProfileId}`,
            );
          },
          { behavior: "immediate" },
        );
      },

      claimNext: encodeJobQueue.claimNext,
      renewClaim(claim) {
        const timestamp = now();
        const renewed = database
          .update(encodeJobs)
          .set({ updatedAt: timestamp })
          .where(encodeAttemptCondition(claim, timestamp))
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return asRunningEncodeJob(renewed);
      },
      beginPublicationMutation(claim, cleanup) {
        if (!cleanup.publicationPending || cleanup.leaseToken !== null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation requires unfenced provenance",
          );
        }
        const timestamp = now();
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        return database.transaction((transaction) => {
          const renewed = transaction
            .update(encodeJobs)
            .set({
              partialCleanupLeaseToken: leaseToken,
              updatedAt: timestamp,
            })
            .where(and(
              encodeAttemptCondition(claim, timestamp),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.publicationPending, true),
              isNull(encodeJobs.partialCleanupLeaseToken),
            ))
            .returning()
            .get();
          if (!renewed) {
            throw new StaleJobAttemptError("encode job", claim.id);
          }
          return { ...cleanup, leaseToken };
        }, { behavior: "immediate" });
      },
      listPublicationMutations() {
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "running"),
            isNotNull(encodeJobs.partialCleanupOutputPath),
            isNotNull(encodeJobs.partialCleanupClaimToken),
            isNotNull(encodeJobs.partialCleanupLeaseToken),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (
              cleanup.outputPath === null ||
              cleanup.claimToken === null ||
              cleanup.leaseToken === null
            ) {
              throw new DomainInvariantError(
                "Encode Job publication mutation provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      listExpiredPublicationMutations() {
        const expiredBefore = new Date(
          now().getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "running"),
            isNotNull(encodeJobs.partialCleanupOutputPath),
            isNotNull(encodeJobs.partialCleanupClaimToken),
            isNotNull(encodeJobs.partialCleanupLeaseToken),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (
              cleanup.outputPath === null ||
              cleanup.claimToken === null ||
              cleanup.leaseToken === null
            ) {
              throw new DomainInvariantError(
                "Encode Job publication mutation provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      completePublishedMutation(cleanup, publicationMatches) {
        if (!cleanup.publicationPending || cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation completion requires fenced provenance",
          );
        }
        const matches = publicationMatches();
        if (!matches) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const timestamp = now();
        const updated = database
          .update(encodeJobs)
          .set({
            status: "completed",
            publicationCompletionPending: true,
            progressPercent: 100,
            progressEtaSeconds: null,
            completedAt: timestamp,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, cleanup.jobId),
            eq(encodeJobs.status, "running"),
            eq(encodeJobs.publicationPending, true),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            eq(encodeJobs.partialCleanupLeaseToken, cleanup.leaseToken),
          ))
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          eq(encodeJobs.partialCleanupLeaseToken, cleanup.leaseToken),
        );
        if (!publicationMatches()) {
          const invalidated = database
            .update(encodeJobs)
            .set({
              status: "running",
              publicationCompletionPending: false,
              completedAt: null,
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!invalidated) {
            throw new StaleJobAttemptError(
              "encode job publication mutation",
              cleanup.jobId,
            );
          }
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const finalized = database
          .update(encodeJobs)
          .set({
            replaceExistingOutput: false,
            replacementOutputIdentity: null,
            publicationCompletionPending: false,
            updatedAt: now(),
          })
          .where(completionCondition)
          .returning()
          .get();
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        return finalized;
      },
      recoverExpiredPublicationMutation(cleanup) {
        if (cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation recovery requires fenced provenance",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const updated = database
          .update(encodeJobs)
          .set({
            status: "failed",
            partialCleanupLeaseToken: null,
            errorMessage: "Encode publication mutation was abandoned",
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, cleanup.jobId),
            eq(encodeJobs.status, "running"),
            eq(
              encodeJobs.publicationPending,
              cleanup.publicationPending,
            ),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            eq(encodeJobs.partialCleanupLeaseToken, cleanup.leaseToken),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        return updated;
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database.transaction((transaction) => {
          const expiredIds = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(
              and(
                eq(encodeJobs.status, "running"),
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            )
            .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all()
            .map(({ id }) => id);
          if (expiredIds.length === 0) {
            return [];
          }
          return transaction
            .update(encodeJobs)
            .set({
              status: "failed",
              progressEtaSeconds: null,
              partialCleanupOutputPath: sql`${encodeJobs.outputPath}`,
              partialCleanupClaimToken: sql`${encodeJobs.claimToken}`,
              partialCleanupLeaseToken: null,
              errorMessage: "Encode worker lease expired",
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(encodeJobs.id, expiredIds),
                eq(encodeJobs.status, "running"),
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            )
            .returning()
            .all();
        }, { behavior: "immediate" });
      },
      recordReplacementOutputIdentity(claim, identity) {
        const timestamp = now();
        requireNonEmpty(identity, "replacementOutputIdentity");
        const updated = database
          .update(encodeJobs)
          .set({
            replacementOutputIdentity: identity,
            updatedAt: timestamp,
          })
          .where(
            and(
              encodeAttemptCondition(claim, timestamp),
              eq(encodeJobs.replaceExistingOutput, true),
              or(
                isNull(encodeJobs.replacementOutputIdentity),
                eq(
                  encodeJobs.replacementOutputIdentity,
                  identity,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return asRunningEncodeJob(updated);
      },
      registerPartialCleanup(claim, options) {
        const timestamp = now();
        const publicationPending = options?.publicationPending === true;
        const updated = database
          .update(encodeJobs)
          .set({
            partialCleanupOutputPath: claim.outputPath,
            partialCleanupClaimToken: claim.claimToken,
            partialCleanupLeaseToken: null,
            publicationPending,
            updatedAt: timestamp,
          })
          .where(encodeAttemptCondition(claim, timestamp))
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return {
          jobId: updated.id,
          outputPath: claim.outputPath,
          claimToken: claim.claimToken,
          leaseToken: null,
          publicationPending,
        };
      },
      revokePublication(claim, cleanup) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const updated = database
          .update(encodeJobs)
          .set({ publicationPending: false, updatedAt: timestamp })
          .where(
            and(
              cleanup.leaseToken === null
                ? encodeAttemptCondition(claim, timestamp)
                : and(
                    eq(encodeJobs.id, claim.id),
                    eq(encodeJobs.status, "running"),
                    eq(encodeJobs.claimToken, claim.claimToken),
                  ),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              cleanup.leaseToken === null
                ? isNull(encodeJobs.partialCleanupLeaseToken)
                : eq(
                    encodeJobs.partialCleanupLeaseToken,
                    cleanup.leaseToken,
                  ),
              eq(encodeJobs.publicationPending, true),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return { ...cleanup, publicationPending: false };
      },
      listPendingPartialCleanups() {
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(
            and(
              inArray(encodeJobs.status, ["failed", "completed"]),
              isNotNull(encodeJobs.partialCleanupOutputPath),
              isNotNull(encodeJobs.partialCleanupClaimToken),
            ),
          )
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (cleanup.outputPath === null || cleanup.claimToken === null) {
              throw new DomainInvariantError(
                "Encode Job partial cleanup provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      claimPartialCleanup(cleanup) {
        if (cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job publication cleanup cannot be claimed for rollback",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        const updated = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(encodeJobs.id, cleanup.jobId),
              inArray(encodeJobs.status, ["failed", "completed"]),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.publicationPending, false),
              or(
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job cleanup",
            cleanup.jobId,
          );
        }
        return { ...cleanup, leaseToken };
      },
      renewPartialCleanup(cleanup) {
        if (cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job cleanup renewal requires a cleanup lease",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const updated = database
          .update(encodeJobs)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(encodeJobs.id, cleanup.jobId),
              inArray(encodeJobs.status, ["failed", "completed"]),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
              eq(encodeJobs.publicationPending, false),
              gt(encodeJobs.updatedAt, expiredBefore),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job cleanup",
            cleanup.jobId,
          );
        }
        return cleanup;
      },
      withPartialCleanupMutationFence(cleanup, mutation) {
        if (cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job publication cleanup cannot be claimed for rollback",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        const authorizedCleanup = database.transaction((transaction) => {
          const updated = transaction
            .update(encodeJobs)
            .set({
              partialCleanupLeaseToken: leaseToken,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(encodeJobs.id, cleanup.jobId),
                inArray(encodeJobs.status, ["failed", "completed"]),
                eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
                eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
                eq(encodeJobs.publicationPending, false),
                or(
                  isNull(encodeJobs.partialCleanupLeaseToken),
                  lte(encodeJobs.updatedAt, expiredBefore),
                ),
              ),
            )
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job cleanup",
              cleanup.jobId,
            );
          }
          return { ...cleanup, leaseToken };
        }, { behavior: "immediate" });
        mutation();
        return authorizedCleanup;
      },
      renewPublishedPartial(cleanup, publicationMatches) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const leaseToken =
          cleanup.leaseToken ?? newId<EncodeJobCleanupClaimToken>();
        const publicationCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          inArray(encodeJobs.status, ["failed", "completed"]),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        const owned = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(publicationCondition)
          .returning()
          .get();
        if (!owned) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const matches = publicationMatches();
        if (!matches) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return { ...cleanup, leaseToken };
      },
      completePublishedPartial(cleanup, publicationMatches) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const leaseToken =
          cleanup.leaseToken ?? newId<EncodeJobCleanupClaimToken>();
        const publicationCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          inArray(encodeJobs.status, ["failed", "completed"]),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        const owned = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(publicationCondition)
          .returning()
          .get();
        if (!owned) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const matches = publicationMatches();
        database.transaction((transaction) => {
          if (!matches) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          const fencedPublicationCondition = and(
            eq(encodeJobs.id, cleanup.jobId),
            inArray(encodeJobs.status, ["failed", "completed"]),
            eq(encodeJobs.publicationPending, true),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
          );
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: "completed",
              publicationCompletionPending: true,
              progressPercent: 100,
              progressEtaSeconds: null,
              completedAt: sql`coalesce(${encodeJobs.completedAt}, ${timestamp.getTime()})`,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(fencedPublicationCondition)
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          return updated;
        }, { behavior: "immediate" });
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        if (!publicationMatches()) {
          const invalidated = database
            .update(encodeJobs)
            .set({
              status: owned.status,
              publicationCompletionPending:
                owned.publicationCompletionPending,
              completedAt: owned.completedAt,
              errorMessage: owned.errorMessage,
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!invalidated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const finalized = database
          .update(encodeJobs)
          .set({
            replaceExistingOutput: false,
            replacementOutputIdentity: null,
            publicationCompletionPending: false,
            updatedAt: now(),
          })
          .where(completionCondition)
          .returning()
          .get();
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return {
          cleanup: { ...cleanup, leaseToken },
          job: finalized,
        };
      },
      completePublishedClaim(claim, cleanup, publicationMatches) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const publicationCondition = and(
          cleanup.leaseToken === null
            ? encodeAttemptCondition(claim, timestamp)
            : and(
                eq(encodeJobs.id, claim.id),
                eq(encodeJobs.status, "running"),
                eq(encodeJobs.claimToken, claim.claimToken),
              ),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
        );
        const matches = publicationMatches();
        database.transaction((transaction) => {
          const owned = transaction
            .update(encodeJobs)
            .set({ updatedAt: timestamp })
            .where(publicationCondition)
            .returning()
            .get();
          if (!owned || !matches) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: "completed",
              publicationCompletionPending: true,
              progressPercent: 100,
              progressEtaSeconds: null,
              completedAt: timestamp,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(publicationCondition)
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          return updated;
        }, { behavior: "immediate" });
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.claimToken, claim.claimToken),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
        );
        if (!publicationMatches()) {
          const invalidated = database
            .update(encodeJobs)
            .set({
              status: "failed",
              publicationCompletionPending: false,
              completedAt: null,
              errorMessage:
                "Encode publication changed across completion commit",
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!invalidated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const finalized = database
          .update(encodeJobs)
          .set({
            replaceExistingOutput: false,
            replacementOutputIdentity: null,
            publicationCompletionPending: false,
            updatedAt: now(),
          })
          .where(completionCondition)
          .returning()
          .get();
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return finalized;
      },
      completePartialCleanup(cleanup) {
        const updated = database
          .update(encodeJobs)
          .set({
            status: sql`case when ${encodeJobs.publicationCompletionPending} = 1 then 'failed' else ${encodeJobs.status} end`,
            completedAt: sql`case when ${encodeJobs.publicationCompletionPending} = 1 then null else ${encodeJobs.completedAt} end`,
            errorMessage: sql`case when ${encodeJobs.publicationCompletionPending} = 1 then 'Encode publication completion was interrupted' else ${encodeJobs.errorMessage} end`,
            partialCleanupOutputPath: null,
            partialCleanupClaimToken: null,
            partialCleanupLeaseToken: null,
            publicationPending: false,
            publicationCompletionPending: false,
          })
          .where(
            and(
              eq(encodeJobs.id, cleanup.jobId),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              cleanup.leaseToken === null
                ? isNull(encodeJobs.partialCleanupLeaseToken)
                : eq(
                    encodeJobs.partialCleanupLeaseToken,
                    cleanup.leaseToken,
                  ),
            ),
          )
          .returning()
          .get();
        if (updated) {
          return updated;
        }
        const current = database
          .select()
          .from(encodeJobs)
          .where(eq(encodeJobs.id, cleanup.jobId))
          .get();
        if (
          current?.partialCleanupOutputPath === null &&
          current.partialCleanupClaimToken === null &&
          current.partialCleanupLeaseToken === null &&
          !current.publicationPending
        ) {
          return current;
        }
        throw new StaleJobAttemptError("encode job cleanup", cleanup.jobId);
      },
      list: encodeJobQueue.list,
      updateProgress(claim, progress) {
        if (typeof progress === "number") {
          return encodeJobQueue.updateProgress(claim, progress);
        }
        if (!ENCODE_PROGRESS_PHASES.includes(progress.phase)) {
          throw new DomainInvariantError("Encode Job progress phase is invalid");
        }
        const etaSeconds = optionalSafeInteger(
          progress.etaSeconds,
          "etaSeconds",
          0,
        );
        return encodeJobQueue.updateProgress(
          claim,
          progress.progressPercent,
          {
            phase: progress.phase,
            etaSeconds: etaSeconds ?? null,
          },
        );
      },
      complete: (claim) => encodeJobQueue.complete(claim, undefined),
      fail: encodeJobQueue.fail,
      requeue: encodeJobQueue.requeue,
    },

    filesystemVerification: {
      listOriginalDiscArchives(options) {
        return access.catalog.listOriginalDiscArchives(options);
      },
      listEncodeJobOutputs(options) {
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        const offset = optionalSafeInteger(options.offset, "offset", 0) ?? 0;
        return database
          .select()
          .from(encodeJobs)
          .orderBy(desc(encodeJobs.createdAt), desc(encodeJobs.id))
          .limit(limit)
          .offset(offset)
          .all()
          .reverse();
      },
      async verifyOriginalDiscArchive(id) {
        const archive = requireRow(
          database
            .select()
            .from(originalDiscArchives)
            .where(eq(originalDiscArchives.id, id))
            .get(),
          "original disc archive",
          id,
        );
        const verification = await inspectFilesystemPath(
          archive.archivePath,
          originalsVerificationRoot,
        );
        return requireRow(
          database
            .update(originalDiscArchives)
            .set(verification)
            .where(
              and(
                eq(originalDiscArchives.id, id),
                eq(originalDiscArchives.archivePath, archive.archivePath),
              ),
            )
            .returning()
            .get(),
          "original disc archive",
          id,
        );
      },
      async verifyEncodeJobOutput(id) {
        const job = requireRow(
          database
            .select()
            .from(encodeJobs)
            .where(eq(encodeJobs.id, id))
            .get(),
          "encode job",
          id,
        );
        const verification = await inspectFilesystemPath(
          job.outputPath,
          mediaVerificationRoot,
        );
        return requireRow(
          database
            .update(encodeJobs)
            .set(verification)
            .where(
              and(
                eq(encodeJobs.id, id),
                eq(encodeJobs.outputPath, job.outputPath),
              ),
            )
            .returning()
            .get(),
          "encode job",
          id,
        );
      },
    },

    legacySidecars: legacySidecarMigration
      ? legacySidecarMigration.createAccess(
          database,
          now,
          requireReviewableDiscSelections,
        )
      : {
          importLibrary() {
            throw new DomainInvariantError(
              "Legacy sidecar import is available from the migration-only entrypoint",
            );
          },
        },

    close() {
      sqlite.close();
    },
  };

  if (!legacySidecarMigration) {
    const {
      createOriginalDiscArchive: _migrationOnlyArchiveMutation,
      ...standardCatalog
    } = access.catalog;
    const {
      complete: _migrationOnlyArchiveCompletion,
      ...standardArchiveJobs
    } = access.archiveJobs;
    const { legacySidecars: _migrationOnlyAccess, ...standardAccess } = access;
    return {
      ...standardAccess,
      catalog: standardCatalog,
      archiveJobs: standardArchiveJobs,
    };
  }
  return access;
}
