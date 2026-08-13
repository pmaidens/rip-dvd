import {
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  gte,
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
import { assignDvdContentIdAlias } from "./dvd-content-id-alias.js";
import {
  archiveRequests,
  archiveJobs,
  detectedDiscs,
  discInspectionAttempts,
  discInspections,
  discSelectionSupersessions,
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
import {
  validateMediaItem,
  type ValidatedMediaItem,
} from "./media-item-validation.js";
import { serializeDiscSelectionSourceIdentity } from "../disc-selection-source-identity.js";
import { isDvdContentId, MAX_DVD_TITLES } from "../dvd-scan.js";
import {
  ARCHIVE_RUNNING_PROGRESS_PHASES,
  ENCODE_PROGRESS_PHASES,
} from "../domain-values.js";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  StaleJobAttemptError,
} from "../errors.js";
import type { LegacySidecarDataAccess } from "../legacy-sidecar-types.js";
import { normalizeMediaItemSearchTitle } from "../media-item-title-search.js";
import type {
  ArchiveJobClaimToken,
  ArchiveJobId,
  ArchiveJob,
  ArchiveJobStatus,
  ArchiveJobProgress,
  ArchiveRequestId,
  ArchiveRequestStatus,
  ClaimedEncodeJob,
  ChronologicalListOptions,
  ConsistentReadAccess,
  CreateDiscSelectionInput,
  CompletedCatalogReviewOutcome,
  DataAccess,
  DetectedDiscId,
  DetectedDiscListOptions,
  DetectedDiscStatus,
  DiscInspectionClaim,
  DiscInspectionClaimToken,
  DiscInspectionEvent,
  DiscInspectionAttemptId,
  DiscInspectionId,
  DiscInspectionReasonCode,
  DiscSelectionId,
  DiscSelectionActionAvailability,
  DiscSelectionSupersession,
  EncodeJobClaimToken,
  EncodeJobCleanupClaimToken,
  EncodeJobId,
  EncodeJob,
  EncodeJobFailureOptions,
  EncodeJobPartialCleanup,
  EncodeJobProgress,
  EncodeJobRequeueOptions,
  EncodeJobStatus,
  EncodingProfileId,
  MediaDomain,
  MediaItemMaintenance,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "../types.js";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  ENCODE_JOB_LEASE_DURATION_MS,
} from "../types.js";
import { newId, requireRow } from "./persistence.js";

const BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const JOB_RECOVERY_LIMIT = 100;
const RELATED_ACTIVITY_ROOT_LIMIT = 256;
const LEGACY_ARCHIVE_RECONCILIATION_LIMIT = 4;
const LEGACY_ARCHIVE_RECONCILIATION_BYTES = 9_000_000_000;
const DISC_SELECTION_REVIEW_BATCH_SIZE = 100;
const DISC_SELECTION_ACTION_AVAILABILITY_LIMIT = 100;
const DISC_SELECTION_SUPERSESSION_LIMIT = 100;
const MEDIA_ITEM_SEARCH_LIMIT = 100;
const CATALOG_REVIEW_ARCHIVE_LIMIT = 100;
const CATALOG_REVIEW_MAPPED_TITLE_SUMMARY_LIMIT = 3;
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

function asClaimedEncodeJob(job: EncodeJob): ClaimedEncodeJob {
  if (
    (job.status !== "running" && job.status !== "cancellation_requested") ||
    job.claimToken === null
  ) {
    throw new DomainInvariantError("Claimed Encode Job has no active claim");
  }
  return job as ClaimedEncodeJob;
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
    sqlite.function(
      "rip_dvd_normalize_media_item_title",
      { deterministic: true },
      (value) =>
        typeof value === "string"
          ? normalizeMediaItemSearchTitle(value)
          : null,
    );
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

  type CatalogTransaction = Parameters<
    Parameters<typeof database.transaction>[0]
  >[0];

  function mediaItemDeletionReason(
    childCount: number,
    discSelectionReferenceCount: number,
  ): string | null {
    const blockers = [
      childCount === 0
        ? null
        : `${childCount} child ${
          childCount === 1 ? "Media Item" : "Media Items"
        }`,
      discSelectionReferenceCount === 0
        ? null
        : `${discSelectionReferenceCount} Disc Selection ${
          discSelectionReferenceCount === 1 ? "reference" : "references"
        }`,
    ].filter((blocker): blocker is string => blocker !== null);
    return blockers.length === 0 ? null : blockers.join(" and ");
  }

  function readMediaItemMaintenance(
    ids: readonly MediaItemId[],
    currentArchiveId: OriginalDiscArchiveId | undefined,
    querySource: Pick<typeof database, "select"> = database,
  ): MediaItemMaintenance[] {
    if (ids.length === 0) {
      return [];
    }
    if (ids.length > MEDIA_ITEM_SEARCH_LIMIT) {
      throw new DomainInvariantError(
        `Media Item maintenance is limited to ${MEDIA_ITEM_SEARCH_LIMIT} records`,
      );
    }
    const existingIds = querySource
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(inArray(mediaItems.id, [...ids]))
      .all()
      .map(({ id }) => id);
    const childCounts = new Map(
      querySource
        .select({ mediaItemId: mediaItems.parentId, value: count() })
        .from(mediaItems)
        .where(inArray(mediaItems.parentId, [...ids]))
        .groupBy(mediaItems.parentId)
        .all()
        .map((row) => [row.mediaItemId, row.value]),
    );
    const selectionCounts = new Map(
      querySource
        .select({
          mediaItemId: discSelections.mediaItemId,
          discSelectionReferenceCount: count(),
          referencedArchiveCount: countDistinct(
            discSelections.originalDiscArchiveId,
          ),
          otherArchiveCount: currentArchiveId === undefined
            ? countDistinct(discSelections.originalDiscArchiveId)
            : countDistinct(
              sql`case when ${discSelections.originalDiscArchiveId} <> ${
                currentArchiveId
              } then ${discSelections.originalDiscArchiveId} end`,
            ),
        })
        .from(discSelections)
        .where(inArray(discSelections.mediaItemId, [...ids]))
        .groupBy(discSelections.mediaItemId)
        .all()
        .map((row) => [row.mediaItemId, row]),
    );
    return existingIds.map((mediaItemId) => {
      const childCount = childCounts.get(mediaItemId) ?? 0;
      const selectionCount = selectionCounts.get(mediaItemId);
      const discSelectionReferenceCount =
        selectionCount?.discSelectionReferenceCount ?? 0;
      const reason = mediaItemDeletionReason(
        childCount,
        discSelectionReferenceCount,
      );
      return {
        mediaItemId,
        childCount,
        discSelectionReferenceCount,
        referencedArchiveCount: selectionCount?.referencedArchiveCount ?? 0,
        otherArchiveCount: selectionCount?.otherArchiveCount ?? 0,
        deletionAvailability: reason === null
          ? { state: "available", reason: null }
          : { state: "unavailable", reason },
      } satisfies MediaItemMaintenance;
    });
  }

  function insertDiscSelection(
    transaction: CatalogTransaction,
    input: CreateDiscSelectionInput,
    id: DiscSelectionId,
    timestamp: Date,
  ) {
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
    const sourceIdentity =
      createArchivedDvdSelectionValidator(source.scanData).validate(
        input.sourceIdentity,
      );
    const sourcePersistence =
      serializeDiscSelectionSourceIdentity(sourceIdentity);
    const duplicate = transaction
      .select({ id: discSelections.id })
      .from(discSelections)
      .where(and(
        eq(
          discSelections.originalDiscArchiveId,
          input.originalDiscArchiveId,
        ),
        eq(discSelections.sourceKey, sourcePersistence.sourceKey),
        eq(discSelections.isCatalogActive, true),
      ))
      .get();
    if (duplicate) {
      throw new DomainInvariantError(
        "A Disc Selection already maps this exact DVD source",
      );
    }
    return toDiscSelection(requireRow(
      transaction
        .insert(discSelections)
        .values({
          id,
          originalDiscArchiveId: input.originalDiscArchiveId,
          mediaItemId: input.mediaItemId,
          ...sourcePersistence,
          label: input.label,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get(),
      "disc selection",
      id,
    ));
  }

  function reopenCatalogReview(
    transaction: CatalogTransaction,
    archiveId: OriginalDiscArchiveId,
    timestamp: Date,
    expectedRevision?: Date,
    staleOperation = "Mapping Proposal",
  ): void {
    const changedArchive = transaction
      .update(originalDiscArchives)
      .set({
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
        updatedAt: nextCatalogMutationTimestamp(timestamp),
      })
      .where(and(
        eq(originalDiscArchives.id, archiveId),
        expectedRevision === undefined
          ? undefined
          : eq(originalDiscArchives.updatedAt, expectedRevision),
      ))
      .returning({ id: originalDiscArchives.id })
      .get();
    if (expectedRevision !== undefined && !changedArchive) {
      throw new DomainInvariantError(
        `Catalog review changed; reload before saving ${staleOperation}`,
      );
    }
  }

  function requestEncodeJobCancellation(
    transaction: CatalogTransaction,
    id: EncodeJobId,
    timestamp: Date,
  ): EncodeJob {
    const current = requireRow(
      transaction
        .select()
        .from(encodeJobs)
        .where(eq(encodeJobs.id, id))
        .get(),
      "encode job",
      id,
    );
    if (current.status !== "queued" && current.status !== "running") {
      throw new InvalidStatusTransitionError(
        "encode job",
        current.status,
        "cancelled",
      );
    }
    const claimToken = current.status === "running"
      ? current.claimToken
      : null;
    if (current.status === "running" && claimToken === null) {
      throw new DomainInvariantError(
        "Running Encode Job has no claim token",
      );
    }
    const requestedStatus = current.status === "running"
      ? "cancellation_requested" as const
      : "cancelled" as const;
    const updated = transaction
      .update(encodeJobs)
      .set({
        status: requestedStatus,
        reservesOutputPath: current.status === "queued"
          ? current.replaceExistingOutput
          : true,
        progressEtaSeconds: null,
        updatedAt: timestamp,
      })
      .where(and(
        eq(encodeJobs.id, id),
        eq(encodeJobs.status, current.status),
        claimToken !== null
          ? eq(encodeJobs.claimToken, claimToken)
          : undefined,
      ))
      .returning()
      .get();
    if (!updated) {
      throw new InvalidStatusTransitionError(
        "encode job",
        current.status,
        requestedStatus,
      );
    }
    return updated;
  }

  function validateAssistedMappingShape(
    transaction: CatalogTransaction,
    mediaItem: ValidatedMediaItem,
  ): void {
    const parent = mediaItem.parentId === null
      ? null
      : requireRow(
          transaction
            .select({ kind: mediaItems.kind })
            .from(mediaItems)
            .where(eq(mediaItems.id, mediaItem.parentId))
            .get(),
          "media item",
          mediaItem.parentId,
        );
    if (
      mediaItem.kind === "season" &&
      (mediaItem.seasonNumber === null || parent?.kind !== "tv_show")
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping requires a numbered Season beneath a TV Show",
      );
    }
    if (
      mediaItem.kind === "episode" &&
      (mediaItem.episodeNumber === null || parent?.kind !== "season")
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping requires a numbered Episode beneath a Season",
      );
    }
    if (
      (mediaItem.kind === "trailer" || mediaItem.kind === "bonus_feature") &&
      parent !== null &&
      !["movie", "tv_show", "season", "episode"].includes(parent.kind)
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping can attach a Trailer or Bonus Feature only to a Movie, TV Show, Season, or Episode",
      );
    }
  }

  function insertValidatedMediaItem(
    transaction: CatalogTransaction,
    input: Parameters<typeof validateMediaItem>[0],
    timestamp: Date,
    options: { requireAssistedMappingShape?: boolean } = {},
  ) {
    const values = validateMediaItem(
      input,
      transaction,
      { titleNormalization: "trim" },
    );
    if (options.requireAssistedMappingShape) {
      validateAssistedMappingShape(transaction, values);
    }
    return requireRow(
      transaction
        .insert(mediaItems)
        .values({
          id: input.id,
          ...values,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get(),
      "media item",
      input.id,
    );
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
          selection.sourceIdentity,
          { persistedSourceKey: row.sourceKey },
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

  function validateArchiveOnlyOutsideWriter(
    archiveId: OriginalDiscArchiveId,
  ): typeof originalDiscArchives.$inferSelect {
    return database.transaction((transaction) => {
      const archive = requireRow(
        transaction
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
      const activeSelection = transaction
        .select({ id: discSelections.id })
        .from(discSelections)
        .where(and(
          eq(discSelections.originalDiscArchiveId, archiveId),
          eq(discSelections.isCatalogActive, true),
        ))
        .limit(1)
        .get();
      if (activeSelection) {
        throw new DomainInvariantError(
          "Archive-only Review cannot contain Disc Selections",
        );
      }
      return archive;
    }, { behavior: "deferred" });
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
    mutationFence?: (
      querySource: Pick<typeof database, "select">,
    ) => void,
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
        mutationFence?.(transaction);
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
        assignDvdContentIdAlias(transaction, {
          originalDiscArchiveId: candidate.id,
          contentId: hashed.contentId,
          conflictMessages: {
            fingerprintOwner:
              "DVD content identity is already stored as a different Original Disc Archive fingerprint",
            aliasOwner:
              "DVD content identity is already assigned to a different Original Disc Archive",
          },
        });
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

  const listArchiveJobs = createBoundedChronologicalList<
    ArchiveJob,
    ArchiveJobStatus,
    ChronologicalListOptions
  >({
    activeStatuses: ["running"],
    historyStatuses: ["completed", "failed", "aborted"],
    chronologicalAt: (job) => job.updatedAt,
    readAll(statuses) {
      return database
        .select()
        .from(archiveJobs)
        .where(statuses?.length ? inArray(archiveJobs.status, statuses) : undefined)
        .orderBy(asc(archiveJobs.createdAt), asc(archiveJobs.id))
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(archiveJobs)
        .where(statuses?.length ? inArray(archiveJobs.status, statuses) : undefined)
        .orderBy(desc(archiveJobs.updatedAt), desc(archiveJobs.id))
        .limit(limit)
        .all();
    },
  });

  const listArchiveRequests = createBoundedChronologicalList<
    typeof archiveRequests.$inferSelect,
    ArchiveRequestStatus,
    ChronologicalListOptions
  >({
    activeStatuses: [
      "pending",
      "running",
      "needs_attention",
      "cancellation_requested",
    ],
    historyStatuses: ["fulfilled", "cancelled"],
    chronologicalAt: (request) => request.updatedAt,
    readAll(statuses) {
      return database
        .select()
        .from(archiveRequests)
        .where(
          statuses?.length
            ? inArray(archiveRequests.status, statuses)
            : undefined,
        )
        .orderBy(
          desc(archiveRequests.priority),
          asc(archiveRequests.createdAt),
          asc(archiveRequests.id),
        )
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(archiveRequests)
        .where(
          statuses?.length
            ? inArray(archiveRequests.status, statuses)
            : undefined,
        )
        .orderBy(desc(archiveRequests.updatedAt), desc(archiveRequests.id))
        .limit(limit)
        .all();
    },
  });

  const listEncodeJobs = createJobList<EncodeJob, EncodeJobStatus>({
    activeStatuses: ["queued", "running", "cancellation_requested"],
    historyStatuses: ["completed", "failed", "cancelled"],
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
            eq(
              originalDiscArchives.catalogReviewOutcome,
              "reviewed_with_selections",
            ),
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
      const effectiveOutputPath =
        expectedStatus === "completed" || current.replaceExistingOutput
          ? current.outputPath
          : options?.outputPath;
      const keepsOutputPath =
        effectiveOutputPath === undefined ||
        effectiveOutputPath === current.outputPath;
      const preservesTerminalReplacement =
        expectedStatus !== "completed" &&
        keepsOutputPath &&
        current.replaceExistingOutput;
      const targetOutputPath = effectiveOutputPath ?? current.outputPath;
      return database.transaction((transaction) => {
        const outputOwner = transaction
          .select({ id: encodeJobs.id })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.outputPath, targetOutputPath),
            eq(encodeJobs.reservesOutputPath, true),
            ne(encodeJobs.id, id),
          ))
          .limit(1)
          .get();
        if (outputOwner) {
          throw new DomainInvariantError(
            `Encode Job output is already assigned: ${targetOutputPath}`,
          );
        }
        return transaction
          .update(encodeJobs)
          .set({
            ...update,
            outputPath: effectiveOutputPath,
            reservesOutputPath: true,
            priority: options?.priority,
            progressPhase: null,
            progressEtaSeconds: null,
            replaceExistingOutput:
              (expectedStatus === "completed" && keepsOutputPath) ||
              preservesTerminalReplacement,
            replacementOutputIdentity: preservesTerminalReplacement
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
                transaction
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
                      eq(
                        originalDiscArchives.catalogReviewOutcome,
                        "reviewed_with_selections",
                      ),
                      eq(originalDiscArchives.legacyCutoverPending, false),
                    ),
                  ),
              ),
            ),
          )
          .returning()
          .get();
      }, { behavior: "immediate" });
    },
  } satisfies JobQueueAdapter<
    EncodeJob,
    RunningEncodeJob,
    EncodeJobId,
    EncodeJobClaimToken,
    void,
    EncodeJobRequeueOptions,
    void,
    Pick<EncodeJobProgress, "etaSeconds" | "phase">,
    EncodeJobFailureOptions
  >;

  const encodeJobQueue = createJobQueueController({
    adapter: encodeJobAdapter,
    createToken: () => newId<EncodeJobClaimToken>(),
    now,
    requeueFrom: ["failed", "completed", "cancelled"],
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

  function createArchiveRequest(input: {
    detectedDiscId: DetectedDiscId;
    priority?: number;
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
        findOriginalArchiveByFingerprintOrContentIdAlias(
          disc.fingerprint,
          transaction,
        )
      ) {
        throw new DomainInvariantError(
          "A Detected Disc with existing archive provenance cannot be requested",
        );
      }
      if (disc.status !== "scanned" && disc.status !== "approved") {
        throw new InvalidStatusTransitionError(
          "detected disc",
          disc.status,
          "approved",
        );
      }
      requireLegacyDvdArchiveIdentitiesResolved(
        disc.discKind,
        disc.fingerprint,
        transaction,
      );
      if (disc.status === "scanned") {
        requireRow(
          transaction
            .update(detectedDiscs)
            .set({ status: "approved", updatedAt: timestamp })
            .where(
              and(
                eq(detectedDiscs.id, disc.id),
                eq(detectedDiscs.status, "scanned"),
              ),
            )
            .returning({ id: detectedDiscs.id })
            .get(),
          "detected disc",
          disc.id,
        );
      }

      const existing = transaction
        .select()
        .from(archiveRequests)
        .where(
          and(
            eq(archiveRequests.detectedDiscId, disc.id),
            inArray(archiveRequests.status, [
              "pending",
              "running",
              "needs_attention",
              "cancellation_requested",
            ]),
          ),
        )
        .get();
      if (existing) {
        if (
          input.priority !== undefined &&
          existing.status === "pending" &&
          input.priority !== existing.priority
        ) {
          return requireRow(
            transaction
              .update(archiveRequests)
              .set({ priority: input.priority, updatedAt: timestamp })
              .where(
                and(
                  eq(archiveRequests.id, existing.id),
                  eq(archiveRequests.status, "pending"),
                ),
              )
              .returning()
              .get(),
            "archive request",
            existing.id,
          );
        }
        return existing;
      }
      return requireRow(
        transaction
          .insert(archiveRequests)
          .values({
            id: newId<ArchiveRequestId>(),
            detectedDiscId: disc.id,
            priority: input.priority ?? 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning()
          .get(),
        "archive request",
        disc.id,
      );
    }, { behavior: "immediate" });
  }

  const archiveProgress = new Map<
    ArchiveJobId,
    {
      token: ArchiveJobClaimToken;
      latestPercent: number;
      latestPhase: ArchiveJob["progressPhase"];
      persistedPercent: number;
      persistedPhase: ArchiveJob["progressPhase"];
      persistedAt: number;
    }
  >();
  const inspectionProgress = new Map<
    DiscInspectionId,
    {
      latestBytes: number;
      latestBytesPerSecond: number | null;
      latestEtaSeconds: number | null;
      persistedAt: number;
      persistedBytes: number;
      token: DiscInspectionClaimToken;
    }
  >();
  let expiredCancellationCursor:
    | { id: ArchiveJobId; updatedAt: Date }
    | undefined;

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
          listCatalogReviewArchives: (options) =>
            access.catalog.listCatalogReviewArchives(options),
          listMediaItems: (options) => access.catalog.listMediaItems(options),
          listMediaItemMaintenance: (options) =>
            access.catalog.listMediaItemMaintenance(options),
          searchMediaItems: (options) =>
            access.catalog.searchMediaItems(options),
          listDiscSelections: (options) =>
            access.catalog.listDiscSelections(options),
          listDiscSelectionSupersessions: (options) =>
            access.catalog.listDiscSelectionSupersessions(options),
          listDiscSelectionActionAvailability: (options) =>
            access.catalog.listDiscSelectionActionAvailability(options),
        },
        encodingProfiles: {
          list: (input) => access.encodingProfiles.list(input),
        },
        discInspections: {
          list: (options) => access.discInspections.list(options),
        },
      archiveRequests: {
          list: (statuses, options) =>
            access.archiveRequests.list(statuses, options),
          listRelevantForDetectedDiscs: (detectedDiscIds) =>
            access.archiveRequests.listRelevantForDetectedDiscs(
              detectedDiscIds,
            ),
        },
        archiveJobs: {
          list: (statuses, options) => access.archiveJobs.list(statuses, options),
          listLatestForRequests: (archiveRequestIds) =>
            access.archiveJobs.listLatestForRequests(archiveRequestIds),
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
              id: opticalDrives.id,
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
            if (decision.existingId !== undefined) {
              transaction
                .update(opticalDrives)
                .set({
                  devicePath: drive.devicePath,
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
                })
                .where(eq(opticalDrives.id, decision.existingId))
                .run();
            } else {
              transaction.insert(opticalDrives).values({
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
              }).run();
            }
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
        return database.transaction((transaction) => {
          const existing = transaction
            .select({ id: opticalDrives.id })
            .from(opticalDrives)
            .where(eq(opticalDrives.devicePath, devicePath))
            .orderBy(
              desc(opticalDrives.isPresent),
              desc(opticalDrives.lastSeenAt),
            )
            .limit(1)
            .get();
          if (existing !== undefined) {
            const updated = transaction
              .update(opticalDrives)
              .set({
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
              })
              .where(eq(opticalDrives.id, existing.id))
              .returning(opticalDriveSelection)
              .get();
            return requireRow(updated, "optical drive", devicePath);
          }
          const inserted = transaction
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
            .returning(opticalDriveSelection)
            .get();
          return requireRow(inserted, "optical drive", devicePath);
        }, { behavior: "immediate" });
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
              contentIdentityArchive,
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
              .update(archiveRequests)
              .set({
                status: "fulfilled",
                fulfilledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  inArray(archiveRequests.status, [
                    "pending",
                    "needs_attention",
                  ]),
                  exists(
                    transaction
                      .select({ id: detectedDiscs.id })
                      .from(detectedDiscs)
                      .where(
                        and(
                          eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                          eq(detectedDiscs.fingerprint, fingerprint),
                        ),
                      ),
                  ),
                ),
              )
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
          createArchiveRequest({ detectedDiscId: id });
          return requireRow(
            database
              .select()
              .from(detectedDiscs)
              .where(eq(detectedDiscs.id, id))
              .get(),
            "detected disc",
            id,
          );
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
          const timestamp = now();
          transaction
            .update(archiveRequests)
            .set({
              status: "cancelled",
              cancellationRequestedAt: timestamp,
              cancelledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveRequests.detectedDiscId, id),
                inArray(archiveRequests.status, ["pending", "needs_attention"]),
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
            .update(archiveRequests)
            .set({
              status: "fulfilled",
              fulfilledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(archiveRequests.status, ["pending", "needs_attention"]),
                exists(
                  transaction
                    .select({ id: detectedDiscs.id })
                    .from(detectedDiscs)
                    .where(
                      and(
                        eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                        eq(detectedDiscs.fingerprint, fingerprint),
                      ),
                    ),
                ),
              ),
            )
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
            ? eq(originalDiscArchives.catalogReviewOutcome, "needs_review")
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

      listCatalogReviewArchives(options) {
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > CATALOG_REVIEW_ARCHIVE_LIMIT
        ) {
          throw new DomainInvariantError(
            `Catalog Review archive limit must be between 1 and ${CATALOG_REVIEW_ARCHIVE_LIMIT}`,
          );
        }
        if (options.outcome !== undefined && options.view !== "reviewed") {
          throw new DomainInvariantError(
            "Catalog Review outcome filter requires the Reviewed view",
          );
        }
        const searchQuery = options.query === undefined
          ? undefined
          : requireNonEmpty(options.query, "query");
        if (searchQuery !== undefined && searchQuery.length > 256) {
          throw new DomainInvariantError(
            "Catalog Review search query must be at most 256 characters",
          );
        }
        const normalizedQuery = searchQuery === undefined
          ? undefined
          : normalizeMediaItemSearchTitle(searchQuery);
        if (normalizedQuery !== undefined && normalizedQuery.length === 0) {
          throw new DomainInvariantError(
            "Catalog Review search query must contain a letter or number",
          );
        }
        const searchPattern = normalizedQuery === undefined
          ? undefined
          : `%${normalizedQuery.replaceAll(" ", "%")}%`;
        const normalizedDiscLabel =
          sql`rip_dvd_normalize_media_item_title(${detectedDiscs.volumeLabel})`;
        const normalizedMediaTitle =
          sql`rip_dvd_normalize_media_item_title(${mediaItems.title})`;
        const conditions = [
          options.view === "needs_review"
            ? eq(originalDiscArchives.catalogReviewOutcome, "needs_review")
            : ne(originalDiscArchives.catalogReviewOutcome, "needs_review"),
          options.outcome === undefined
            ? undefined
            : eq(originalDiscArchives.catalogReviewOutcome, options.outcome),
          searchPattern === undefined
            ? undefined
            : or(
                sql`${normalizedDiscLabel} like ${searchPattern}`,
                exists(
                  database
                    .select({ id: discSelections.id })
                    .from(discSelections)
                    .innerJoin(
                      mediaItems,
                      eq(mediaItems.id, discSelections.mediaItemId),
                    )
                    .where(and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        originalDiscArchives.id,
                      ),
                      eq(discSelections.isCatalogActive, true),
                      sql`${normalizedMediaTitle} like ${searchPattern}`,
                    )),
                ),
              ),
          options.cursor
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
                    ? options.cursor.inclusive
                      ? lte(originalDiscArchives.id, options.cursor.id)
                      : lt(originalDiscArchives.id, options.cursor.id)
                    : options.cursor.inclusive
                      ? gte(originalDiscArchives.id, options.cursor.id)
                      : gt(originalDiscArchives.id, options.cursor.id),
                ),
              )
            : undefined,
        ].filter((condition) => condition !== undefined);
        const readsNewer = options.cursor?.direction === "newer";
        const rows = database
          .select({
            archive: originalDiscArchives,
            discLabel: detectedDiscs.volumeLabel,
          })
          .from(originalDiscArchives)
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
          )
          .where(and(...conditions))
          .orderBy(
            ...(readsNewer
              ? [
                  asc(originalDiscArchives.archivedAt),
                  asc(originalDiscArchives.id),
                ]
              : [
                  desc(originalDiscArchives.archivedAt),
                  desc(originalDiscArchives.id),
                ]),
          )
          .limit(options.limit)
          .all();
        const orderedRows = readsNewer ? rows : rows.reverse();
        return orderedRows.map(({ archive, discLabel }) => {
          const activeSelectionCondition = and(
            eq(discSelections.originalDiscArchiveId, archive.id),
            eq(discSelections.isCatalogActive, true),
          );
          const mappedMediaItemCount = database
            .select({ count: countDistinct(discSelections.mediaItemId) })
            .from(discSelections)
            .where(activeSelectionCondition)
            .get()?.count ?? 0;
          const mappedMediaItemTitles = database
            .selectDistinct({ title: mediaItems.title })
            .from(discSelections)
            .innerJoin(mediaItems, eq(mediaItems.id, discSelections.mediaItemId))
            .where(activeSelectionCondition)
            .orderBy(asc(mediaItems.title), asc(mediaItems.id))
            .limit(CATALOG_REVIEW_MAPPED_TITLE_SUMMARY_LIMIT)
            .all()
            .map(({ title }) => title);
          return {
            ...archive,
            discLabel: discLabel ?? "Unlabeled disc",
            mappedMediaItemCount,
            mappedMediaItemTitles,
          };
        });
      },

      completeCatalogReview(id, catalogRevision, outcome) {
        if (
          !(catalogRevision instanceof Date) ||
          !Number.isSafeInteger(catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Catalog review revision must be a valid timestamp",
          );
        }
        if (
          outcome !== "reviewed_with_selections" &&
          outcome !== "archive_only"
        ) {
          throw new DomainInvariantError(
            "Catalog review outcome must be reviewed with selections or Archive only",
          );
        }
        const timestamp = now();
        const validatedArchive = outcome === "reviewed_with_selections"
          ? validateDiscSelectionsOutsideWriter(id)
          : validateArchiveOnlyOutsideWriter(id);
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
            if (archive.catalogReviewOutcome === outcome) {
              return archive;
            }
            throw new DomainInvariantError(
              "Catalog review already has a different completed outcome",
            );
          }
          const completed = transaction
            .update(originalDiscArchives)
            .set({
              catalogReviewedAt: timestamp,
              catalogReviewOutcome: outcome,
              updatedAt: nextCatalogMutationTimestamp(timestamp),
            })
            .where(
              and(
                eq(originalDiscArchives.id, id),
                eq(originalDiscArchives.updatedAt, catalogRevision),
                isNull(originalDiscArchives.catalogReviewedAt),
                eq(originalDiscArchives.catalogReviewOutcome, "needs_review"),
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
        return database.transaction((transaction) =>
          insertValidatedMediaItem(
            transaction,
            { ...input, id },
            timestamp,
          ), { behavior: "immediate" });
      },

      createMappingProposal(input) {
        if (
          !(input.catalogRevision instanceof Date) ||
          !Number.isSafeInteger(input.catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Mapping Proposal catalog revision must be a valid timestamp",
          );
        }
        const timestamp = now();
        const mediaItemId = newId<MediaItemId>();
        const discSelectionId = newId<DiscSelectionId>();
        return database.transaction((transaction) => {
          const currentArchive = requireRow(
            transaction
              .select({ updatedAt: originalDiscArchives.updatedAt })
              .from(originalDiscArchives)
              .where(eq(
                originalDiscArchives.id,
                input.originalDiscArchiveId,
              ))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          if (
            currentArchive.updatedAt.getTime() !==
              input.catalogRevision.getTime()
          ) {
            throw new DomainInvariantError(
              "Catalog review changed; reload before saving Mapping Proposal",
            );
          }

          const label = input.discSelection.label === undefined
            ? undefined
            : requireNonEmpty(input.discSelection.label, "label");

          const mediaItem = input.existingMediaItemId === undefined
            ? insertValidatedMediaItem(
                transaction,
                { ...input.mediaItem, id: mediaItemId },
                timestamp,
                { requireAssistedMappingShape: true },
              )
            : requireRow(
              transaction
                .select()
                .from(mediaItems)
                .where(eq(mediaItems.id, input.existingMediaItemId))
                .get(),
              "media item",
              input.existingMediaItemId,
            );
          const discSelection = insertDiscSelection(
            transaction,
            {
              originalDiscArchiveId: input.originalDiscArchiveId,
              mediaItemId: mediaItem.id,
              sourceIdentity: input.discSelection.sourceIdentity,
              ...(label === undefined ? {} : { label }),
            },
            discSelectionId,
            timestamp,
          );
          reopenCatalogReview(
            transaction,
            input.originalDiscArchiveId,
            timestamp,
            input.catalogRevision,
          );
          return { mediaItem, discSelection };
        }, { behavior: "immediate" });
      },

      createEpisodicMappingProposal(input) {
        if (
          !(input.catalogRevision instanceof Date) ||
          !Number.isSafeInteger(input.catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Episodic Mapping Proposal catalog revision must be a valid timestamp",
          );
        }
        if (
          !Array.isArray(input.episodes) ||
          input.episodes.length === 0 ||
          input.episodes.length > MAX_DVD_TITLES
        ) {
          throw new DomainInvariantError(
            `Episodic Mapping Proposal requires between 1 and ${MAX_DVD_TITLES} Episodes`,
          );
        }
        const timestamp = now();
        return database.transaction((transaction) => {
          const currentArchive = requireRow(
            transaction
              .select({ updatedAt: originalDiscArchives.updatedAt })
              .from(originalDiscArchives)
              .where(eq(
                originalDiscArchives.id,
                input.originalDiscArchiveId,
              ))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          if (
            currentArchive.updatedAt.getTime() !==
              input.catalogRevision.getTime()
          ) {
            throw new DomainInvariantError(
              "Catalog review changed; reload before saving Episodic Mapping Proposal",
            );
          }

          const createMediaItem = (
            candidate: Omit<Parameters<typeof validateMediaItem>[0], "id">,
          ) => {
            const id = newId<MediaItemId>();
            return insertValidatedMediaItem(
              transaction,
              { ...candidate, id },
              timestamp,
            );
          };
          const readMediaItem = (id: MediaItemId) => requireRow(
            transaction
              .select()
              .from(mediaItems)
              .where(eq(mediaItems.id, id))
              .get(),
            "media item",
            id,
          );

          const tvShow = input.tvShow.choice === "create_new"
            ? createMediaItem({
                kind: "tv_show",
                title: input.tvShow.title,
                year: input.tvShow.year,
              })
            : readMediaItem(input.tvShow.mediaItemId);
          if (tvShow.kind !== "tv_show") {
            throw new DomainInvariantError(
              "Episodic Mapping Proposal requires a TV Show",
            );
          }

          const season = input.season.choice === "create_new"
            ? createMediaItem({
                parentId: tvShow.id,
                kind: "season",
                title: input.season.title,
                seasonNumber: input.season.seasonNumber,
              })
            : readMediaItem(input.season.mediaItemId);
          if (
            season.kind !== "season" ||
            season.seasonNumber === null ||
            season.parentId !== tvShow.id
          ) {
            throw new DomainInvariantError(
              "Episodic Mapping Proposal requires a numbered Season beneath the selected TV Show",
            );
          }

          const episodes = input.episodes.map((episode) => {
            const mediaItem = createMediaItem({
              parentId: season.id,
              kind: "episode",
              title: episode.title,
              episodeNumber: episode.episodeNumber,
            });
            validateAssistedMappingShape(transaction, {
              parentId: mediaItem.parentId,
              kind: mediaItem.kind,
              title: mediaItem.title,
              year: mediaItem.year,
              seasonNumber: mediaItem.seasonNumber,
              episodeNumber: mediaItem.episodeNumber,
            });
            const label = episode.label === undefined
              ? undefined
              : requireNonEmpty(episode.label, "label");
            const discSelection = insertDiscSelection(
              transaction,
              {
                originalDiscArchiveId: input.originalDiscArchiveId,
                mediaItemId: mediaItem.id,
                sourceIdentity: {
                  kind: "dvd_title",
                  titleNumber: episode.titleNumber,
                },
                ...(label === undefined ? {} : { label }),
              },
              newId<DiscSelectionId>(),
              timestamp,
            );
            return { mediaItem, discSelection };
          });
          reopenCatalogReview(
            transaction,
            input.originalDiscArchiveId,
            timestamp,
            input.catalogRevision,
          );
          return { tvShow, season, episodes };
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

      deleteMediaItem(id) {
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
          const maintenance = readMediaItemMaintenance(
            [id],
            undefined,
            transaction,
          )[0]!;
          if (maintenance.deletionAvailability.state === "unavailable") {
            throw new DomainInvariantError(
              `Media Item deletion is unavailable: ${
                maintenance.deletionAvailability.reason
              }`,
            );
          }
          requireRow(
            transaction
              .delete(mediaItems)
              .where(eq(mediaItems.id, id))
              .returning({ id: mediaItems.id })
              .get(),
            "media item",
            id,
          );
          return current;
        }, { behavior: "immediate" });
      },

      listMediaItemMaintenance(options) {
        return readMediaItemMaintenance(
          options.ids,
          options.currentArchiveId,
        );
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

      searchMediaItems(options) {
        const searchQuery = requireNonEmpty(options.query, "query");
        if (searchQuery.length > 256) {
          throw new DomainInvariantError(
            "Media Item search query must be at most 256 characters",
          );
        }
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > MEDIA_ITEM_SEARCH_LIMIT
        ) {
          throw new DomainInvariantError(
            `Media Item search limit must be a safe integer between 1 and ${MEDIA_ITEM_SEARCH_LIMIT}`,
          );
        }
        const normalizedQuery = normalizeMediaItemSearchTitle(searchQuery);
        if (normalizedQuery.length === 0) {
          throw new DomainInvariantError(
            "Media Item search query must contain a letter or number",
          );
        }
        const pattern = `%${normalizedQuery.replaceAll(" ", "%")}%`;
        const normalizedTitle =
          sql`rip_dvd_normalize_media_item_title(${mediaItems.title})`;
        const query = database
          .select()
          .from(mediaItems)
          .where(sql`${normalizedTitle} like ${pattern}`)
          .orderBy(
            sql`case
              when ${mediaItems.title} = ${searchQuery} then 0
              when ${normalizedTitle} = ${normalizedQuery} then 1
              else 2
            end`,
            asc(mediaItems.title),
            asc(mediaItems.id),
          );
        return listWithBoundedOffset(query, options, "Media Item search");
      },

      createDiscSelection(input) {
        const timestamp = now();
        const id = newId<DiscSelectionId>();
        return database.transaction(
          (transaction) => {
            const selection = insertDiscSelection(
              transaction,
              input,
              id,
              timestamp,
            );
            reopenCatalogReview(
              transaction,
              input.originalDiscArchiveId,
              timestamp,
            );
            return selection;
          },
          { behavior: "immediate" },
        );
      },

      correctDiscSelection(id, input) {
        const timestamp = now();
        const reason = input.reason === undefined
          ? null
          : requireNonEmpty(input.reason, "reason");
        if (reason !== null && reason.length > 1_000) {
          throw new DomainInvariantError(
            "Disc Selection correction reason must be at most 1000 characters",
          );
        }
        return database.transaction((transaction) => {
          const current = requireRow(
            transaction
              .select()
              .from(discSelections)
              .where(eq(discSelections.id, id))
              .get(),
            "disc selection",
            id,
          );
          if (!current.isCatalogActive) {
            throw new DomainInvariantError(
              `Disc Selection ${id} has already been superseded or deactivated`,
            );
          }
          if (current.originalDiscArchiveId !== input.originalDiscArchiveId) {
            throw new DomainInvariantError(
              "A Disc Selection correction cannot move between Original Disc Archives",
            );
          }
          const source = requireRow(
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
          if (
            requiresLegacyDiscSelectionRepair(
              current,
              createArchivedDvdSelectionValidator(source.scanData),
            )
          ) {
            throw new DomainInvariantError(
              `Disc Selection ${id} needs unsafe legacy repair, not ordinary correction`,
            );
          }
          const historicalJob = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(eq(encodeJobs.discSelectionId, id))
            .limit(1)
            .get();
          if (!historicalJob) {
            throw new DomainInvariantError(
              `Disc Selection ${id} has no Encode Job history and can be corrected directly`,
            );
          }
          reopenCatalogReview(
            transaction,
            input.originalDiscArchiveId,
            timestamp,
            input.catalogRevision,
            "Disc Selection correction",
          );
          requireRow(
            transaction
              .update(discSelections)
              .set({ isCatalogActive: false, updatedAt: timestamp })
              .where(and(
                eq(discSelections.id, id),
                eq(discSelections.isCatalogActive, true),
              ))
              .returning({ id: discSelections.id })
              .get(),
            "disc selection",
            id,
          );
          const replacementId = newId<DiscSelectionId>();
          const discSelection = insertDiscSelection(
            transaction,
            input,
            replacementId,
            timestamp,
          );
          const supersession = requireRow(
            transaction
              .insert(discSelectionSupersessions)
              .values({
                supersededDiscSelectionId: id,
                replacementDiscSelectionId: replacementId,
                reason,
                createdAt: timestamp,
              })
              .returning()
              .get(),
            "disc selection supersession",
            id,
          );
          const activeJobs = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(and(
              eq(encodeJobs.discSelectionId, id),
              inArray(encodeJobs.status, ["queued", "running"]),
            ))
            .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
            .all();
          for (const job of activeJobs) {
            requestEncodeJobCancellation(transaction, job.id, timestamp);
          }
          return {
            discSelection,
            supersession: supersession satisfies DiscSelectionSupersession,
          };
        }, { behavior: "immediate" });
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
                  inArray(encodeJobs.status, [
                    "queued",
                    "running",
                    "cancellation_requested",
                  ]),
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
            const sourceIdentity = validator.validate(
              input.sourceIdentity,
            );
            const sourcePersistence =
              serializeDiscSelectionSourceIdentity(sourceIdentity);
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
                    ...sourcePersistence,
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
                    ...sourcePersistence,
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
                catalogReviewOutcome: "needs_review",
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
              const preservedSupersession = transaction
                .select({
                  supersededDiscSelectionId:
                    discSelectionSupersessions.supersededDiscSelectionId,
                })
                .from(discSelectionSupersessions)
                .where(or(
                  eq(
                    discSelectionSupersessions.supersededDiscSelectionId,
                    id,
                  ),
                  eq(
                    discSelectionSupersessions.replacementDiscSelectionId,
                    id,
                  ),
                ))
                .limit(1)
                .get();
              if (preservedSupersession) {
                requireRow(
                  transaction
                    .update(discSelections)
                    .set({ isCatalogActive: false, updatedAt: timestamp })
                    .where(and(
                      eq(discSelections.id, id),
                      eq(discSelections.isCatalogActive, true),
                    ))
                    .returning({ id: discSelections.id })
                    .get(),
                  "disc selection",
                  id,
                );
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
            }
            transaction
              .update(originalDiscArchives)
              .set({
                catalogReviewedAt: null,
                catalogReviewOutcome: "needs_review",
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
                      eq(
                        originalDiscArchives.catalogReviewOutcome,
                        "reviewed_with_selections",
                      ),
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

      listDiscSelectionSupersessions(options) {
        if (options.discSelectionIds.length === 0) {
          return [];
        }
        if (
          options.discSelectionIds.length > DISC_SELECTION_SUPERSESSION_LIMIT
        ) {
          throw new DomainInvariantError(
            `Disc Selection supersession lookup is limited to ${DISC_SELECTION_SUPERSESSION_LIMIT} records`,
          );
        }
        return database
          .select()
          .from(discSelectionSupersessions)
          .where(or(
            inArray(
              discSelectionSupersessions.supersededDiscSelectionId,
              [...options.discSelectionIds],
            ),
            inArray(
              discSelectionSupersessions.replacementDiscSelectionId,
              [...options.discSelectionIds],
            ),
          ))
          .orderBy(
            asc(discSelectionSupersessions.createdAt),
            asc(discSelectionSupersessions.supersededDiscSelectionId),
          )
          .all();
      },

      listDiscSelectionActionAvailability(options) {
        if (options.ids.length === 0) {
          return [];
        }
        if (options.ids.length > DISC_SELECTION_ACTION_AVAILABILITY_LIMIT) {
          throw new DomainInvariantError(
            `Disc Selection action availability is limited to ${DISC_SELECTION_ACTION_AVAILABILITY_LIMIT} records`,
          );
        }
        const selectionStates = database
          .select({
            selection: discSelections,
            scanData: detectedDiscs.scanData,
            legacyCutoverPending:
              originalDiscArchives.legacyCutoverPending,
          })
          .from(discSelections)
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
          )
          .where(and(
            inArray(discSelections.id, [...options.ids]),
            eq(discSelections.isCatalogActive, true),
          ))
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
          .all();

        return selectionStates.map(({
          selection,
          scanData,
          legacyCutoverPending,
        }) => {
          const relatedEncodeJob = database
            .select({ id: encodeJobs.id, status: encodeJobs.status })
            .from(encodeJobs)
            .where(eq(encodeJobs.discSelectionId, selection.id))
            .orderBy(
              sql`case ${encodeJobs.status} when 'cancellation_requested' then 0 when 'running' then 1 when 'queued' then 2 when 'completed' then 3 else 4 end`,
              asc(encodeJobs.createdAt),
              asc(encodeJobs.id),
            )
            .limit(1)
            .get() ?? null;
          const needsRepair = requiresLegacyDiscSelectionRepair(
            selection,
            createArchivedDvdSelectionValidator(scanData),
          );
          const activeJob = relatedEncodeJob?.status === "queued" ||
              relatedEncodeJob?.status === "running" ||
              relatedEncodeJob?.status === "cancellation_requested"
            ? relatedEncodeJob as {
              id: EncodeJobId;
              status: "queued" | "running" | "cancellation_requested";
            }
            : null;

          if (legacyCutoverPending) {
            return {
              discSelectionId: selection.id,
              state: "changes_unavailable",
              availableActions: [],
              reason:
                "Disc Selection changes are unavailable while legacy cutover repair is pending",
              relatedEncodeJob: null,
            } satisfies DiscSelectionActionAvailability;
          }
          if (needsRepair) {
            return {
              discSelectionId: selection.id,
              state: "needs_repair",
              availableActions: activeJob === null
                ? ["repair", "remove"]
                : [],
              reason: activeJob === null
                ? "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review"
                : `Encode Job ${activeJob.id} is ${activeJob.status}; this unsafe legacy Disc Selection needs repair, but direct mutation is unavailable while the job is active`,
              relatedEncodeJob: activeJob,
            } satisfies DiscSelectionActionAvailability;
          }
          if (relatedEncodeJob !== null) {
            return {
              discSelectionId: selection.id,
              state: "locked_provenance",
              availableActions: ["correct"],
              reason: activeJob === null
                ? `Encode Job ${relatedEncodeJob.id} is ${relatedEncodeJob.status}; correct this Disc Selection by supersession to preserve its provenance`
                : `Encode Job ${activeJob.id} is ${activeJob.status}; correcting by supersession will request cancellation and preserve its provenance`,
              relatedEncodeJob,
            } satisfies DiscSelectionActionAvailability;
          }
          return {
            discSelectionId: selection.id,
            state: "editable",
            availableActions: ["correct", "edit_label", "remove"],
            reason: null,
            relatedEncodeJob: null,
          } satisfies DiscSelectionActionAvailability;
        });
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

    discInspections: {
      beginOrResume(input) {
        const timestamp = now();
        const mediaGeneration = requireNonEmpty(
          input.mediaGeneration,
          "mediaGeneration",
        );
        if (mediaGeneration.length > 64) {
          throw new DomainInvariantError(
            "mediaGeneration must contain at most 64 characters",
          );
        }
        return database.transaction((transaction) => {
          const drive = requireRow(
            transaction
              .select()
              .from(opticalDrives)
              .where(eq(opticalDrives.id, input.opticalDriveId))
              .get(),
            "optical drive",
            input.opticalDriveId,
          );
          if (!drive.isPresent || !drive.isEnabled) {
            throw new DomainInvariantError(
              "Disc Inspection requires an enabled, present Optical Drive",
            );
          }
          let current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.opticalDriveId, input.opticalDriveId),
                eq(discInspections.isCurrent, true),
              ),
            )
            .get();
          if (current && current.mediaGeneration !== mediaGeneration) {
            if (current.status === "running") {
              transaction
                .insert(discInspectionAttempts)
                .values({
                  id: newId<DiscInspectionAttemptId>(),
                  discInspectionId: current.id,
                  attemptNumber: current.attemptCount,
                  outcome: "aborted",
                  phase: current.phase,
                  reasonCode: "media_changed",
                  startedAt: current.attemptStartedAt,
                  endedAt: timestamp,
                })
                .onConflictDoNothing()
                .run();
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  status: "aborted",
                  reasonCode: "media_changed",
                  diagnostic: null,
                  retryAt: null,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                    eq(discInspections.status, "running"),
                  ),
                )
                .run();
            } else {
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  manualRetryRequestedAt: null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                  ),
                )
                .run();
            }
            inspectionProgress.delete(current.id);
            current = undefined;
          }

          if (current) {
            if (
              current.status === "failed" &&
              current.manualRetryRequestedAt !== null
            ) {
              current = requireRow(
                transaction
                  .update(discInspections)
                  .set({
                    status: "running",
                    phase: "retry_wait",
                    consecutiveFailureCount: 0,
                    retryAt: timestamp,
                    manualRetryRequestedAt: null,
                    reasonCode: null,
                    diagnostic: null,
                    completedAt: null,
                    phaseStartedAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .where(
                    and(
                      eq(discInspections.id, current.id),
                      eq(discInspections.status, "failed"),
                      eq(discInspections.isCurrent, true),
                      isNotNull(discInspections.manualRetryRequestedAt),
                    ),
                  )
                  .returning()
                  .get(),
                "disc inspection",
                current.id,
              );
            }
            if (current.status !== "running") {
              return { inspection: current, claim: null };
            }
            if (
              current.retryAt !== null &&
              current.retryAt.getTime() > timestamp.getTime()
            ) {
              return { inspection: current, claim: null };
            }
            const expiredBefore = new Date(
              timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
            );
            if (
              current.claimToken !== null &&
              current.claimUpdatedAt !== null &&
              current.claimUpdatedAt > expiredBefore
            ) {
              return { inspection: current, claim: null };
            }
            if (current.claimToken !== null) {
              transaction
                .insert(discInspectionAttempts)
                .values({
                  id: newId<DiscInspectionAttemptId>(),
                  discInspectionId: current.id,
                  attemptNumber: current.attemptCount,
                  outcome: "interrupted",
                  phase: current.phase,
                  reasonCode: "worker_interrupted",
                  startedAt: current.attemptStartedAt,
                  endedAt: timestamp,
                })
                .onConflictDoNothing()
                .run();
            }
            inspectionProgress.delete(current.id);
            const claimToken = newId<DiscInspectionClaimToken>();
            const resumed = requireRow(
              transaction
                .update(discInspections)
                .set({
                  phase: "reading_metadata",
                  attemptCount: current.attemptCount + 1,
                  bytesHashed: null,
                  bytesPerSecond: null,
                  etaSeconds: null,
                  retryAt: null,
                  reasonCode: null,
                  diagnostic: null,
                  claimToken,
                  claimUpdatedAt: timestamp,
                  phaseStartedAt: timestamp,
                  attemptStartedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.status, "running"),
                    eq(discInspections.isCurrent, true),
                    current.claimToken === null
                      ? isNull(discInspections.claimToken)
                      : eq(discInspections.claimToken, current.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            return {
              inspection: resumed,
              claim: {
                id: resumed.id,
                opticalDriveId: resumed.opticalDriveId,
                mediaGeneration: resumed.mediaGeneration,
                claimToken,
              },
            };
          }

          const claimToken = newId<DiscInspectionClaimToken>();
          const id = newId<DiscInspectionId>();
          const inspection = requireRow(
            transaction
              .insert(discInspections)
              .values({
                id,
                opticalDriveId: input.opticalDriveId,
                mediaGeneration,
                claimToken,
                claimUpdatedAt: timestamp,
                phaseStartedAt: timestamp,
                attemptStartedAt: timestamp,
                startedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "disc inspection",
            id,
          );
          return {
            inspection,
            claim: {
              id,
              opticalDriveId: input.opticalDriveId,
              mediaGeneration,
              claimToken,
            },
          };
        }, { behavior: "immediate" });
      },

      renew(claim) {
        const timestamp = now();
        const renewed = database
          .update(discInspections)
          .set({ claimUpdatedAt: timestamp, updatedAt: timestamp })
          .where(
            and(
              eq(discInspections.id, claim.id),
              eq(discInspections.opticalDriveId, claim.opticalDriveId),
              eq(discInspections.mediaGeneration, claim.mediaGeneration),
              eq(discInspections.status, "running"),
              eq(discInspections.isCurrent, true),
              eq(discInspections.claimToken, claim.claimToken),
              gt(
                discInspections.claimUpdatedAt,
                new Date(
                  timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("disc inspection", claim.id);
        }
        return renewed;
      },

      record(claim, event) {
        const timestamp = now();
        const diagnostic =
          "diagnostic" in event && event.diagnostic !== undefined
            ? event.diagnostic.trim().slice(0, 500) || null
            : null;
        return database.transaction((transaction) => {
          const current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.id, claim.id),
                eq(discInspections.opticalDriveId, claim.opticalDriveId),
                eq(discInspections.mediaGeneration, claim.mediaGeneration),
                eq(discInspections.status, "running"),
                eq(discInspections.isCurrent, true),
                eq(discInspections.claimToken, claim.claimToken),
                gt(
                  discInspections.claimUpdatedAt,
                  new Date(
                    timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .get();
          if (!current) {
            throw new StaleJobAttemptError("disc inspection", claim.id);
          }
          const recordAttempt = (
            outcome: "completed" | "failed" | "aborted",
            reasonCode: DiscInspectionReasonCode | null,
          ) => {
            transaction
              .insert(discInspectionAttempts)
              .values({
                id: newId<DiscInspectionAttemptId>(),
                discInspectionId: current.id,
                attemptNumber: current.attemptCount,
                outcome,
                phase: current.phase,
                reasonCode,
                diagnostic,
                startedAt: current.attemptStartedAt,
                endedAt: timestamp,
              })
              .run();
          };

          if (event.type === "metadata") {
            const update = {
              phase: "hashing_content" as const,
              volumeLabel: event.volumeLabel?.trim().slice(0, 255) || null,
              titleCount: optionalSafeInteger(event.titleCount, "titleCount", 0),
              chapterCount: optionalSafeInteger(
                event.chapterCount,
                "chapterCount",
                0,
              ),
              audioStreamCount: optionalSafeInteger(
                event.audioStreamCount,
                "audioStreamCount",
                0,
              ),
              subtitleStreamCount: optionalSafeInteger(
                event.subtitleStreamCount,
                "subtitleStreamCount",
                0,
              ),
              totalBytes: requirePositiveSafeInteger(
                event.totalBytes,
                "totalBytes",
              ),
              bytesHashed: 0,
              bytesPerSecond: null,
              etaSeconds: null,
              phaseStartedAt: timestamp,
              updatedAt: timestamp,
            };
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set(update)
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.set(current.id, {
              latestBytes: 0,
              latestBytesPerSecond: null,
              latestEtaSeconds: null,
              persistedAt: timestamp.getTime(),
              persistedBytes: 0,
              token: claim.claimToken,
            });
            return updated;
          }

          if (event.type === "hash_progress") {
            const bytesHashed = optionalSafeInteger(
              event.bytesHashed,
              "bytesHashed",
              0,
            );
            if (
              bytesHashed === null ||
              bytesHashed === undefined ||
              current.totalBytes === null ||
              bytesHashed < (current.bytesHashed ?? 0) ||
              bytesHashed > current.totalBytes
            ) {
              throw new DomainInvariantError(
                "Disc Inspection hash progress must be monotonic and bounded by totalBytes",
              );
            }
            const previous = inspectionProgress.get(current.id);
            if (
              previous?.token === claim.claimToken &&
              bytesHashed < previous.latestBytes
            ) {
              throw new DomainInvariantError(
                "Disc Inspection hash progress must be monotonic and bounded by totalBytes",
              );
            }
            if (
              (event.bytesPerSecond === null) !==
              (event.etaSeconds === null)
            ) {
              throw new DomainInvariantError(
                "Disc Inspection throughput and ETA must stabilize together",
              );
            }
            const bytesPerSecond =
              event.bytesPerSecond === null
                ? null
                : requirePositiveSafeInteger(
                    event.bytesPerSecond,
                    "bytesPerSecond",
                  );
            const etaSeconds =
              event.etaSeconds === null
                ? null
                : (optionalSafeInteger(event.etaSeconds, "etaSeconds", 0) ?? null);
            const shouldPersist =
              previous === undefined ||
              previous.token !== claim.claimToken ||
              timestamp.getTime() - previous.persistedAt >= 1_000 ||
              bytesHashed === current.totalBytes ||
              (bytesHashed - previous.persistedBytes) * 100 >=
                current.totalBytes * 5;
            if (!shouldPersist) {
              inspectionProgress.set(current.id, {
                ...previous,
                latestBytes: bytesHashed,
                latestBytesPerSecond: bytesPerSecond,
                latestEtaSeconds: etaSeconds,
              });
              return {
                ...current,
                bytesHashed,
                bytesPerSecond,
                etaSeconds,
              };
            }
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  bytesHashed,
                  bytesPerSecond,
                  etaSeconds,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                    or(
                      isNull(discInspections.bytesHashed),
                      lte(discInspections.bytesHashed, bytesHashed),
                    ),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.set(current.id, {
              latestBytes: bytesHashed,
              latestBytesPerSecond: bytesPerSecond,
              latestEtaSeconds: etaSeconds,
              persistedAt: timestamp.getTime(),
              persistedBytes: bytesHashed,
              token: claim.claimToken,
            });
            return updated;
          }

          if (event.type === "confirming_media") {
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  phase: "confirming_media",
                  phaseStartedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }

          if (event.type === "retry") {
            const failureCount = Math.min(
              current.consecutiveFailureCount + 1,
              5,
            );
            recordAttempt("failed", event.reasonCode);
            const terminal = failureCount >= 5;
            const cachedProgress = inspectionProgress.get(current.id);
            const latestProgress = cachedProgress?.token === claim.claimToken
              ? cachedProgress
              : undefined;
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  status: terminal ? "failed" : "running",
                  phase: terminal ? current.phase : "retry_wait",
                  consecutiveFailureCount: failureCount,
                  bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                  bytesPerSecond: latestProgress === undefined
                    ? current.bytesPerSecond
                    : latestProgress.latestBytesPerSecond,
                  etaSeconds: latestProgress === undefined
                    ? current.etaSeconds
                    : latestProgress.latestEtaSeconds,
                  retryAt: terminal ? null : event.retryAt,
                  reasonCode: event.reasonCode,
                  diagnostic,
                  claimToken: null,
                  claimUpdatedAt: null,
                  phaseStartedAt: terminal ? current.phaseStartedAt : timestamp,
                  completedAt: terminal ? timestamp : null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.delete(current.id);
            return updated;
          }

          if (event.type === "complete") {
            const disc = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, event.detectedDiscId))
                .get(),
              "detected disc",
              event.detectedDiscId,
            );
            if (disc.opticalDriveId !== current.opticalDriveId) {
              throw new DomainInvariantError(
                "Completed Disc Inspection must link to its Optical Drive observation",
              );
            }
            recordAttempt("completed", null);
            inspectionProgress.delete(current.id);
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  detectedDiscId: disc.id,
                  status: "completed",
                  consecutiveFailureCount: 0,
                  bytesHashed: current.totalBytes,
                  bytesPerSecond: null,
                  etaSeconds: null,
                  retryAt: null,
                  reasonCode: null,
                  diagnostic: null,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }

          if (event.type === "fail") {
            recordAttempt("failed", event.reasonCode);
            const cachedProgress = inspectionProgress.get(current.id);
            const latestProgress = cachedProgress?.token === claim.claimToken
              ? cachedProgress
              : undefined;
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  status: "failed",
                  consecutiveFailureCount: Math.min(
                    current.consecutiveFailureCount + 1,
                    5,
                  ),
                  bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                  bytesPerSecond: latestProgress === undefined
                    ? current.bytesPerSecond
                    : latestProgress.latestBytesPerSecond,
                  etaSeconds: latestProgress === undefined
                    ? current.etaSeconds
                    : latestProgress.latestEtaSeconds,
                  retryAt: null,
                  reasonCode: event.reasonCode,
                  diagnostic,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.delete(current.id);
            return updated;
          }

          recordAttempt("aborted", event.reasonCode);
          const cachedProgress = inspectionProgress.get(current.id);
          const latestProgress = cachedProgress?.token === claim.claimToken
            ? cachedProgress
            : undefined;
          const updated = requireRow(
            transaction
              .update(discInspections)
              .set({
                isCurrent: false,
                status: "aborted",
                bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                bytesPerSecond: latestProgress === undefined
                  ? current.bytesPerSecond
                  : latestProgress.latestBytesPerSecond,
                etaSeconds: latestProgress === undefined
                  ? current.etaSeconds
                  : latestProgress.latestEtaSeconds,
                retryAt: null,
                reasonCode: event.reasonCode,
                diagnostic,
                claimToken: null,
                claimUpdatedAt: null,
                completedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.claimToken, claim.claimToken),
                ),
              )
              .returning()
              .get(),
            "disc inspection",
            current.id,
          );
          inspectionProgress.delete(current.id);
          return updated;
        }, { behavior: "immediate" });
      },

      requestRetry(id) {
        const timestamp = now();
        const requested = database
          .update(discInspections)
          .set({
            manualRetryRequestedAt: timestamp,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(discInspections.id, id),
              eq(discInspections.status, "failed"),
              eq(discInspections.isCurrent, true),
              isNull(discInspections.manualRetryRequestedAt),
            ),
          )
          .returning()
          .get();
        if (!requested) {
          const current = database
            .select()
            .from(discInspections)
            .where(eq(discInspections.id, id))
            .get();
          if (!current) {
            throw new RecordNotFoundError("disc inspection", id);
          }
          if (
            current.status === "failed" &&
            current.isCurrent &&
            current.manualRetryRequestedAt !== null
          ) {
            return current;
          }
          throw new InvalidStatusTransitionError(
            "disc inspection",
            current.status,
            "retry requested",
          );
        }
        return requested;
      },

      clearCurrent(input) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.opticalDriveId, input.opticalDriveId),
                eq(discInspections.isCurrent, true),
              ),
            )
            .get();
          if (!current) {
            return null;
          }
          if (
            input.mediaGeneration !== undefined &&
            input.mediaGeneration === current.mediaGeneration
          ) {
            return current;
          }
          inspectionProgress.delete(current.id);
          if (current.status !== "running") {
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  manualRetryRequestedAt: null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }
          const reasonCode = input.reasonCode ?? "no_medium";
          transaction
            .insert(discInspectionAttempts)
            .values({
              id: newId<DiscInspectionAttemptId>(),
              discInspectionId: current.id,
              attemptNumber: current.attemptCount,
              outcome: "aborted",
              phase: current.phase,
              reasonCode,
              startedAt: current.attemptStartedAt,
              endedAt: timestamp,
            })
            .onConflictDoNothing()
            .run();
          return requireRow(
            transaction
              .update(discInspections)
              .set({
                isCurrent: false,
                status: "aborted",
                retryAt: null,
                reasonCode,
                claimToken: null,
                claimUpdatedAt: null,
                completedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.status, "running"),
                  eq(discInspections.isCurrent, true),
                ),
              )
              .returning()
              .get(),
            "disc inspection",
            current.id,
          );
        }, { behavior: "immediate" });
      },

      list(options = {}) {
        if (options.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const conditions = [
          options.currentOnly ? eq(discInspections.isCurrent, true) : undefined,
          options.ids ? inArray(discInspections.id, [...options.ids]) : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(discInspections)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(discInspections.updatedAt), desc(discInspections.id));
        if (options.limit === undefined) {
          return query.all();
        }
        return query
          .limit(requirePositiveSafeInteger(options.limit, "limit"))
          .all();
      },

      listAttempts(id) {
        requireRow(
          database
            .select({ id: discInspections.id })
            .from(discInspections)
            .where(eq(discInspections.id, id))
            .get(),
          "disc inspection",
          id,
        );
        return database
          .select()
          .from(discInspectionAttempts)
          .where(eq(discInspectionAttempts.discInspectionId, id))
          .orderBy(
            asc(discInspectionAttempts.attemptNumber),
            asc(discInspectionAttempts.id),
          )
          .all();
      },
    },

    archiveRequests: {
      create: createArchiveRequest,
      cancel(id) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const current = requireRow(
            transaction
              .select()
              .from(archiveRequests)
              .where(eq(archiveRequests.id, id))
              .get(),
            "archive request",
            id,
          );
          if (
            current.status === "cancelled" ||
            current.status === "fulfilled" ||
            current.status === "cancellation_requested"
          ) {
            return current;
          }
          const active = current.status === "running";
          const status = active ? "cancellation_requested" : "cancelled";
          return requireRow(
            transaction
              .update(archiveRequests)
              .set({
                status,
                cancellationRequestedAt: timestamp,
                cancelledAt: active ? null : timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, id),
                  eq(archiveRequests.status, current.status),
                ),
              )
              .returning()
              .get(),
            "archive request",
            id,
          );
        }, { behavior: "immediate" });
      },

      retry(id) {
        const retried = database
          .update(archiveRequests)
          .set({
            status: "pending",
            cancellationRequestedAt: null,
            fulfilledAt: null,
            cancelledAt: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(archiveRequests.id, id),
              eq(archiveRequests.status, "needs_attention"),
            ),
          )
          .returning()
          .get();
        if (!retried) {
          const current = database
            .select()
            .from(archiveRequests)
            .where(eq(archiveRequests.id, id))
            .get();
          if (!current) {
            throw new RecordNotFoundError("archive request", id);
          }
          throw new InvalidStatusTransitionError(
            "archive request",
            current.status,
            "pending",
          );
        }
        return retried;
      },

        list: listArchiveRequests,

        listRelevantForDetectedDiscs(detectedDiscIds) {
          const uniqueIds = [...new Set(detectedDiscIds)];
          if (uniqueIds.length > RELATED_ACTIVITY_ROOT_LIMIT) {
            throw new DomainInvariantError(
              `related Detected Disc reads are limited to ${RELATED_ACTIVITY_ROOT_LIMIT} roots`,
            );
          }
          return uniqueIds.flatMap((detectedDiscId) => {
            const request = database
              .select()
              .from(archiveRequests)
              .where(eq(archiveRequests.detectedDiscId, detectedDiscId))
              .orderBy(
                sql`case when ${archiveRequests.status} in ('pending', 'running', 'needs_attention', 'cancellation_requested') then 0 else 1 end`,
                desc(archiveRequests.updatedAt),
                desc(archiveRequests.id),
              )
              .limit(1)
              .get();
            return request === undefined ? [] : [request];
          });
        },
      },

      archiveJobs: {
      startForInspection(inspectionId, workerIdInput) {
        const timestamp = now();
        const workerId = requireNonEmpty(workerIdInput, "workerId");
        const preflight = database
          .select({
            discKind: detectedDiscs.discKind,
            fingerprint: detectedDiscs.fingerprint,
          })
          .from(discInspections)
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, discInspections.detectedDiscId),
          )
          .innerJoin(
            archiveRequests,
            and(
              eq(archiveRequests.detectedDiscId, detectedDiscs.id),
              eq(archiveRequests.status, "pending"),
            ),
          )
          .where(
            and(
              eq(discInspections.id, inspectionId),
              eq(discInspections.isCurrent, true),
              eq(discInspections.status, "completed"),
            ),
          )
          .get();
        if (preflight === undefined) {
          return null;
        }
        if (preflight.discKind === "dvd") {
          requireLegacyDvdArchiveIdentitiesResolved(
            preflight.discKind,
            preflight.fingerprint,
          );
        }
        const claimToken = newId<ArchiveJobClaimToken>();
        return database.transaction((transaction) => {
          const inspection = transaction
            .select()
            .from(discInspections)
            .innerJoin(
              opticalDrives,
              eq(opticalDrives.id, discInspections.opticalDriveId),
            )
            .where(
              and(
                eq(discInspections.id, inspectionId),
                eq(discInspections.isCurrent, true),
                eq(discInspections.status, "completed"),
                isNotNull(discInspections.detectedDiscId),
                eq(opticalDrives.isPresent, true),
                eq(opticalDrives.isEnabled, true),
              ),
            )
            .get();
          if (!inspection || inspection.disc_inspections.detectedDiscId === null) {
            return null;
          }
          const disc = requireRow(
            transaction
              .select()
              .from(detectedDiscs)
              .where(
                and(
                  eq(
                    detectedDiscs.id,
                    inspection.disc_inspections.detectedDiscId,
                  ),
                  eq(
                    detectedDiscs.opticalDriveId,
                    inspection.disc_inspections.opticalDriveId,
                  ),
                ),
              )
              .get(),
            "detected disc",
            inspection.disc_inspections.detectedDiscId,
          );
          const request = transaction
            .select()
            .from(archiveRequests)
            .where(
              and(
                eq(archiveRequests.detectedDiscId, disc.id),
                eq(archiveRequests.status, "pending"),
              ),
            )
            .orderBy(
              desc(archiveRequests.priority),
              asc(archiveRequests.createdAt),
              asc(archiveRequests.id),
            )
            .get();
          if (!request) {
            return null;
          }
          if (disc.status !== "approved") {
            throw new DomainInvariantError(
              `pending Archive Request references a ${disc.status} Detected Disc`,
            );
          }
          if (
            findOriginalArchiveByFingerprintOrContentIdAlias(
              disc.fingerprint,
              transaction,
            )
          ) {
            transaction
              .update(archiveRequests)
              .set({
                status: "fulfilled",
                fulfilledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, request.id),
                  eq(archiveRequests.status, "pending"),
                ),
              )
              .run();
            return null;
          }
          const conflicting = transaction
            .select({ id: archiveJobs.id })
            .from(archiveJobs)
            .innerJoin(
              detectedDiscs,
              eq(detectedDiscs.id, archiveJobs.detectedDiscId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                or(
                  eq(detectedDiscs.fingerprint, disc.fingerprint),
                  eq(detectedDiscs.opticalDriveId, disc.opticalDriveId),
                ),
              ),
            )
            .get();
          if (conflicting) {
            return null;
          }
          const attempt = transaction
            .select({
              value: sql<number>`coalesce(max(${archiveJobs.attemptOrdinal}), 0)`,
            })
            .from(archiveJobs)
            .where(eq(archiveJobs.archiveRequestId, request.id))
            .get()?.value ?? 0;
          const id = newId<ArchiveJobId>();
          const transitioned = transaction
            .update(archiveRequests)
            .set({ status: "running", updatedAt: timestamp })
            .where(
              and(
                eq(archiveRequests.id, request.id),
                eq(archiveRequests.status, "pending"),
              ),
            )
            .returning({ id: archiveRequests.id })
            .get();
          if (!transitioned) {
            return null;
          }
          const job = requireRow(
            transaction
              .insert(archiveJobs)
              .values({
                id,
                archiveRequestId: request.id,
                detectedDiscId: disc.id,
                attemptOrdinal: attempt + 1,
                status: "running",
                priority: request.priority,
                progressPhase: "preparing",
                progressPercent: 0,
                claimedBy: workerId,
                claimToken,
                claimedAt: timestamp,
                startedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "archive job",
            id,
          );
          archiveProgress.delete(id);
          return asRunningArchiveJob(job);
        }, { behavior: "immediate" });
      },

      renewClaim(claim) {
        const timestamp = now();
        const renewed = database
          .update(archiveJobs)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
              gt(
                archiveJobs.updatedAt,
                new Date(
                  timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                ),
              ),
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
          const expired = transaction
            .select({
              id: archiveJobs.id,
              archiveRequestId: archiveJobs.archiveRequestId,
              claimToken: archiveJobs.claimToken,
            })
            .from(archiveJobs)
            .innerJoin(
              archiveRequests,
              eq(archiveRequests.id, archiveJobs.archiveRequestId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                lte(archiveJobs.updatedAt, expiredBefore),
                ne(archiveRequests.status, "cancellation_requested"),
              ),
            )
            .orderBy(asc(archiveJobs.updatedAt), asc(archiveJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all();
          if (expired.length === 0) {
            return [];
          }
          const terminalJobs: ArchiveJob[] = [];
          for (const candidate of expired) {
            const cachedProgress = archiveProgress.get(candidate.id);
            const latestProgress =
              candidate.claimToken !== null &&
              cachedProgress?.token === candidate.claimToken
                ? cachedProgress
                : undefined;
            const failedJob = transaction
              .update(archiveJobs)
              .set({
                status: "failed",
                ...(latestProgress === undefined
                  ? {}
                  : {
                      progressPhase: latestProgress.latestPhase,
                      progressPercent: latestProgress.latestPercent,
                    }),
                completedAt: timestamp,
                errorMessage: "Archive worker lease expired",
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveJobs.id, candidate.id),
                  eq(archiveJobs.status, "running"),
                  lte(archiveJobs.updatedAt, expiredBefore),
                ),
              )
              .returning()
              .get();
            if (failedJob === undefined) {
              continue;
            }
            terminalJobs.push(failedJob);
            requireRow(
              transaction
              .update(archiveRequests)
              .set({ status: "needs_attention", updatedAt: timestamp })
              .where(
                and(
                  eq(archiveRequests.id, candidate.archiveRequestId),
                  eq(archiveRequests.status, "running"),
                ),
              )
                .returning({ id: archiveRequests.id })
                .get(),
              "archive request",
              candidate.archiveRequestId,
            );
          }
          const jobsById = new Map(terminalJobs.map((job) => [job.id, job]));
          const jobs = expired.flatMap(({ id }) => {
            const job = jobsById.get(id);
            return job === undefined ? [] : [job];
          });
          for (const job of terminalJobs) {
            archiveProgress.delete(job.id);
          }
          return jobs;
        }, { behavior: "immediate" });
      },

      listExpiredCancellations() {
        const expiredBefore = new Date(
          now().getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const listAfter = (
          cursor: typeof expiredCancellationCursor,
        ) => database
            .select({ job: archiveJobs })
            .from(archiveJobs)
            .innerJoin(
              archiveRequests,
              eq(archiveRequests.id, archiveJobs.archiveRequestId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                eq(archiveRequests.status, "cancellation_requested"),
                lte(archiveJobs.updatedAt, expiredBefore),
                cursor === undefined
                  ? undefined
                  : or(
                      gt(archiveJobs.updatedAt, cursor.updatedAt),
                      and(
                        eq(archiveJobs.updatedAt, cursor.updatedAt),
                        gt(archiveJobs.id, cursor.id),
                      ),
                    ),
              ),
            )
            .orderBy(asc(archiveJobs.updatedAt), asc(archiveJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all()
            .map(({ job }) => asRunningArchiveJob(job));
        let jobs = listAfter(expiredCancellationCursor);
        if (jobs.length === 0 && expiredCancellationCursor !== undefined) {
          expiredCancellationCursor = undefined;
          jobs = listAfter(undefined);
        }
        const last = jobs.at(-1);
        expiredCancellationCursor =
          jobs.length === JOB_RECOVERY_LIMIT && last !== undefined
            ? { id: last.id, updatedAt: last.updatedAt }
            : undefined;
        return jobs;
      },

      finalizeExpiredCancellation(claim) {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const completed = database.transaction((transaction) => {
          const cachedProgress = archiveProgress.get(claim.id);
          const latestProgress = cachedProgress?.token === claim.claimToken
            ? cachedProgress
            : undefined;
          const job = transaction
            .update(archiveJobs)
            .set({
              status: "aborted",
              ...(latestProgress === undefined
                ? {}
                : {
                    progressPhase: latestProgress.latestPhase,
                    progressPercent: latestProgress.latestPercent,
                  }),
              completedAt: timestamp,
              errorMessage: "Archive cancelled after worker recovery",
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.archiveRequestId, claim.archiveRequestId),
                eq(archiveJobs.detectedDiscId, claim.detectedDiscId),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                lte(archiveJobs.updatedAt, expiredBefore),
                exists(
                  transaction
                    .select({ id: archiveRequests.id })
                    .from(archiveRequests)
                    .where(
                      and(
                        eq(
                          archiveRequests.id,
                          archiveJobs.archiveRequestId,
                        ),
                        eq(
                          archiveRequests.status,
                          "cancellation_requested",
                        ),
                      ),
                    ),
                ),
              ),
            )
            .returning()
            .get();
          if (job === undefined) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          requireRow(
            transaction
              .update(archiveRequests)
              .set({
                status: "cancelled",
                cancelledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, job.archiveRequestId),
                  eq(archiveRequests.status, "cancellation_requested"),
                ),
              )
              .returning({ id: archiveRequests.id })
              .get(),
            "archive request",
            job.archiveRequestId,
          );
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return completed;
      },

        list: listArchiveJobs,

        listLatestForRequests(archiveRequestIds) {
          const uniqueIds = [...new Set(archiveRequestIds)];
          if (uniqueIds.length > RELATED_ACTIVITY_ROOT_LIMIT) {
            throw new DomainInvariantError(
              `related Archive Request reads are limited to ${RELATED_ACTIVITY_ROOT_LIMIT} roots`,
            );
          }
          return uniqueIds.flatMap((archiveRequestId) => {
            const job = database
              .select()
              .from(archiveJobs)
              .where(eq(archiveJobs.archiveRequestId, archiveRequestId))
              .orderBy(
                desc(archiveJobs.attemptOrdinal),
                desc(archiveJobs.id),
              )
              .limit(1)
              .get();
            return job === undefined ? [] : [job];
          });
        },

        isCancellationRequested(claim) {
        const current = database
          .select({ status: archiveRequests.status })
          .from(archiveJobs)
          .innerJoin(
            archiveRequests,
            eq(archiveRequests.id, archiveJobs.archiveRequestId),
          )
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
            ),
          )
          .get();
        if (!current) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        return current.status === "cancellation_requested";
      },

      updateProgress(claim, progressInput) {
        const timestamp = now();
        const progress =
          typeof progressInput === "number"
            ? {
                phase: claim.progressPhase,
                progressPercent: progressInput,
              }
            : progressInput;
        if (!ARCHIVE_RUNNING_PROGRESS_PHASES.includes(progress.phase)) {
          throw new DomainInvariantError("Archive Job progress phase is invalid");
        }
        if (
          !Number.isInteger(progress.progressPercent) ||
          progress.progressPercent < 0 ||
          progress.progressPercent > 100
        ) {
          throw new DomainInvariantError(
            "progressPercent must be an integer between 0 and 100",
          );
        }
        const previous = archiveProgress.get(claim.id);
        const shouldPersist =
          previous === undefined ||
          previous.token !== claim.claimToken ||
          previous.persistedPhase !== progress.phase ||
          timestamp.getTime() - previous.persistedAt >= 1_000 ||
          Math.abs(
            progress.progressPercent - (previous?.persistedPercent ?? 0),
          ) >= 5;
        if (!shouldPersist) {
          archiveProgress.set(claim.id, {
            ...previous,
            latestPercent: progress.progressPercent,
            latestPhase: progress.phase,
          });
          return {
            ...claim,
            progressPhase: progress.phase,
            progressPercent: progress.progressPercent,
          };
        }
        const updated = database
          .update(archiveJobs)
          .set({
            progressPhase: progress.phase,
            progressPercent: progress.progressPercent,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
              gt(
                archiveJobs.updatedAt,
                new Date(
                  timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        archiveProgress.set(claim.id, {
          token: claim.claimToken,
          latestPercent: progress.progressPercent,
          latestPhase: progress.phase,
          persistedPercent: progress.progressPercent,
          persistedPhase: progress.phase,
          persistedAt: timestamp.getTime(),
        });
        return updated;
      },

      publish(claim, input) {
        const archivePath = requireNonEmpty(input.archivePath, "archivePath");
        const sizeBytes = requirePositiveSafeInteger(input.sizeBytes, "sizeBytes");
        const requireCurrentClaim = (
          querySource: Pick<typeof database, "select">,
        ) => {
          const checkedAt = now();
          const current = querySource
            .select({
              detectedDiscId: archiveJobs.detectedDiscId,
              discKind: detectedDiscs.discKind,
              fingerprint: detectedDiscs.fingerprint,
            })
            .from(archiveJobs)
            .innerJoin(
              archiveRequests,
              eq(archiveRequests.id, archiveJobs.archiveRequestId),
            )
            .innerJoin(
              detectedDiscs,
              eq(detectedDiscs.id, archiveJobs.detectedDiscId),
            )
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.detectedDiscId, claim.detectedDiscId),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                eq(archiveRequests.status, "running"),
                gt(
                  archiveJobs.updatedAt,
                  new Date(
                    checkedAt.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .get();
          if (current === undefined) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          return current;
        };
        const currentDisc = requireCurrentClaim(database);
        if (currentDisc.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            currentDisc.fingerprint,
            sizeBytes,
            requireCurrentClaim,
          );
        }
        const timestamp = now();
        const completed = database.transaction((transaction) => {
          const current = requireCurrentClaim(transaction);
          const disc = requireRow(
            transaction
              .select()
              .from(detectedDiscs)
              .where(eq(detectedDiscs.id, current.detectedDiscId))
              .get(),
            "detected disc",
            current.detectedDiscId,
          );
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
                      sidecarPath: legacyCutoverStagedSidecars.sidecarPath,
                    })
                    .from(legacyCutoverStagedSidecars)
                    .where(
                      legacyCutoverFenceCondition(
                        disc.fingerprint,
                        archivePath,
                      ),
                    )
                    .limit(1)
                    .get() !== undefined,
                sizeBytes,
                archivedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "original disc archive",
            disc.id,
          );
          transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: timestamp })
            .where(eq(detectedDiscs.fingerprint, disc.fingerprint))
            .run();
          transaction
            .update(archiveRequests)
            .set({
              status: "fulfilled",
              fulfilledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(archiveRequests.status, [
                  "pending",
                  "running",
                  "needs_attention",
                ]),
                exists(
                  transaction
                    .select({ id: detectedDiscs.id })
                    .from(detectedDiscs)
                    .where(
                      and(
                        eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                        eq(detectedDiscs.fingerprint, disc.fingerprint),
                      ),
                    ),
                ),
              ),
            )
            .run();
          return requireRow(
            transaction
              .update(archiveJobs)
              .set({
                originalDiscArchiveId: archive.id,
                status: "completed",
                progressPhase: "finalizing",
                progressPercent: 100,
                completedAt: timestamp,
                errorMessage: null,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveJobs.id, claim.id),
                  eq(archiveJobs.status, "running"),
                  eq(archiveJobs.claimToken, claim.claimToken),
                ),
              )
              .returning()
              .get(),
            "archive job",
            claim.id,
          );
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return completed;
      },

      fail(claim, errorMessageInput) {
        const timestamp = now();
        const errorMessage = requireNonEmpty(
          errorMessageInput,
          "errorMessage",
        ).slice(0, 500);
        const failed = database.transaction((transaction) => {
          const cachedProgress = archiveProgress.get(claim.id);
          const latestProgress = cachedProgress?.token === claim.claimToken
            ? cachedProgress
            : undefined;
          const request = transaction
            .select({ status: archiveRequests.status })
            .from(archiveRequests)
            .where(
              and(
                eq(archiveRequests.id, claim.archiveRequestId),
                inArray(archiveRequests.status, [
                  "running",
                  "cancellation_requested",
                ]),
              ),
            )
            .get();
          if (!request) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          const cancellationWins =
            request.status === "cancellation_requested";
          const job = transaction
            .update(archiveJobs)
            .set({
              status: cancellationWins ? "aborted" : "failed",
              ...(latestProgress === undefined
                ? {}
                : {
                    progressPhase: latestProgress.latestPhase,
                    progressPercent: latestProgress.latestPercent,
                  }),
              completedAt: timestamp,
              errorMessage: cancellationWins
                ? "Archive cancelled by operator"
                : errorMessage,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                gt(
                  archiveJobs.updatedAt,
                  new Date(
                    timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .returning()
            .get();
          if (!job) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          requireRow(
            transaction
              .update(archiveRequests)
              .set(cancellationWins
                ? {
                    status: "cancelled",
                    cancelledAt: timestamp,
                    updatedAt: timestamp,
                  }
                : { status: "needs_attention", updatedAt: timestamp })
              .where(
                and(
                  eq(archiveRequests.id, job.archiveRequestId),
                  eq(archiveRequests.status, request.status),
                ),
              )
              .returning({ id: archiveRequests.id })
              .get(),
            "archive request",
            job.archiveRequestId,
          );
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return failed;
      },

      abort(claim, errorMessageInput) {
        const timestamp = now();
        const errorMessage = requireNonEmpty(
          errorMessageInput,
          "errorMessage",
        ).slice(0, 500);
        const aborted = database.transaction((transaction) => {
          const cachedProgress = archiveProgress.get(claim.id);
          const latestProgress = cachedProgress?.token === claim.claimToken
            ? cachedProgress
            : undefined;
          const job = transaction
            .update(archiveJobs)
            .set({
              status: "aborted",
              ...(latestProgress === undefined
                ? {}
                : {
                    progressPhase: latestProgress.latestPhase,
                    progressPercent: latestProgress.latestPercent,
                  }),
              completedAt: timestamp,
              errorMessage,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                gt(
                  archiveJobs.updatedAt,
                  new Date(
                    timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .returning()
            .get();
          if (!job) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          requireRow(
            transaction
              .update(archiveRequests)
              .set({
                status: "cancelled",
                cancellationRequestedAt: timestamp,
                cancelledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, job.archiveRequestId),
                  inArray(archiveRequests.status, [
                    "running",
                    "cancellation_requested",
                  ]),
                ),
              )
              .returning({ id: archiveRequests.id })
              .get(),
            "archive request",
            job.archiveRequestId,
          );
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return aborted;
      },

      complete(claim, originalDiscArchiveId) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const archive = requireRow(
            transaction
              .select()
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, originalDiscArchiveId))
              .get(),
            "original disc archive",
            originalDiscArchiveId,
          );
          if (archive.detectedDiscId !== claim.detectedDiscId) {
            throw new DomainInvariantError(
              "Archive Job result must belong to the job's Detected Disc",
            );
          }
          const job = transaction
            .update(archiveJobs)
            .set({
              originalDiscArchiveId,
              status: "completed",
              progressPhase: "finalizing",
              progressPercent: 100,
              completedAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
              ),
            )
            .returning()
            .get();
          if (!job) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          transaction
            .update(archiveRequests)
            .set({
              status: "fulfilled",
              fulfilledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(eq(archiveRequests.id, job.archiveRequestId))
            .run();
          return job;
        }, { behavior: "immediate" });
      },
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
                catalogReviewOutcome:
                  originalDiscArchives.catalogReviewOutcome,
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
            selectionReview.catalogReviewOutcome !==
              "reviewed_with_selections" ||
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
            if (existing) {
              return existing;
            }
            const outputOwner = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.outputPath, outputPath),
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
                `Encode Job output is already assigned: ${outputPath}`,
              );
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
                outputPath,
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

      requestCancellation(id) {
        const timestamp = now();
        return database.transaction(
          (transaction) =>
            requestEncodeJobCancellation(transaction, id, timestamp),
          { behavior: "immediate" },
        );
      },

      claimNext: encodeJobQueue.claimNext,
      renewClaim(claim) {
        const timestamp = now();
        const renewed = database
          .update(encodeJobs)
          .set({ updatedAt: timestamp })
          .where(and(
            eq(encodeJobs.id, claim.id),
            inArray(encodeJobs.status, [
              "running",
              "cancellation_requested",
            ]),
            eq(encodeJobs.claimToken, claim.claimToken),
            gt(
              encodeJobs.updatedAt,
              new Date(
                timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
              ),
            ),
          ))
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return asClaimedEncodeJob(renewed);
      },
      completeCancellation(claim) {
        const timestamp = now();
        const cancelled = database
          .update(encodeJobs)
          .set({
            status: "cancelled",
            reservesOutputPath: claim.replaceExistingOutput,
            partialCleanupOutputPath: null,
            partialCleanupClaimToken: null,
            partialCleanupLeaseToken: null,
            publicationPending: false,
            publicationCompletionPending: false,
            progressEtaSeconds: null,
            claimedBy: null,
            claimToken: null,
            claimedAt: null,
            completedAt: null,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, claim.id),
            eq(encodeJobs.status, "cancellation_requested"),
            eq(encodeJobs.claimToken, claim.claimToken),
            isNull(encodeJobs.partialCleanupOutputPath),
            isNull(encodeJobs.partialCleanupClaimToken),
            isNull(encodeJobs.partialCleanupLeaseToken),
            eq(encodeJobs.publicationPending, false),
            eq(encodeJobs.publicationCompletionPending, false),
          ))
          .returning()
          .get();
        if (!cancelled) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return cancelled;
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
      listExpiredCancellationClaims() {
        const expiredBefore = new Date(
          now().getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database
          .select()
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "cancellation_requested"),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map(asClaimedEncodeJob);
      },
      completeExpiredCancellation(claim, processInactive) {
        processInactive();
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const recovered = database
          .update(encodeJobs)
          .set({
            status: "cancelled",
            reservesOutputPath: claim.replaceExistingOutput,
            partialCleanupOutputPath: claim.outputPath,
            partialCleanupClaimToken: claim.claimToken,
            partialCleanupLeaseToken: null,
            publicationPending: false,
            publicationCompletionPending: false,
            progressEtaSeconds: null,
            claimedBy: null,
            claimToken: null,
            claimedAt: null,
            completedAt: null,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, claim.id),
            eq(encodeJobs.status, "cancellation_requested"),
            eq(encodeJobs.claimToken, claim.claimToken),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .returning()
          .get();
        if (!recovered) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return recovered;
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
              eq(encodeJobs.id, claim.id),
              inArray(encodeJobs.status, [
                "running",
                "cancellation_requested",
              ]),
              eq(encodeJobs.claimToken, claim.claimToken),
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
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
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
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
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
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
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
                inArray(encodeJobs.status, [
                  "failed",
                  "completed",
                  "cancelled",
                ]),
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
      requeue(id, options) {
        const outputPath = options?.outputPath === undefined
          ? undefined
          : requireNonEmpty(options.outputPath, "outputPath");
        if (
          options?.priority !== undefined &&
          !Number.isSafeInteger(options.priority)
        ) {
          throw new DomainInvariantError("priority must be a safe integer");
        }
        return encodeJobQueue.requeue(id, {
          outputPath,
          priority: options?.priority,
        });
      },
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
