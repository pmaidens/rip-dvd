import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
import type {
  ArchiveJob,
  DataAccess,
  DetectedDiscStatus,
  EncodeJob,
} from "./types.js";

export type * from "./types.js";

const BUSY_TIMEOUT_MS = 5_000;
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

export class RecordNotFoundError extends Error {
  constructor(recordType: string, id: string) {
    super(`${recordType} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(recordType: string, from: string, to: string) {
    super(`Invalid ${recordType} status transition: ${from} -> ${to}`);
    this.name = "InvalidStatusTransitionError";
  }
}

function requireRow<T>(row: T | undefined, recordType: string, id: string): T {
  if (!row) {
    throw new RecordNotFoundError(recordType, id);
  }

  return row;
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must not be empty`);
  }
  return normalized;
}

function requireProgress(progressPercent: number): number {
  if (
    !Number.isInteger(progressPercent) ||
    progressPercent < 0 ||
    progressPercent > 100
  ) {
    throw new Error("progressPercent must be an integer between 0 and 100");
  }
  return progressPercent;
}

export interface CreateDataAccessOptions {
  databasePath: string;
  migrationsFolder?: string;
}

function openMigratedDatabase(databasePath: string, migrationsFolder: string) {
  const sqlite = new DatabaseSync(databasePath);

  try {
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
    return { database, sqlite };
  } catch (error) {
    sqlite.close();
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

  function findArchiveJob(id: string): ArchiveJob {
    return requireRow(
      database.select().from(archiveJobs).where(eq(archiveJobs.id, id)).get(),
      "archive job",
      id,
    );
  }

  function findEncodeJob(id: string): EncodeJob {
    return requireRow(
      database.select().from(encodeJobs).where(eq(encodeJobs.id, id)).get(),
      "encode job",
      id,
    );
  }

  function requeueArchiveJob(id: string): ArchiveJob {
    const current = findArchiveJob(id);
    if (current.status !== "failed" && current.status !== "completed") {
      throw new InvalidStatusTransitionError(
        "archive job",
        current.status,
        "queued",
      );
    }

    return requireRow(
      database
        .update(archiveJobs)
        .set({
          status: "queued",
          progressPercent: 0,
          claimedBy: null,
          claimedAt: null,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          updatedAt: now(),
        })
        .where(and(eq(archiveJobs.id, id), eq(archiveJobs.status, current.status)))
        .returning()
        .get(),
      "archive job",
      id,
    );
  }

  function requeueEncodeJob(
    id: string,
    updates: { outputPath?: string; priority?: number } = {},
  ): EncodeJob {
    const current = findEncodeJob(id);
    if (current.status !== "failed" && current.status !== "completed") {
      throw new InvalidStatusTransitionError(
        "encode job",
        current.status,
        "queued",
      );
    }

    return requireRow(
      database
        .update(encodeJobs)
        .set({
          status: "queued",
          progressPercent: 0,
          claimedBy: null,
          claimedAt: null,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          outputPath: updates.outputPath,
          priority: updates.priority,
          updatedAt: now(),
        })
        .where(and(eq(encodeJobs.id, id), eq(encodeJobs.status, current.status)))
        .returning()
        .get(),
      "encode job",
      id,
    );
  }

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
            id: randomUUID(),
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
        const inserted = database
          .insert(detectedDiscs)
          .values({
            id: randomUUID(),
            opticalDriveId: input.opticalDriveId,
            discKind: input.discKind,
            fingerprint,
            volumeLabel: input.volumeLabel,
            scanData: input.scanData,
            detectedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: [detectedDiscs.opticalDriveId, detectedDiscs.fingerprint],
            set: {
              discKind: input.discKind,
              volumeLabel: input.volumeLabel,
              scanData: input.scanData,
              detectedAt: timestamp,
              updatedAt: timestamp,
            },
          })
          .returning()
          .get();
        return requireRow(inserted, "detected disc", fingerprint);
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
        const current = requireRow(
          database
            .select()
            .from(detectedDiscs)
            .where(eq(detectedDiscs.id, id))
            .get(),
          "detected disc",
          id,
        );
        if (!detectedDiscTransitions[current.status].includes(status)) {
          throw new InvalidStatusTransitionError(
            "detected disc",
            current.status,
            status,
          );
        }

        return requireRow(
          database
            .update(detectedDiscs)
            .set({ status, updatedAt: now() })
            .where(
              and(
                eq(detectedDiscs.id, id),
                eq(detectedDiscs.status, current.status),
              ),
            )
            .returning()
            .get(),
          "detected disc",
          id,
        );
      },

      createOriginalDiscArchive(input) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const archive = requireRow(
            transaction
              .insert(originalDiscArchives)
              .values({
                id: randomUUID(),
                detectedDiscId: input.detectedDiscId,
                discKind: input.discKind,
                archiveFormat: input.archiveFormat,
                archivePath: requireNonEmpty(input.archivePath, "archivePath"),
                fingerprint: requireNonEmpty(input.fingerprint, "fingerprint"),
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
            .where(eq(detectedDiscs.id, input.detectedDiscId))
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
        const id = randomUUID();
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
        const id = randomUUID();
        return requireRow(
          database
            .insert(discSelections)
            .values({
              id,
              originalDiscArchiveId: input.originalDiscArchiveId,
              mediaItemId: input.mediaItemId,
              sourceKey: requireNonEmpty(input.sourceKey, "sourceKey"),
              kind: input.kind,
              titleNumber: input.titleNumber,
              chapterStart: input.chapterStart,
              chapterEnd: input.chapterEnd,
              label: input.label,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
            .get(),
          "disc selection",
          id,
        );
      },

      listDiscSelections() {
        return database
          .select()
          .from(discSelections)
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
          .all();
      },

      createEncodingProfile(input) {
        const timestamp = now();
        const id = randomUUID();
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

      listEncodingProfiles() {
        return database
          .select()
          .from(encodingProfiles)
          .orderBy(asc(encodingProfiles.key), asc(encodingProfiles.version))
          .all();
      },
    },

    archiveJobs: {
      enqueue(input) {
        const timestamp = now();
        database
          .insert(archiveJobs)
          .values({
            id: randomUUID(),
            detectedDiscId: input.detectedDiscId,
            priority: input.priority ?? 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoNothing({ target: archiveJobs.detectedDiscId })
          .run();
        return requireRow(
          database
            .select()
            .from(archiveJobs)
            .where(eq(archiveJobs.detectedDiscId, input.detectedDiscId))
            .get(),
          "archive job",
          input.detectedDiscId,
        );
      },

      claimNext(workerId) {
        const timestamp = now();
        return (
          database
            .update(archiveJobs)
            .set({
              status: "running",
              claimedBy: requireNonEmpty(workerId, "workerId"),
              claimedAt: timestamp,
              startedAt: timestamp,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.status, "queued"),
                eq(
                  archiveJobs.id,
                  sql<string>`(select ${archiveJobs.id} from ${archiveJobs} where ${archiveJobs.status} = 'queued' order by ${archiveJobs.priority} desc, ${archiveJobs.createdAt} asc, ${archiveJobs.id} asc limit 1)`,
                ),
              ),
            )
            .returning()
            .get() ?? null
        );
      },

      list(statuses) {
        return database
          .select()
          .from(archiveJobs)
          .where(statuses?.length ? inArray(archiveJobs.status, statuses) : undefined)
          .orderBy(desc(archiveJobs.priority), asc(archiveJobs.createdAt))
          .all();
      },

      updateProgress(id, progressPercent) {
        const current = findArchiveJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "archive job",
            current.status,
            "running progress",
          );
        }
        return requireRow(
          database
            .update(archiveJobs)
            .set({
              progressPercent: requireProgress(progressPercent),
              updatedAt: now(),
            })
            .where(and(eq(archiveJobs.id, id), eq(archiveJobs.status, "running")))
            .returning()
            .get(),
          "archive job",
          id,
        );
      },

      complete(id, originalDiscArchiveId) {
        const current = findArchiveJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "archive job",
            current.status,
            "completed",
          );
        }
        const timestamp = now();
        return requireRow(
          database
            .update(archiveJobs)
            .set({
              status: "completed",
              progressPercent: 100,
              originalDiscArchiveId,
              completedAt: timestamp,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(and(eq(archiveJobs.id, id), eq(archiveJobs.status, "running")))
            .returning()
            .get(),
          "archive job",
          id,
        );
      },

      fail(id, errorMessage) {
        const current = findArchiveJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "archive job",
            current.status,
            "failed",
          );
        }
        return requireRow(
          database
            .update(archiveJobs)
            .set({
              status: "failed",
              errorMessage: requireNonEmpty(errorMessage, "errorMessage"),
              updatedAt: now(),
            })
            .where(and(eq(archiveJobs.id, id), eq(archiveJobs.status, "running")))
            .returning()
            .get(),
          "archive job",
          id,
        );
      },

      requeue: requeueArchiveJob,
    },

    encodeJobs: {
      enqueue(input) {
        const timestamp = now();
        database
          .insert(encodeJobs)
          .values({
            id: randomUUID(),
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
          return requeueEncodeJob(existing.id, {
            outputPath: requireNonEmpty(input.outputPath, "outputPath"),
            priority: input.priority ?? 0,
          });
        }
        return existing;
      },

      claimNext(workerId) {
        const timestamp = now();
        return (
          database
            .update(encodeJobs)
            .set({
              status: "running",
              claimedBy: requireNonEmpty(workerId, "workerId"),
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
                  sql<string>`(select ${encodeJobs.id} from ${encodeJobs} where ${encodeJobs.status} = 'queued' order by ${encodeJobs.priority} desc, ${encodeJobs.createdAt} asc, ${encodeJobs.id} asc limit 1)`,
                ),
              ),
            )
            .returning()
            .get() ?? null
        );
      },

      list(statuses) {
        return database
          .select()
          .from(encodeJobs)
          .where(statuses?.length ? inArray(encodeJobs.status, statuses) : undefined)
          .orderBy(desc(encodeJobs.priority), asc(encodeJobs.createdAt))
          .all();
      },

      updateProgress(id, progressPercent) {
        const current = findEncodeJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "encode job",
            current.status,
            "running progress",
          );
        }
        return requireRow(
          database
            .update(encodeJobs)
            .set({
              progressPercent: requireProgress(progressPercent),
              updatedAt: now(),
            })
            .where(and(eq(encodeJobs.id, id), eq(encodeJobs.status, "running")))
            .returning()
            .get(),
          "encode job",
          id,
        );
      },

      complete(id) {
        const current = findEncodeJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "encode job",
            current.status,
            "completed",
          );
        }
        const timestamp = now();
        return requireRow(
          database
            .update(encodeJobs)
            .set({
              status: "completed",
              progressPercent: 100,
              completedAt: timestamp,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(and(eq(encodeJobs.id, id), eq(encodeJobs.status, "running")))
            .returning()
            .get(),
          "encode job",
          id,
        );
      },

      fail(id, errorMessage) {
        const current = findEncodeJob(id);
        if (current.status !== "running") {
          throw new InvalidStatusTransitionError(
            "encode job",
            current.status,
            "failed",
          );
        }
        return requireRow(
          database
            .update(encodeJobs)
            .set({
              status: "failed",
              errorMessage: requireNonEmpty(errorMessage, "errorMessage"),
              updatedAt: now(),
            })
            .where(and(eq(encodeJobs.id, id), eq(encodeJobs.status, "running")))
            .returning()
            .get(),
          "encode job",
          id,
        );
      },

      requeue: requeueEncodeJob,
    },

    close() {
      sqlite.close();
    },
  };

  return access;
}
