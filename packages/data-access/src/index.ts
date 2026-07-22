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

import {
  and,
  asc,
  desc,
  eq,
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
import {
  requireNonEmpty,
  requirePositiveSafeInteger,
} from "./internal/validation.js";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
} from "./errors.js";
import type {
  ArchiveJobClaimToken,
  ArchiveJobId,
  ArchiveJob,
  DataAccess,
  DetectedDiscId,
  DetectedDiscStatus,
  DiscSelection,
  DiscSelectionId,
  EncodeJobClaimToken,
  EncodeJobId,
  EncodeJob,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RunningArchiveJob,
  RunningEncodeJob,
} from "./types.js";

export type * from "./types.js";
export * from "./errors.js";

const BUSY_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

const detectedDiscTransitions: Readonly<
  Record<DetectedDiscStatus, readonly DetectedDiscStatus[]>
> = {
  detected: ["scanned", "rejected"],
  scanned: ["approved", "rejected"],
  approved: ["archived", "rejected"],
  archived: [],
  rejected: ["detected"],
};

function requireRow<T>(row: T | undefined, recordType: string, id: string): T {
  if (!row) {
    throw new RecordNotFoundError(recordType, id);
  }

  return row;
}

function newId<Id extends string>(): Id {
  return randomUUID() as Id;
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

  const archiveJobAdapter = {
    recordType: "archive job",
    find: (id) =>
      database.select().from(archiveJobs).where(eq(archiveJobs.id, id)).get(),
    list: (statuses) =>
      database
        .select()
        .from(archiveJobs)
        .where(
          statuses?.length ? inArray(archiveJobs.status, statuses) : undefined,
        )
        .orderBy(desc(archiveJobs.priority), asc(archiveJobs.createdAt))
        .all(),
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

  const encodeJobAdapter = {
    recordType: "encode job",
    find: (id) =>
      database.select().from(encodeJobs).where(eq(encodeJobs.id, id)).get(),
    list: (statuses) =>
      database
        .select()
        .from(encodeJobs)
        .where(
          statuses?.length ? inArray(encodeJobs.status, statuses) : undefined,
        )
        .orderBy(desc(encodeJobs.priority), asc(encodeJobs.createdAt))
        .all(),
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

  const access: DataAccess = {
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
              isPresent: input.isPresent,
              lastSeenAt: timestamp,
              updatedAt: timestamp,
            },
          })
          .returning()
          .get();
        return requireRow(inserted, "optical drive", devicePath);
      },

      listOpticalDrives() {
        return database
          .select()
          .from(opticalDrives)
          .orderBy(asc(opticalDrives.devicePath))
          .all();
      },

      registerDetectedDisc(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
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

          transaction
            .insert(detectedDiscs)
            .values({
              id: newId<DetectedDiscId>(),
              opticalDriveId: input.opticalDriveId,
              discKind: input.discKind,
              fingerprint,
              volumeLabel: input.volumeLabel,
              scanData: input.scanData,
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
              scanData: input.scanData,
              ...(matchingArchive ? { status: "archived" as const } : {}),
              detectedAt: timestamp,
              updatedAt: timestamp,
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
        });
      },

      listDetectedDiscs(statuses) {
        return database
          .select()
          .from(detectedDiscs)
          .where(
            statuses?.length
              ? inArray(detectedDiscs.status, statuses)
              : undefined,
          )
          .orderBy(asc(detectedDiscs.detectedAt), asc(detectedDiscs.id))
          .all();
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
            .delete(archiveJobs)
            .where(queuedArchiveJobsForFingerprint(fingerprint))
            .run();
          return archive;
        });
      },

      listOriginalDiscArchives() {
        return database
          .select()
          .from(originalDiscArchives)
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

      listMediaItems() {
        return database
          .select()
          .from(mediaItems)
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

      listDiscSelections() {
        return database
          .select()
          .from(discSelections)
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
          .all()
          .map(toDiscSelection);
      },

      createEncodingProfile(input) {
        const timestamp = now();
        const id = newId<EncodingProfileId>();
        return requireRow(
          database
            .insert(encodingProfiles)
            .values({
              id,
              key: requireNonEmpty(input.key, "key"),
              displayName: requireNonEmpty(input.displayName, "displayName"),
              mediaDomain: input.mediaDomain,
              version: input.version,
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

      findEncodingProfile(input) {
        const key = requireNonEmpty(input.key, "key");
        return (
          database
            .select()
            .from(encodingProfiles)
            .where(
              and(
                eq(encodingProfiles.mediaDomain, input.mediaDomain),
                eq(encodingProfiles.key, key),
                eq(encodingProfiles.version, input.version),
              ),
            )
            .get() ?? null
        );
      },

      listEncodingProfiles() {
        return database
          .select()
          .from(encodingProfiles)
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

    close() {
      sqlite.close();
    },
  };

  return access;
}
