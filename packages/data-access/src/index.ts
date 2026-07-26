import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
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
  inArray,
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
  originalDiscArchives,
} from "./internal/schema.js";
import {
  createJobQueueController,
  type JobQueueAdapter,
} from "./internal/job-queue.js";
import { discoverLegacySidecars } from "./internal/legacy-sidecars.js";
import {
  requireNonEmpty,
  requirePositiveSafeInteger,
} from "./internal/validation.js";
import { decodeDvdTitleMap } from "./dvd-scan.js";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
} from "./errors.js";
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
  LegacySidecarImportReport,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "./types.js";

export type * from "./types.js";
export * from "./dvd-scan.js";
export * from "./errors.js";

const BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
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

function requireRow<T>(row: T | undefined, recordType: string, id: string): T {
  if (!row) {
    throw new RecordNotFoundError(recordType, id);
  }

  return row;
}

function newId<Id extends string>(): Id {
  return randomUUID() as Id;
}

function emptyLegacyImportRecordCounts():
  LegacySidecarImportReport["recordsCreated"] {
  return {
    originalDiscArchives: 0,
    discSelections: 0,
    mediaItems: 0,
    encodingProfiles: 0,
    encodeJobs: 0,
  };
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

export interface CreateDataAccessOptions {
  databasePath: string;
  migrationsFolder?: string;
}

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
    migrate(database, { migrationsFolder });
    releaseMigrationLock();
    return { database, sqlite };
  } catch (error) {
    sqlite?.close();
    releaseMigrationLock();
    throw error;
  }
}

export function createDataAccess({
  databasePath,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
}: CreateDataAccessOptions): DataAccess {
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

  const archiveJobAdapter = {
    recordType: "archive job",
    find: (id) =>
      database.select().from(archiveJobs).where(eq(archiveJobs.id, id)).get(),
    list: listArchiveJobs,
    claim: (workerId, token, timestamp) => {
      const nextApprovedJobId = sql<ArchiveJobId>`(
        select ${archiveJobs.id}
        from ${archiveJobs}
        inner join ${detectedDiscs}
          on ${detectedDiscs.id} = ${archiveJobs.detectedDiscId}
        where ${archiveJobs.status} = 'queued'
          and ${detectedDiscs.status} = 'approved'
          and not exists (
            select 1
            from ${originalDiscArchives}
            where ${originalDiscArchives.fingerprint} = ${detectedDiscs.fingerprint}
          )
          and not exists (
            select 1
            from archive_jobs as running_archive_jobs
            inner join detected_discs as running_detected_discs
              on running_detected_discs.id = running_archive_jobs.detected_disc_id
            where running_archive_jobs.status = 'running'
              and running_detected_discs.fingerprint = ${detectedDiscs.fingerprint}
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
    updateAttempt: (claim, update, originalDiscArchiveId) => {
      const attemptCondition = and(
        eq(archiveJobs.id, claim.id),
        eq(archiveJobs.status, "running"),
        eq(archiveJobs.claimToken, claim.claimToken),
      );
      if (update.status !== "completed") {
        return database
          .update(archiveJobs)
          .set(update)
          .where(attemptCondition)
          .returning()
          .get();
      }
      if (!originalDiscArchiveId) {
        throw new DomainInvariantError(
          "Completing an Archive Job requires an Original Disc Archive",
        );
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
        const matchingArchive = transaction
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(
            and(
              eq(originalDiscArchives.id, originalDiscArchiveId),
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
          .set({ ...update, originalDiscArchiveId })
          .where(attemptCondition)
          .returning()
          .get();
      });
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
                          eq(
                            originalDiscArchives.fingerprint,
                            detectedDiscs.fingerprint,
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
    OriginalDiscArchiveId,
    void
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
            eq(
              encodeJobs.id,
              sql<EncodeJobId>`(select ${encodeJobs.id} from ${encodeJobs} where ${encodeJobs.status} = 'queued' order by ${encodeJobs.priority} desc, ${encodeJobs.createdAt} asc, ${encodeJobs.id} asc limit 1)`,
            ),
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
          and(eq(encodeJobs.id, id), eq(encodeJobs.status, expectedStatus)),
        )
        .returning()
        .get(),
  } satisfies JobQueueAdapter<
    EncodeJob,
    RunningEncodeJob,
    EncodeJobId,
    EncodeJobClaimToken,
    void,
    EncodeRequeueOptions
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

  const access: DataAccess = {
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
        return database.transaction((transaction) => {
          const matchingArchive = transaction
            .select({ discKind: originalDiscArchives.discKind })
            .from(originalDiscArchives)
            .where(eq(originalDiscArchives.fingerprint, fingerprint))
            .get();
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
          if (status !== "approved") {
            transaction
              .delete(archiveJobs)
              .where(
                and(
                  eq(archiveJobs.detectedDiscId, id),
                  eq(archiveJobs.status, "queued"),
                ),
              )
              .run();
          }
          return updated;
        });
      },

      createOriginalDiscArchive(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
        const archivePath = requireNonEmpty(input.archivePath, "archivePath");
        return database.transaction((transaction) => {
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
        ].filter((condition) => condition !== undefined);
        const condition =
          conditions.length > 0 ? and(...conditions) : undefined;
        if (options?.limit !== undefined) {
          return database
            .select()
            .from(originalDiscArchives)
            .where(condition)
            .orderBy(
              desc(originalDiscArchives.archivedAt),
              desc(originalDiscArchives.id),
            )
            .limit(requirePositiveSafeInteger(options.limit, "limit"))
            .all()
            .reverse();
        }
        return database
          .select()
          .from(originalDiscArchives)
          .where(condition)
          .orderBy(asc(originalDiscArchives.archivedAt))
          .all();
      },

      createMediaItem(input) {
        const timestamp = now();
        const id = newId<MediaItemId>();
        return requireRow(
          database
            .insert(mediaItems)
            .values({
              id,
              parentId: input.parentId,
              kind: input.kind,
              title: requireNonEmpty(input.title, "title"),
              year: input.year,
              seasonNumber: input.seasonNumber,
              episodeNumber: input.episodeNumber,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
            .get(),
          "media item",
          id,
        );
      },

      listMediaItems(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        return database
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
          )
          .all();
      },

      createDiscSelection(input) {
        const timestamp = now();
        const id = newId<DiscSelectionId>();
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
        return toDiscSelection(
          requireRow(
            database
              .insert(discSelections)
              .values({
                id,
                originalDiscArchiveId: input.originalDiscArchiveId,
                mediaItemId: input.mediaItemId,
                sourceKey: requireNonEmpty(input.sourceKey, "sourceKey"),
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
      },

      listDiscSelections(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        return database
          .select()
          .from(discSelections)
          .where(
            options?.ids
              ? inArray(discSelections.id, [...options.ids])
              : undefined,
          )
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
          .all()
          .map(toDiscSelection);
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
              notExists(
                database
                  .select({ id: originalDiscArchives.id })
                  .from(originalDiscArchives)
                  .where(
                    eq(
                      originalDiscArchives.fingerprint,
                      detectedDiscs.fingerprint,
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
      list: archiveJobQueue.list,
      updateProgress: archiveJobQueue.updateProgress,
      complete: archiveJobQueue.complete,
      fail: archiveJobQueue.fail,
      requeue: archiveJobQueue.requeue,
    },

    encodeJobs: {
      enqueue(input) {
        const timestamp = now();
        database
          .insert(encodeJobs)
          .values({
            id: newId<EncodeJobId>(),
            discSelectionId: input.discSelectionId,
            encodingProfileId: input.encodingProfileId,
            outputPath: requireNonEmpty(input.outputPath, "outputPath"),
            priority: input.priority ?? 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing({
            target: [encodeJobs.discSelectionId, encodeJobs.encodingProfileId],
          })
          .run();

        const existing = requireRow(
          database
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
        if (existing.status === "failed" || existing.status === "completed") {
          return encodeJobQueue.requeue(existing.id, {
            outputPath: requireNonEmpty(input.outputPath, "outputPath"),
            priority: input.priority ?? 0,
          });
        }
        return existing;
      },

      claimNext: encodeJobQueue.claimNext,
      list: encodeJobQueue.list,
      updateProgress: encodeJobQueue.updateProgress,
      complete: (claim) => encodeJobQueue.complete(claim, undefined),
      fail: encodeJobQueue.fail,
      requeue: encodeJobQueue.requeue,
    },

    legacySidecars: {
      importLibrary(input) {
        const originalsLibraryPath = resolve(
          requireNonEmpty(input.originalsLibraryPath, "originalsLibraryPath"),
        );
        const discoveries = discoverLegacySidecars(originalsLibraryPath);
        const report: LegacySidecarImportReport = {
          originalsLibraryPath,
          sidecarsFound: discoveries.length,
          sidecarsImported: 0,
          sidecarsSkipped: 0,
          recordsCreated: emptyLegacyImportRecordCounts(),
          recordsUpdated: 0,
          recordsUnchanged: 0,
          issues: [],
        };

        for (const discovery of discoveries) {
          if (discovery.outcome === "skipped") {
            report.sidecarsSkipped += 1;
            report.issues.push(discovery.issue);
            continue;
          }

          const { sidecar } = discovery;
          report.issues.push(...sidecar.issues);
          const created = emptyLegacyImportRecordCounts();
          let updated = 0;
          let unchanged = 0;
          const persistenceIssues: LegacySidecarImportReport["issues"] = [];

          try {
            database.transaction((transaction) => {
              const existingByFingerprint = transaction
                .select()
                .from(originalDiscArchives)
                .where(
                  eq(originalDiscArchives.fingerprint, sidecar.fingerprint),
                )
                .get();
              const existingByPath = transaction
                .select()
                .from(originalDiscArchives)
                .where(eq(originalDiscArchives.archivePath, sidecar.archivePath))
                .get();
              if (
                existingByFingerprint &&
                existingByPath &&
                existingByFingerprint.id !== existingByPath.id
              ) {
                throw new DomainInvariantError(
                  "Archive fingerprint and path belong to different records",
                );
              }
              if (
                existingByFingerprint &&
                existingByFingerprint.archivePath !== sidecar.archivePath
              ) {
                throw new DomainInvariantError(
                  "Archive fingerprint is already assigned to a different path",
                );
              }

              const timestamp = now();
              let archive = existingByFingerprint ?? existingByPath;
              if (
                existingByPath &&
                existingByPath.fingerprint !== sidecar.fingerprint
              ) {
                throw new DomainInvariantError(
                  "Archive path is already assigned to a different fingerprint",
                );
              }
              if (!archive) {
                const legacyDevicePath = `legacy-sidecar:${originalsLibraryPath}`;
                transaction
                  .insert(opticalDrives)
                  .values({
                    id: newId<OpticalDriveId>(),
                    devicePath: legacyDevicePath,
                    displayName: "Legacy sidecar import",
                    isEnabled: false,
                    isPresent: false,
                    lastSeenAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .onConflictDoNothing({ target: opticalDrives.devicePath })
                  .run();
                const drive = requireRow(
                  transaction
                    .select()
                    .from(opticalDrives)
                    .where(eq(opticalDrives.devicePath, legacyDevicePath))
                    .get(),
                  "legacy import source",
                  legacyDevicePath,
                );
                transaction
                  .insert(detectedDiscs)
                  .values({
                    id: newId<DetectedDiscId>(),
                    opticalDriveId: drive.id,
                    discKind: "dvd",
                    fingerprint: sidecar.fingerprint,
                    volumeLabel: sidecar.movieTitle,
                    status: "archived",
                    scanData: sidecar.scanData,
                    detectedAt: timestamp,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .onConflictDoNothing({
                    target: [
                      detectedDiscs.opticalDriveId,
                      detectedDiscs.fingerprint,
                    ],
                  })
                  .run();
                const disc = requireRow(
                  transaction
                    .select()
                    .from(detectedDiscs)
                    .where(
                      and(
                        eq(detectedDiscs.opticalDriveId, drive.id),
                        eq(detectedDiscs.fingerprint, sidecar.fingerprint),
                      ),
                    )
                    .get(),
                  "legacy detected disc",
                  sidecar.fingerprint,
                );
                archive = requireRow(
                  transaction
                    .insert(originalDiscArchives)
                    .values({
                      id: newId<OriginalDiscArchiveId>(),
                      detectedDiscId: disc.id,
                      discKind: "dvd",
                      archiveFormat: "iso",
                      archivePath: sidecar.archivePath,
                      fingerprint: sidecar.fingerprint,
                      sizeBytes: sidecar.archiveSizeBytes,
                      archivedAt: timestamp,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    })
                    .returning()
                    .get(),
                  "original disc archive",
                  sidecar.archivePath,
                );
                created.originalDiscArchives += 1;
              } else {
                const archiveChanged =
                  archive.archivePath !== sidecar.archivePath ||
                  archive.sizeBytes !== sidecar.archiveSizeBytes;
                if (archiveChanged) {
                  archive = requireRow(
                    transaction
                      .update(originalDiscArchives)
                      .set({
                        archivePath: sidecar.archivePath,
                        sizeBytes: sidecar.archiveSizeBytes,
                        updatedAt: timestamp,
                      })
                      .where(eq(originalDiscArchives.id, archive.id))
                      .returning()
                      .get(),
                    "original disc archive",
                    archive.id,
                  );
                  updated += 1;
                } else {
                  unchanged += 1;
                }
              }

              let movieItem: typeof mediaItems.$inferSelect | undefined;
              const existingSelections = transaction
                .select()
                .from(discSelections)
                .where(
                  eq(discSelections.originalDiscArchiveId, archive.id),
                )
                .all();
              const selectionsBySourceKey = new Map(
                existingSelections.map((selection) => [
                  selection.sourceKey,
                  selection,
                ]),
              );
              const existingMovieSelection = sidecar.jobs
                .filter((job) => job.mediaItemKind === "movie")
                .map((job) => selectionsBySourceKey.get(job.sourceKey))
                .find((selection) => selection !== undefined);
              if (existingMovieSelection) {
                movieItem = transaction
                  .select()
                  .from(mediaItems)
                  .where(eq(mediaItems.id, existingMovieSelection.mediaItemId))
                  .get();
              } else {
                const existingExtraSelection = sidecar.jobs
                  .filter((job) => job.mediaItemKind === "bonus_feature")
                  .map((job) => selectionsBySourceKey.get(job.sourceKey))
                  .find((selection) => selection !== undefined);
                if (existingExtraSelection) {
                  const extra = transaction
                    .select()
                    .from(mediaItems)
                    .where(eq(mediaItems.id, existingExtraSelection.mediaItemId))
                    .get();
                  if (extra?.parentId) {
                    movieItem = transaction
                      .select()
                      .from(mediaItems)
                      .where(eq(mediaItems.id, extra.parentId))
                      .get();
                  }
                }
              }
              const requireMovieItem = () => {
                if (movieItem) {
                  return movieItem;
                }
                movieItem = requireRow(
                  transaction
                    .insert(mediaItems)
                    .values({
                      id: newId<MediaItemId>(),
                      kind: "movie",
                      title: sidecar.movieTitle,
                      year: sidecar.movieYear,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    })
                    .returning()
                    .get(),
                  "legacy media item",
                  sidecar.movieTitle,
                );
                created.mediaItems += 1;
                return movieItem;
              };

              for (const job of sidecar.jobs) {
                let selection = selectionsBySourceKey.get(job.sourceKey);
                let profile = transaction
                  .select()
                  .from(encodingProfiles)
                  .where(
                    and(
                      eq(encodingProfiles.mediaDomain, "dvd_video"),
                      eq(encodingProfiles.key, job.profileKey),
                      eq(encodingProfiles.version, 1),
                    ),
                  )
                  .get();
                const outputJob = transaction
                  .select()
                  .from(encodeJobs)
                  .where(eq(encodeJobs.outputPath, job.outputPath))
                  .get();
                if (
                  outputJob &&
                  (!selection ||
                    !profile ||
                    outputJob.discSelectionId !== selection.id ||
                    outputJob.encodingProfileId !== profile.id)
                ) {
                  persistenceIssues.push({
                    code: "duplicate_record",
                    jobIndex: job.jobIndex,
                    message: `Encode Job output is already assigned: ${job.outputPath}`,
                    sidecarPath: sidecar.sidecarPath,
                  });
                  continue;
                }
                let mediaItem: typeof mediaItems.$inferSelect;
                if (selection) {
                  if (
                    selection.kind !== job.kind ||
                    selection.titleNumber !== job.titleNumber
                  ) {
                    throw new DomainInvariantError(
                      `Disc Selection ${job.sourceKey} has incompatible coordinates`,
                    );
                  }
                  mediaItem = requireRow(
                    transaction
                      .select()
                      .from(mediaItems)
                      .where(eq(mediaItems.id, selection.mediaItemId))
                      .get(),
                    "legacy media item",
                    selection.mediaItemId,
                  );
                  if (
                    job.mediaItemKind === "movie" &&
                    mediaItem.id !== requireMovieItem().id
                  ) {
                    throw new DomainInvariantError(
                      `Movie Disc Selection ${job.sourceKey} maps to a duplicate Media Item`,
                    );
                  }
                  const parentId =
                    job.mediaItemKind === "movie"
                      ? null
                      : requireMovieItem().id;
                  const year =
                    job.mediaItemKind === "movie" ? sidecar.movieYear : null;
                  const mediaChanged =
                    mediaItem.kind !== job.mediaItemKind ||
                    mediaItem.title !== job.mediaTitle ||
                    mediaItem.year !== year ||
                    mediaItem.parentId !== parentId;
                  if (mediaChanged) {
                    mediaItem = requireRow(
                      transaction
                        .update(mediaItems)
                        .set({
                          kind: job.mediaItemKind,
                          title: job.mediaTitle,
                          year,
                          parentId,
                          updatedAt: timestamp,
                        })
                        .where(eq(mediaItems.id, mediaItem.id))
                        .returning()
                        .get(),
                      "legacy media item",
                      mediaItem.id,
                    );
                    updated += 1;
                  } else {
                    unchanged += 1;
                  }
                  if (selection.label !== job.label) {
                    selection = requireRow(
                      transaction
                        .update(discSelections)
                        .set({ label: job.label, updatedAt: timestamp })
                        .where(eq(discSelections.id, selection.id))
                        .returning()
                        .get(),
                      "legacy disc selection",
                      selection.id,
                    );
                    updated += 1;
                  } else {
                    unchanged += 1;
                  }
                } else {
                  mediaItem =
                    job.mediaItemKind === "movie"
                      ? requireMovieItem()
                      : requireRow(
                          transaction
                            .insert(mediaItems)
                            .values({
                              id: newId<MediaItemId>(),
                              parentId: requireMovieItem().id,
                              kind: "bonus_feature",
                              title: job.mediaTitle,
                              createdAt: timestamp,
                              updatedAt: timestamp,
                            })
                            .returning()
                            .get(),
                          "legacy media item",
                          job.mediaTitle,
                        );
                  if (job.mediaItemKind !== "movie") {
                    created.mediaItems += 1;
                  }
                  selection = requireRow(
                    transaction
                      .insert(discSelections)
                      .values({
                        id: newId<DiscSelectionId>(),
                        originalDiscArchiveId: archive.id,
                        mediaItemId: mediaItem.id,
                        sourceKey: job.sourceKey,
                        kind: job.kind,
                        titleNumber: job.titleNumber,
                        chapterStart: null,
                        chapterEnd: null,
                        label: job.label,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      })
                      .returning()
                      .get(),
                    "legacy disc selection",
                    job.sourceKey,
                  );
                  selectionsBySourceKey.set(job.sourceKey, selection);
                  created.discSelections += 1;
                }

                if (!profile) {
                  profile = requireRow(
                    transaction
                      .insert(encodingProfiles)
                      .values({
                        id: newId<EncodingProfileId>(),
                        key: job.profileKey,
                        displayName: job.preset,
                        mediaDomain: "dvd_video",
                        version: 1,
                        settings: { preset: job.preset },
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      })
                      .returning()
                      .get(),
                    "legacy encoding profile",
                    job.profileKey,
                  );
                  created.encodingProfiles += 1;
                } else {
                  unchanged += 1;
                }

                const logicalJob = transaction
                  .select()
                  .from(encodeJobs)
                  .where(
                    and(
                      eq(encodeJobs.discSelectionId, selection.id),
                      eq(encodeJobs.encodingProfileId, profile.id),
                    ),
                  )
                  .get();
                const existingJob = logicalJob ?? outputJob;
                if (!existingJob) {
                  transaction
                    .insert(encodeJobs)
                    .values({
                      id: newId<EncodeJobId>(),
                      discSelectionId: selection.id,
                      encodingProfileId: profile.id,
                      outputPath: job.outputPath,
                      status: job.completed ? "completed" : "queued",
                      progressPercent: job.completed ? 100 : 0,
                      completedAt: job.completed ? timestamp : null,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    })
                    .run();
                  created.encodeJobs += 1;
                } else if (
                  existingJob.status === "running" ||
                  (existingJob.outputPath === job.outputPath &&
                    existingJob.status ===
                      (job.completed ? "completed" : "queued") &&
                    existingJob.progressPercent === (job.completed ? 100 : 0))
                ) {
                  unchanged += 1;
                } else {
                  transaction
                    .update(encodeJobs)
                    .set({
                      outputPath: job.outputPath,
                      status: job.completed ? "completed" : "queued",
                      progressPercent: job.completed ? 100 : 0,
                      claimedBy: null,
                      claimToken: null,
                      claimedAt: null,
                      startedAt: null,
                      completedAt: job.completed ? timestamp : null,
                      errorMessage: null,
                      updatedAt: timestamp,
                    })
                    .where(eq(encodeJobs.id, existingJob.id))
                    .run();
                  updated += 1;
                }
              }
            });
          } catch (error) {
            report.sidecarsSkipped += 1;
            report.issues.push({
              code:
                error instanceof DomainInvariantError
                  ? "duplicate_record"
                  : "invalid_sidecar",
              message:
                error instanceof Error ? error.message : String(error),
              sidecarPath: sidecar.sidecarPath,
            });
            continue;
          }

          report.sidecarsImported += 1;
          for (const key of Object.keys(created) as Array<keyof typeof created>) {
            report.recordsCreated[key] += created[key];
          }
          report.recordsUpdated += updated;
          report.recordsUnchanged += unchanged;
          report.issues.push(...persistenceIssues);
        }

        return report;
      },
    },

    close() {
      sqlite.close();
    },
  };

  return access;
}
