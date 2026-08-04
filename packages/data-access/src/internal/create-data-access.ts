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
import { isDeepStrictEqual } from "node:util";

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
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

import {
  archiveJobs,
  detectedDiscs,
  discSelections,
  encodeJobs,
  encodingProfiles,
  mediaItems,
  opticalDrives,
  originalDiscArchiveContentIds,
  originalDiscArchives,
} from "./schema.js";
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
import {
  requireNonEmpty,
  requirePositiveSafeInteger,
} from "./validation.js";
import {
  decodeArchivedDvdTitles,
  decodeDvdTitleMap,
  isDvdContentId,
} from "../dvd-scan.js";
import { MAX_MEDIA_ITEM_HIERARCHY_DEPTH } from "../domain-values.js";
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
  ChronologicalListOptions,
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscId,
  DetectedDiscListOptions,
  DetectedDiscStatus,
  DiscSelection,
  DiscSelectionId,
  EncodeJobClaimToken,
  EncodeJobId,
  EncodeJob,
  EncodingProfileId,
  JobStatus,
  MediaDomain,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "../types.js";
import { ARCHIVE_JOB_LEASE_DURATION_MS } from "../types.js";
import { newId, requireRow } from "./persistence.js";

const BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const ARCHIVE_JOB_RECOVERY_LIMIT = 100;
const LEGACY_ARCHIVE_RECONCILIATION_LIMIT = 4;
const LEGACY_ARCHIVE_RECONCILIATION_BYTES = 9_000_000_000;
const DISC_SELECTION_REVIEW_BATCH_SIZE = 100;
const DISC_SELECTION_DELETE_JOB_BATCH_SIZE = 100;
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

interface ChronologicalRecord {
  id: string;
}

function createBoundedChronologicalList<
  RecordType extends ChronologicalRecord,
  Status extends string,
  Options extends ChronologicalListOptions,
>({
  activeStatuses,
  historyStatuses,
  chronologicalAt,
  readAll,
  readNewest,
}: {
  activeStatuses: Status[];
  historyStatuses: Status[];
  chronologicalAt(record: RecordType): Date;
  readAll(
    statuses: Status[] | undefined,
    options: Options | undefined,
  ): RecordType[];
  readNewest(
    statuses: Status[] | undefined,
    limit: number,
    options: Options | undefined,
  ): RecordType[];
}) {
  const chronological = (rows: RecordType[]) =>
    rows.sort(
      (left, right) =>
        chronologicalAt(left).getTime() - chronologicalAt(right).getTime() ||
        left.id.localeCompare(right.id),
    );

  return (statuses?: Status[], options?: Options): RecordType[] => {
    const policy = options?.policy;
    if (policy?.mode === "active-and-history") {
      if (statuses !== undefined) {
        throw new DomainInvariantError(
          "active-and-history list policy cannot be combined with explicit statuses",
        );
      }
      const active = readNewest(
        activeStatuses,
        requirePositiveSafeInteger(policy.activeLimit, "activeLimit"),
        options,
      );
      const history = readNewest(
        historyStatuses,
        requirePositiveSafeInteger(policy.historyLimit, "historyLimit"),
        options,
      );
      return chronological([...active, ...history]);
    }
    if (policy?.mode === "newest") {
      return chronological(
        readNewest(
          statuses,
          requirePositiveSafeInteger(policy.limit, "limit"),
          options,
        ),
      );
    }
    return readAll(statuses, options);
  };
}

function createJobList<Job extends ChronologicalRecord & { updatedAt: Date }>({
  readQueue,
  readNewest,
}: {
  readQueue(statuses?: JobStatus[]): Job[];
  readNewest(statuses: JobStatus[] | undefined, limit: number): Job[];
}) {
  return createBoundedChronologicalList<
    Job,
    JobStatus,
    ChronologicalListOptions
  >({
    activeStatuses: ["queued", "running"],
    historyStatuses: ["completed", "failed"],
    chronologicalAt: (job) => job.updatedAt,
    readAll: (statuses) => readQueue(statuses),
    readNewest: (statuses, limit) => readNewest(statuses, limit),
  });
}

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

function toDiscSelection(
  row: typeof discSelections.$inferSelect,
): DiscSelection {
  const common = {
    id: row.id,
    originalDiscArchiveId: row.originalDiscArchiveId,
    mediaItemId: row.mediaItemId,
    sourceKey: row.sourceKey,
    label: row.label,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  switch (row.kind) {
    case "main_feature":
      if (
        row.titleNumber !== null ||
        row.chapterStart !== null ||
        row.chapterEnd !== null
      ) {
        throw new DomainInvariantError("Invalid main feature selection shape");
      }
      return {
        ...common,
        kind: row.kind,
        titleNumber: null,
        chapterStart: null,
        chapterEnd: null,
      };
    case "dvd_title":
      if (
        row.titleNumber === null ||
        row.chapterStart !== null ||
        row.chapterEnd !== null
      ) {
        throw new DomainInvariantError("Invalid DVD title selection shape");
      }
      return {
        ...common,
        kind: row.kind,
        titleNumber: row.titleNumber,
        chapterStart: null,
        chapterEnd: null,
      };
    case "dvd_chapters":
      if (
        row.titleNumber === null ||
        row.chapterStart === null ||
        row.chapterEnd === null
      ) {
        throw new DomainInvariantError("Invalid DVD chapter selection shape");
      }
      return {
        ...common,
        kind: row.kind,
        titleNumber: row.titleNumber,
        chapterStart: row.chapterStart,
        chapterEnd: row.chapterEnd,
      };
  }
}

function canonicalDvdSelectionSourceKey(
  selection: Pick<
    DiscSelection,
    "chapterEnd" | "chapterStart" | "kind" | "titleNumber"
  >,
): string {
  return selection.kind === "main_feature"
    ? "dvd:main-feature"
    : selection.kind === "dvd_title"
      ? `dvd:title:${selection.titleNumber}`
      : `dvd:title:${selection.titleNumber}:chapters:${selection.chapterStart}-${selection.chapterEnd}`;
}

export interface CreateDataAccessOptions {
  databasePath: string;
  migrationsFolder?: string;
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

function openMigratedDatabase(databasePath: string, migrationsFolder: string) {
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
  }: CreateDataAccessOptions,
  legacySidecarMigration?: LegacySidecarMigrationAdapter,
): DataAccess | LegacySidecarDataAccess {
  const normalizedDatabasePath = requireNonEmpty(databasePath, "databasePath");
  if (normalizedDatabasePath !== ":memory:") {
    mkdirSync(dirname(resolve(normalizedDatabasePath)), { recursive: true });
  }

  const { database, sqlite } = openMigratedDatabase(
    normalizedDatabasePath,
    migrationsFolder,
  );

  function now(): Date {
    return new Date();
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

  function requireAcyclicMediaItemParent(
    itemId: MediaItemId,
    parentId: MediaItemId | null | undefined,
    querySource: Pick<typeof database, "select"> = database,
  ): number {
    if (parentId === null || parentId === undefined) {
      return 1;
    }
    const visited = new Set<MediaItemId>([itemId]);
    let currentId: MediaItemId | null = parentId;
    while (currentId !== null) {
      if (visited.has(currentId)) {
        throw new DomainInvariantError(
          "Media Item hierarchy cannot contain a cycle",
        );
      }
      if (visited.size >= MAX_MEDIA_ITEM_HIERARCHY_DEPTH) {
        throw new DomainInvariantError(
          "Media Item hierarchy exceeds the supported depth",
        );
      }
      visited.add(currentId);
      const current: { id: MediaItemId; parentId: MediaItemId | null } = requireRow(
        querySource
          .select({ id: mediaItems.id, parentId: mediaItems.parentId })
          .from(mediaItems)
          .where(eq(mediaItems.id, currentId))
          .get(),
        "media item",
        currentId,
      );
      currentId = current.parentId;
    }
    return visited.size;
  }

  function requireMediaItemHierarchyWithinDepth(
    itemId: MediaItemId,
    parentId: MediaItemId | null | undefined,
    querySource: Pick<typeof database, "get" | "select"> = database,
  ): void {
    const ancestorDepth = requireAcyclicMediaItemParent(
      itemId,
      parentId,
      querySource,
    );
    const descendantDepth = querySource.get<{ maximumDepth: number }>(sql`
      with recursive media_item_descendants(id, depth) as (
        select ${itemId}, 1
        union all
        select ${mediaItems.id}, media_item_descendants.depth + 1
        from ${mediaItems}
        inner join media_item_descendants
          on ${mediaItems.parentId} = media_item_descendants.id
        where media_item_descendants.depth <= ${MAX_MEDIA_ITEM_HIERARCHY_DEPTH}
      )
      select max(depth) as maximumDepth
      from media_item_descendants
    `).maximumDepth;
    if (
      ancestorDepth + descendantDepth - 1 >
        MAX_MEDIA_ITEM_HIERARCHY_DEPTH
    ) {
      throw new DomainInvariantError(
        "Media Item hierarchy exceeds the supported depth",
      );
    }
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
      .where(eq(discSelections.originalDiscArchiveId, archiveId))
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

    const archivedTitles = decodeArchivedDvdTitles(scanData);
    let lastSelectionId: DiscSelectionId | undefined;
    let selectionCount = 0;
    while (true) {
      const rows = querySource
        .select()
        .from(discSelections)
        .where(
          and(
            eq(discSelections.originalDiscArchiveId, archiveId),
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
        const canonicalSourceKey = canonicalDvdSelectionSourceKey(selection);
        if (selection.sourceKey !== canonicalSourceKey) {
          throw new DomainInvariantError(
            "Catalog review requires canonical Disc Selection source keys",
          );
        }
        if (selection.titleNumber !== null) {
          if (!archivedTitles) {
            throw new DomainInvariantError(
              "DVD title selections require a reviewable DVD title map",
            );
          }
          const title = archivedTitles.find(
            (candidate) => candidate.number === selection.titleNumber,
          );
          if (!title) {
            throw new DomainInvariantError(
              `DVD title ${selection.titleNumber} is not present in the archived scan`,
            );
          }
          if (selection.chapterEnd !== null) {
            if (selection.chapterEnd > title.chapters) {
              throw new DomainInvariantError(
                `chapterEnd must not exceed DVD title ${selection.titleNumber}'s ${title.chapters} chapters`,
              );
            }
          }
        }
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

  function findOriginalArchiveByContentId(
    fingerprint: string,
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
          eq(originalDiscArchives.fingerprint, fingerprint),
          eq(originalDiscArchiveContentIds.contentId, fingerprint),
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
      findOriginalArchiveByContentId(fingerprint) !== undefined
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
          if (findOriginalArchiveByContentId(disc.fingerprint, transaction)) {
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
                archivePath: requireNonEmpty(
                  completion.archivePath,
                  "archivePath",
                ),
                fingerprint: disc.fingerprint,
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
    requeue: (id, expectedStatus, update) =>
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
            isNotNull(originalDiscArchives.catalogReviewedAt),
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
    updateAttempt: (claim, update) =>
      database
        .update(encodeJobs)
        .set(update)
        .where(
          and(
            eq(encodeJobs.id, claim.id),
            eq(encodeJobs.status, "running"),
            eq(encodeJobs.claimToken, claim.claimToken),
          ),
        )
        .returning()
        .get(),
    requeue: (id, expectedStatus, update, options) =>
      database
        .update(encodeJobs)
        .set({
          ...update,
          outputPath: options?.outputPath,
          priority: options?.priority,
        })
        .where(
          and(
            eq(encodeJobs.id, id),
            eq(encodeJobs.status, expectedStatus),
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
                    isNotNull(originalDiscArchives.catalogReviewedAt),
                  ),
                ),
            ),
          ),
        )
        .returning()
        .get(),
  } satisfies JobQueueAdapter<
    EncodeJob,
    RunningEncodeJob,
    EncodeJobId,
    EncodeJobClaimToken,
    void,
    EncodeRequeueOptions,
    void
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
      const matchingArchive = findOriginalArchiveByContentId(
        disc.fingerprint,
        transaction,
      );
      if (matchingArchive) {
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
        const normalized = discovered.map((drive) => ({
          ...drive,
          devicePath: requireNonEmpty(drive.devicePath, "devicePath"),
        }));
        const uniquePaths = new Set(normalized.map((drive) => drive.devicePath));
        if (uniquePaths.size !== normalized.length) {
          throw new DomainInvariantError(
            "Discovered Optical Drive paths must be unique",
          );
        }
        const configuredTargets = normalized.filter(
          (drive) => drive.isConfiguredDevice,
        );
        if (configuredTargets.length > 1) {
          throw new DomainInvariantError(
            "A discovery snapshot can prove only one configured Optical Drive",
          );
        }
        const configuredTargetPath = configuredTargets[0]?.devicePath;

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
          const existingByPath = new Map(
            existingDrives.map((drive) => [drive.devicePath, drive]),
          );
          const previousConfiguredTargetPath = existingDrives.find(
            (drive) => drive.isConfiguredTarget,
          )?.devicePath;
          const configuredTargetChanged =
            configuredTargetPath !== undefined &&
            previousConfiguredTargetPath !== undefined &&
            configuredTargetPath !== previousConfiguredTargetPath;
          if (configuredTargetPath !== undefined) {
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

          for (const drive of normalized) {
            const existing = existingByPath.get(drive.devicePath);
            const existingSerial = existing?.serialNumber?.trim() || undefined;
            const discoveredSerial = drive.serialNumber?.trim() || undefined;
            const serialChanged =
              existing !== undefined && existingSerial !== discoveredSerial;
            const stableIdentityMatches =
              existingSerial !== undefined &&
              discoveredSerial !== undefined &&
              existingSerial === discoveredSerial;
            const modelEvidenceChanged =
              existing !== undefined &&
              ((existing.vendor ?? undefined) !== drive.vendor ||
                (existing.product ?? undefined) !== drive.product);
            const continuityUnprovenAfterDisappearance =
              existing !== undefined &&
              !existing.isPresent &&
              !stableIdentityMatches;
            const isReplacement =
              serialChanged ||
              (modelEvidenceChanged && !stableIdentityMatches) ||
              continuityUnprovenAfterDisappearance;
            const applyConfiguredDefault =
              drive.isConfiguredDevice === true &&
              !configuredTargetChanged &&
              existing?.configurationDefaultResolved !== true;
            transaction
              .insert(opticalDrives)
              .values({
                id: newId<OpticalDriveId>(),
                devicePath: drive.devicePath,
                displayName: drive.displayName,
                vendor: drive.vendor,
                product: drive.product,
                serialNumber: drive.serialNumber,
                isEnabled:
                  drive.isConfiguredDevice === true &&
                  !configuredTargetChanged,
                configurationDefaultResolved:
                  drive.isConfiguredDevice === true,
                isConfiguredTarget: drive.isConfiguredDevice === true,
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
                  ...(isReplacement
                    ? {
                        configurationDefaultResolved:
                          existing?.configurationDefaultResolved === true ||
                          drive.isConfiguredDevice === true,
                        isEnabled: false,
                      }
                    : drive.isConfiguredDevice && configuredTargetChanged
                      ? { configurationDefaultResolved: true }
                      : applyConfiguredDefault
                        ? {
                            configurationDefaultResolved: true,
                            isEnabled: true,
                          }
                        : {}),
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
        let scanData = input.scanData;
        if (input.discKind === "dvd" && scanData !== undefined) {
          const decoded = decodeDvdTitleMap(scanData);
          if (decoded === null) {
            throw new DomainInvariantError(
              "DVD scan data must match the versioned title-map contract",
            );
          }
          if (decoded.contentId !== fingerprint) {
            throw new DomainInvariantError(
              "DVD scan content ID must match its Detected Disc fingerprint",
            );
          }
          scanData = decoded;
        }
        if (input.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            fingerprint,
            input.sizeBytes,
          );
        }
        return database.transaction((transaction) => {
          const matchingArchive = findOriginalArchiveByContentId(
            fingerprint,
            transaction,
          );
          if (
            matchingArchive &&
            matchingArchive.discKind !== input.discKind
          ) {
            throw new DomainInvariantError(
              "Rediscovered disc kind must match existing archive provenance",
            );
          }
          const matchingObservation = transaction
            .select({ discKind: detectedDiscs.discKind })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.fingerprint, fingerprint))
            .get();
          if (
            matchingObservation &&
            matchingObservation.discKind !== input.discKind
          ) {
            throw new DomainInvariantError(
              "Rediscovered disc kind must match existing fingerprint identity",
            );
          }
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
          if (
            matchingArchive !== undefined &&
            existing !== undefined &&
            matchingArchive.detectedDiscId === existing.id &&
            scanData !== undefined &&
            !isDeepStrictEqual(existing.scanData, scanData)
          ) {
            throw new DomainInvariantError(
              "Rediscovery cannot change archived scan evidence",
            );
          }
          const observationChanged =
            existing === undefined ||
            input.isNewMediumObservation === true ||
            existing.discKind !== input.discKind ||
            existing.volumeLabel !== (input.volumeLabel ?? null) ||
            !isDeepStrictEqual(existing.scanData, scanData ?? null);
          const statusChanged =
            matchingArchive !== undefined && existing?.status !== "archived";
          if (
            !matchingArchive &&
            existing?.status === "approved" &&
            (existing.discKind !== input.discKind ||
              (scanData !== undefined &&
                !isDeepStrictEqual(existing.scanData, scanData)))
          ) {
            throw new DomainInvariantError(
              "Rediscovery cannot change reviewed data for an approved Detected Disc",
            );
          }

          transaction
            .insert(detectedDiscs)
            .values({
              id: newId<DetectedDiscId>(),
              opticalDriveId: input.opticalDriveId,
              discKind: input.discKind,
              fingerprint,
              volumeLabel: input.volumeLabel,
              scanData,
              status: matchingArchive ? "archived" : "detected",
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
              ...(matchingArchive ? { status: "archived" as const } : {}),
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
                matchingArchive
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
          if (matchingArchive) {
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
          if (findOriginalArchiveByContentId(fingerprint, transaction)) {
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
        if (options?.offset !== undefined && options.limit === undefined) {
          throw new DomainInvariantError(
            "Original Disc Archive offset requires a bounded limit",
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
                    eq(
                      discSelections.originalDiscArchiveId,
                      originalDiscArchives.id,
                    ),
                  ),
              )
            : undefined,
          options?.needsCatalogReviewOnly
            ? isNull(originalDiscArchives.catalogReviewedAt)
            : undefined,
        ].filter((condition) => condition !== undefined);
        const condition =
          conditions.length > 0 ? and(...conditions) : undefined;
        if (options?.limit !== undefined) {
          const query = database
            .select()
            .from(originalDiscArchives)
            .where(condition)
            .orderBy(
              desc(originalDiscArchives.archivedAt),
              desc(originalDiscArchives.id),
            )
            .limit(requirePositiveSafeInteger(options.limit, "limit"));
          if (options.offset === undefined) {
            return query.all().reverse();
          }
          const offset = optionalSafeInteger(options.offset, "offset", 0);
          if (offset === null || offset === undefined) {
            throw new DomainInvariantError("offset must be a safe integer");
          }
          return query.offset(offset).all().reverse();
        }
        return database
          .select()
          .from(originalDiscArchives)
          .where(condition)
          .orderBy(asc(originalDiscArchives.archivedAt))
          .all();
      },

      completeCatalogReview(id) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const archive = requireReviewableDiscSelections(id, transaction);
          if (archive.catalogReviewedAt !== null) {
            return archive;
          }
          return requireRow(
            transaction
              .update(originalDiscArchives)
              .set({ catalogReviewedAt: timestamp, updatedAt: timestamp })
              .where(
                and(
                  eq(originalDiscArchives.id, id),
                  isNull(originalDiscArchives.catalogReviewedAt),
                ),
              )
              .returning()
              .get(),
            "original disc archive",
            id,
          );
        }, { behavior: "immediate" });
      },

      createMediaItem(input) {
        const timestamp = now();
        const id = newId<MediaItemId>();
        const values = {
          id,
          parentId: input.parentId,
          kind: input.kind,
          title: requireNonEmpty(input.title, "title"),
          year: optionalSafeInteger(input.year, "year", 1800, 9999),
          seasonNumber: optionalSafeInteger(
            input.seasonNumber,
            "seasonNumber",
            0,
          ),
          episodeNumber: optionalSafeInteger(
            input.episodeNumber,
            "episodeNumber",
            1,
          ),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        return database.transaction((transaction) => {
          requireMediaItemHierarchyWithinDepth(
            id,
            input.parentId,
            transaction,
          );
          return requireRow(
            transaction
              .insert(mediaItems)
              .values(values)
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
          const parentId =
            input.parentId === undefined ? current.parentId : input.parentId;
          requireMediaItemHierarchyWithinDepth(id, parentId, transaction);
          return requireRow(
            transaction
              .update(mediaItems)
              .set({
                parentId,
                kind: input.kind ?? current.kind,
                title:
                  input.title === undefined
                    ? current.title
                    : requireNonEmpty(input.title, "title"),
                year:
                  input.year === undefined
                    ? current.year
                    : optionalSafeInteger(input.year, "year", 1800, 9999),
                seasonNumber:
                  input.seasonNumber === undefined
                    ? current.seasonNumber
                    : optionalSafeInteger(
                        input.seasonNumber,
                        "seasonNumber",
                        0,
                      ),
                episodeNumber:
                  input.episodeNumber === undefined
                    ? current.episodeNumber
                    : optionalSafeInteger(
                        input.episodeNumber,
                        "episodeNumber",
                        1,
                      ),
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
        if (options?.offset !== undefined && options.limit === undefined) {
          throw new DomainInvariantError(
            "Media Item offset requires a bounded limit",
          );
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
        if (options?.limit === undefined) {
          return query.all();
        }
        const limited = query.limit(
          requirePositiveSafeInteger(options.limit, "limit"),
        );
        if (options.offset === undefined) {
          return limited.all();
        }
        const offset = optionalSafeInteger(options.offset, "offset", 0);
        if (offset === null || offset === undefined) {
          throw new DomainInvariantError("offset must be a safe integer");
        }
        return limited.offset(offset).all();
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
            const coordinates =
              input.kind === "main_feature"
                ? { titleNumber: null, chapterStart: null, chapterEnd: null }
                : input.kind === "dvd_title"
                  ? {
                      titleNumber: requirePositiveSafeInteger(
                        input.titleNumber,
                        "titleNumber",
                      ),
                      chapterStart: null,
                      chapterEnd: null,
                    }
                  : {
                      titleNumber: requirePositiveSafeInteger(
                        input.titleNumber,
                        "titleNumber",
                      ),
                      chapterStart: requirePositiveSafeInteger(
                        input.chapterStart,
                        "chapterStart",
                      ),
                      chapterEnd: requirePositiveSafeInteger(
                        input.chapterEnd,
                        "chapterEnd",
                      ),
                    };
            if (
              coordinates.chapterStart !== null &&
              coordinates.chapterEnd !== null &&
              coordinates.chapterEnd < coordinates.chapterStart
            ) {
              throw new DomainInvariantError(
                "chapterEnd must be greater than or equal to chapterStart",
              );
            }
            if (coordinates.titleNumber !== null) {
              const archivedTitles = decodeArchivedDvdTitles(source.scanData);
              if (!archivedTitles) {
                throw new DomainInvariantError(
                  "DVD title selections require a reviewable DVD title map",
                );
              }
              const title = archivedTitles.find(
                (candidate) => candidate.number === coordinates.titleNumber,
              );
              if (!title) {
                throw new DomainInvariantError(
                  `DVD title ${coordinates.titleNumber} is not present in the archived scan`,
                );
              }
              if (
                coordinates.chapterEnd !== null &&
                coordinates.chapterEnd > title.chapters
              ) {
                throw new DomainInvariantError(
                  `chapterEnd must not exceed DVD title ${title.number}'s ${title.chapters} chapters`,
                );
              }
            }
            const sourceKey = canonicalDvdSelectionSourceKey({
              kind: input.kind,
              ...coordinates,
            });
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
              .set({ catalogReviewedAt: null, updatedAt: timestamp })
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
                .where(eq(discSelections.id, id))
                .get(),
              "disc selection",
              id,
            );
            const runningJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.discSelectionId, id),
                  eq(encodeJobs.status, "running"),
                ),
              )
              .get();
            if (runningJob) {
              throw new DomainInvariantError(
                `Disc Selection ${id} cannot be deleted while Encode Job ${runningJob.id} is running`,
              );
            }
            const dependentJobIds = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
              .limit(DISC_SELECTION_DELETE_JOB_BATCH_SIZE)
              .all()
              .map((job) => job.id);
            if (dependentJobIds.length > 0) {
              transaction
                .delete(encodeJobs)
                .where(inArray(encodeJobs.id, dependentJobIds))
                .run();
            }
            const hasRemainingJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .get() !== undefined;
            if (!hasRemainingJob) {
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
              .set({ catalogReviewedAt: null, updatedAt: timestamp })
              .where(
                eq(
                  originalDiscArchives.id,
                  selection.originalDiscArchiveId,
                ),
              )
              .run();
            return {
              ...toDiscSelection(selection),
              deletedEncodeJobs: dependentJobIds.length,
              deletionComplete: !hasRemainingJob,
            };
          },
          { behavior: "immediate" },
        );
      },

      listDiscSelections(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        if (options?.offset !== undefined && options.limit === undefined) {
          throw new DomainInvariantError(
            "Disc Selection offset requires a bounded limit",
          );
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
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(discSelections)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id));
        let rows;
        if (options?.limit === undefined) {
          rows = query.all();
        } else {
          const limited = query.limit(
            requirePositiveSafeInteger(options.limit, "limit"),
          );
          if (options.offset === undefined) {
            rows = limited.all();
          } else {
            const offset = optionalSafeInteger(options.offset, "offset", 0);
            if (offset === null || offset === undefined) {
              throw new DomainInvariantError("offset must be a safe integer");
            }
            rows = limited.offset(offset).all();
          }
        }
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
        return database
          .select()
          .from(encodingProfiles)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            asc(encodingProfiles.mediaDomain),
            asc(encodingProfiles.key),
            asc(encodingProfiles.version),
          )
          .all();
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
            .limit(ARCHIVE_JOB_RECOVERY_LIMIT)
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
        return database.transaction(
          (transaction) => {
            const selectionReview = requireRow(
              transaction
                .select({
                  catalogReviewedAt: originalDiscArchives.catalogReviewedAt,
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
                .where(eq(discSelections.id, input.discSelectionId))
                .get(),
              "disc selection",
              input.discSelectionId,
            );
            if (selectionReview.catalogReviewedAt === null) {
              throw new DomainInvariantError(
                "Encode Jobs require a completed catalog review",
              );
            }
            requireReviewableDiscSelections(
              selectionReview.originalDiscArchiveId,
              transaction,
            );
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

            const existing = requireRow(
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
            if (
              existing.status === "failed" ||
              existing.status === "completed"
            ) {
              return encodeJobQueue.requeue(existing.id, {
                outputPath,
                priority: input.priority ?? 0,
              });
            }
            return existing;
          },
          { behavior: "immediate" },
        );
      },

      claimNext: encodeJobQueue.claimNext,
      list: encodeJobQueue.list,
      updateProgress: encodeJobQueue.updateProgress,
      complete: (claim) => encodeJobQueue.complete(claim, undefined),
      fail: encodeJobQueue.fail,
      requeue: encodeJobQueue.requeue,
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
