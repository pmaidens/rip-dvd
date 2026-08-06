import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { TextDecoder } from "node:util";
import type { DatabaseSync } from "node:sqlite";

import { ENCODE_JOB_LEASE_DURATION_MS } from "../types.js";
import { isPathWithinDirectory } from "./path-containment.js";

const LEGACY_QUEUE_CUTOVER_MARKER = ".rip-dvd-sqlite-catalog";
const MAX_LEGACY_MARKER_BYTES = 8_388_608;
const MAX_LEGACY_LIBRARY_ENTRIES = 10_000;
const MAX_LEGACY_IMPORT_JOBS = 1_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface LegacyRepairArchiveIdentity {
  archivePath: string;
  fingerprint: string;
  sidecarPath: string;
}

export interface PublicationMutationRecoveryLockHandle {
  release(): void;
}

export interface PublicationMutationRecoveryLock {
  tryAcquire(outputPath: string): PublicationMutationRecoveryLockHandle | null;
}

interface ActivePublicationMutationRow {
  archivePath: string;
  claimToken: string;
  fingerprint: string;
  id: string;
  legacyCutoverPending: number;
  leaseToken: string;
  outputPath: string;
  updatedAt: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readBoundedMarker(markerPath: string): unknown {
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("SQLite cutover marker must be a regular file");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(markerPath, "r");
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile()) {
      throw new Error("SQLite cutover marker must be a regular file");
    }
    if (openedStat.size > MAX_LEGACY_MARKER_BYTES) {
      throw new Error(
        `SQLite cutover marker exceeds the ${MAX_LEGACY_MARKER_BYTES}-byte limit`,
      );
    }
    const buffer = Buffer.alloc(MAX_LEGACY_MARKER_BYTES + 1);
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
    if (bytesRead > MAX_LEGACY_MARKER_BYTES) {
      throw new Error(
        `SQLite cutover marker exceeds the ${MAX_LEGACY_MARKER_BYTES}-byte limit`,
      );
    }
    return JSON.parse(UTF8_DECODER.decode(buffer.subarray(0, bytesRead)));
  } catch (error) {
    throw new Error(
      `Invalid SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readLegacyRepairArchiveInventory(
  originalsLibraryPath: string,
): LegacyRepairArchiveIdentity[] {
  const libraryPath = realpathSync(originalsLibraryPath);
  if (!statSync(libraryPath).isDirectory()) {
    throw new Error(`Originals library is not a directory: ${libraryPath}`);
  }
  const markerPath = join(libraryPath, LEGACY_QUEUE_CUTOVER_MARKER);
  if (!existsSync(markerPath)) {
    return [];
  }
  const value = objectValue(readBoundedMarker(markerPath));
  if (
    value?.schemaVersion !== 4 ||
    value.authoritativeStore !== "sqlite" ||
    value.legacyQueueStatus !== "repair"
  ) {
    return [];
  }
  if (
    !Array.isArray(value.legacySidecars) ||
    value.legacySidecars.length > MAX_LEGACY_LIBRARY_ENTRIES ||
    !Array.isArray(value.legacyJobs) ||
    value.legacyJobs.length > MAX_LEGACY_IMPORT_JOBS
  ) {
    throw new Error("Invalid SQLite cutover marker: malformed repair inventory");
  }
  const digest = createHash("sha256")
    .update(
      `${JSON.stringify(value.legacySidecars)}\n${JSON.stringify(value.legacyJobs)}`,
    )
    .digest("hex");
  if (value.snapshotDigest !== digest) {
    throw new Error("Invalid SQLite cutover marker: snapshot digest mismatch");
  }
  return value.legacySidecars.map((entry) => {
    const item = objectValue(entry);
    const archivePath = nonEmptyString(item?.archivePath);
    const fingerprint = nonEmptyString(item?.fingerprint);
    const sidecarPath = nonEmptyString(item?.sidecarPath);
    if (
      !archivePath ||
      !isAbsolute(archivePath) ||
      !isPathWithinDirectory(libraryPath, normalize(archivePath)) ||
      !fingerprint ||
      fingerprint.includes("\0") ||
      !sidecarPath ||
      !isAbsolute(sidecarPath) ||
      !isPathWithinDirectory(libraryPath, normalize(sidecarPath))
    ) {
      throw new Error(
        "Invalid SQLite cutover marker: malformed repair archive inventory",
      );
    }
    return { archivePath, fingerprint, sidecarPath };
  });
}

export function reconcileLegacyRepairCutover(
  sqlite: DatabaseSync,
  originalsLibraryPath: string,
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock,
): void {
  const inventory = readLegacyRepairArchiveInventory(originalsLibraryPath);
  if (inventory.length === 0) {
    return;
  }
  const libraryPath = realpathSync(originalsLibraryPath);
  const inventoryIdentities = new Set(
    inventory.flatMap(({ archivePath, fingerprint }) => [
      `archive:${archivePath}`,
      `fingerprint:${fingerprint}`,
    ]),
  );
  const activePublicationMutations = sqlite.prepare(`
    SELECT encode_jobs.id,
           encode_jobs.output_path AS outputPath,
           encode_jobs.claim_token AS claimToken,
           encode_jobs.partial_cleanup_lease_token AS leaseToken,
           encode_jobs.updated_at AS updatedAt,
           original_disc_archives.archive_path AS archivePath,
           original_disc_archives.fingerprint,
           original_disc_archives.legacy_cutover_pending AS legacyCutoverPending
    FROM encode_jobs
    INNER JOIN disc_selections
      ON disc_selections.id = encode_jobs.disc_selection_id
    INNER JOIN original_disc_archives
      ON original_disc_archives.id = disc_selections.original_disc_archive_id
    WHERE encode_jobs.status = 'running'
      AND encode_jobs.partial_cleanup_lease_token IS NOT NULL
  `).all() as unknown as ActivePublicationMutationRow[];
  const relatedPublicationMutations = activePublicationMutations.filter(
    (mutation) =>
      mutation.legacyCutoverPending === 1 ||
      inventoryIdentities.has(`archive:${mutation.archivePath}`) ||
      inventoryIdentities.has(`fingerprint:${mutation.fingerprint}`),
  );
  const expiredBefore = Date.now() - ENCODE_JOB_LEASE_DURATION_MS;
  const authorizedMutations = new Map(
    relatedPublicationMutations.map((mutation) => [mutation.id, mutation]),
  );
  const acquiredLocks = new Map<
    string,
    PublicationMutationRecoveryLockHandle
  >();
  try {
    for (const mutation of relatedPublicationMutations) {
      if (
        mutation.updatedAt > expiredBefore ||
        publicationMutationRecoveryLock === undefined
      ) {
        throw new Error(
          "Legacy cutover is blocked by an active Encode publication mutation",
        );
      }
      if (!acquiredLocks.has(mutation.outputPath)) {
        const handle = publicationMutationRecoveryLock.tryAcquire(
          mutation.outputPath,
        );
        if (handle === null) {
          throw new Error(
            "Legacy cutover is blocked by an active Encode publication mutation",
          );
        }
        acquiredLocks.set(mutation.outputPath, handle);
      }
    }

    sqlite.exec("BEGIN IMMEDIATE");
    try {
    const stagedSidecars = sqlite.prepare(`
      SELECT sidecar_path AS sidecarPath,
             archive_path AS archivePath,
             fingerprint
      FROM legacy_cutover_staged_sidecars
      WHERE originals_library_path = ?
      LIMIT ${MAX_LEGACY_LIBRARY_ENTRIES + 1}
    `).all(libraryPath) as unknown as LegacyRepairArchiveIdentity[];
    if (stagedSidecars.length > MAX_LEGACY_LIBRARY_ENTRIES) {
      throw new Error(
        `Legacy cutover staged inventory exceeds the ${MAX_LEGACY_LIBRARY_ENTRIES}-entry limit`,
      );
    }
    const stagedSidecarsByPath = new Map(
      stagedSidecars.map((entry) => [entry.sidecarPath, entry]),
    );
    const markerSidecarsByPath = new Map<string, LegacyRepairArchiveIdentity>();
    for (const identity of inventory) {
      const markerIdentity = markerSidecarsByPath.get(identity.sidecarPath);
      const stagedIdentity = stagedSidecarsByPath.get(identity.sidecarPath);
      if (
        (markerIdentity !== undefined &&
          (markerIdentity.archivePath !== identity.archivePath ||
            markerIdentity.fingerprint !== identity.fingerprint)) ||
        (stagedIdentity !== undefined &&
          (stagedIdentity.archivePath !== identity.archivePath ||
            stagedIdentity.fingerprint !== identity.fingerprint))
      ) {
        throw new Error(
          "Legacy cutover repair inventory conflicts with durable staging",
        );
      }
      markerSidecarsByPath.set(identity.sidecarPath, identity);
    }
    const newlyStagedSidecarPaths = [...markerSidecarsByPath.keys()].filter(
      (sidecarPath) => !stagedSidecarsByPath.has(sidecarPath),
    );
    if (
      stagedSidecarsByPath.size + newlyStagedSidecarPaths.length >
      MAX_LEGACY_LIBRARY_ENTRIES
    ) {
      throw new Error(
        `Legacy cutover staged inventory exceeds the ${MAX_LEGACY_LIBRARY_ENTRIES}-entry limit`,
      );
    }
    const stageIdentity = sqlite.prepare(`
      INSERT INTO legacy_cutover_staged_sidecars (
        originals_library_path,
        sidecar_path,
        archive_path,
        fingerprint
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (originals_library_path, sidecar_path) DO NOTHING
    `);
    const timestamp = Date.now();
    const fenceArchive = sqlite.prepare(`
      UPDATE original_disc_archives
      SET catalog_reviewed_at = NULL,
          legacy_cutover_pending = true,
          updated_at = max(updated_at + 1, ?)
      WHERE fingerprint = ? OR archive_path = ?
    `);
    for (const identity of inventory) {
      stageIdentity.run(
        libraryPath,
        identity.sidecarPath,
        identity.archivePath,
        identity.fingerprint,
      );
      fenceArchive.run(
        timestamp,
        identity.fingerprint,
        identity.archivePath,
      );
    }
    const currentPublicationMutations = sqlite.prepare(`
      SELECT encode_jobs.id,
             encode_jobs.output_path AS outputPath,
             encode_jobs.claim_token AS claimToken,
             encode_jobs.partial_cleanup_lease_token AS leaseToken,
             encode_jobs.updated_at AS updatedAt,
             original_disc_archives.archive_path AS archivePath,
             original_disc_archives.fingerprint,
             original_disc_archives.legacy_cutover_pending AS legacyCutoverPending
      FROM encode_jobs
      INNER JOIN disc_selections
        ON disc_selections.id = encode_jobs.disc_selection_id
      INNER JOIN original_disc_archives
        ON original_disc_archives.id = disc_selections.original_disc_archive_id
      WHERE original_disc_archives.legacy_cutover_pending = true
        AND encode_jobs.status = 'running'
        AND encode_jobs.partial_cleanup_lease_token IS NOT NULL
    `).all() as unknown as ActivePublicationMutationRow[];
    for (const mutation of currentPublicationMutations) {
      const authorized = authorizedMutations.get(mutation.id);
      if (
        authorized === undefined ||
        authorized.outputPath !== mutation.outputPath ||
        authorized.claimToken !== mutation.claimToken ||
        authorized.leaseToken !== mutation.leaseToken ||
        mutation.updatedAt > expiredBefore ||
        !acquiredLocks.has(mutation.outputPath)
      ) {
        throw new Error(
          "Legacy cutover is blocked by an active Encode publication mutation",
        );
      }
    }
    sqlite.prepare(`
      UPDATE encode_jobs
      SET partial_cleanup_output_path = output_path,
          partial_cleanup_claim_token = claim_token,
          partial_cleanup_lease_token = NULL,
          publication_pending = 0,
          publication_completion_pending = 0,
          status = 'failed',
          completed_at = NULL,
          error_message = 'Encode Job invalidated by legacy catalog cutover repair',
          updated_at = max(updated_at + 1, ?)
      WHERE status = 'running'
        AND EXISTS (
          SELECT 1
          FROM disc_selections
          INNER JOIN original_disc_archives
            ON original_disc_archives.id = disc_selections.original_disc_archive_id
          WHERE disc_selections.id = encode_jobs.disc_selection_id
            AND original_disc_archives.legacy_cutover_pending = true
        )
    `).run(timestamp);
    sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  } finally {
    for (const handle of [...acquiredLocks.values()].reverse()) {
      handle.release();
    }
  }
}
