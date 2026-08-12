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

interface LegacyRepairMarkerSnapshot {
  identityDigest: string;
  inventory: LegacyRepairArchiveIdentity[];
  libraryPath: string;
}

interface MarkerFileVersion {
  changedAtNanoseconds: string;
  deviceId: string;
  inode: string;
  modifiedAtNanoseconds: string;
  sizeBytes: string;
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

function markerFileVersion(stat: {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}): MarkerFileVersion {
  return {
    changedAtNanoseconds: stat.ctimeNs.toString(),
    deviceId: stat.dev.toString(),
    inode: stat.ino.toString(),
    modifiedAtNanoseconds: stat.mtimeNs.toString(),
    sizeBytes: stat.size.toString(),
  };
}

function sameMarkerFileVersion(
  left: MarkerFileVersion,
  right: MarkerFileVersion,
): boolean {
  return (
    left.changedAtNanoseconds === right.changedAtNanoseconds &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.sizeBytes === right.sizeBytes
  );
}

function readBoundedMarker(markerPath: string): {
  identityDigest: string;
  value: unknown;
} {
  const namedStatBefore = lstatSync(markerPath, { bigint: true });
  if (!namedStatBefore.isFile() || namedStatBefore.isSymbolicLink()) {
    throw new Error("SQLite cutover marker must be a regular file");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(markerPath, "r");
    const openedStatBefore = fstatSync(descriptor, { bigint: true });
    const namedVersionBefore = markerFileVersion(namedStatBefore);
    const openedVersionBefore = markerFileVersion(openedStatBefore);
    if (
      !openedStatBefore.isFile() ||
      !sameMarkerFileVersion(namedVersionBefore, openedVersionBefore)
    ) {
      throw new Error("SQLite cutover marker must be a regular file");
    }
    if (openedStatBefore.size > BigInt(MAX_LEGACY_MARKER_BYTES)) {
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
    const openedVersionAfter = markerFileVersion(
      fstatSync(descriptor, { bigint: true }),
    );
    const namedStatAfter = lstatSync(markerPath, { bigint: true });
    if (
      !namedStatAfter.isFile() ||
      namedStatAfter.isSymbolicLink() ||
      !sameMarkerFileVersion(openedVersionBefore, openedVersionAfter) ||
      !sameMarkerFileVersion(
        openedVersionAfter,
        markerFileVersion(namedStatAfter),
      )
    ) {
      throw new Error("SQLite cutover marker changed while it was being read");
    }
    const bytes = buffer.subarray(0, bytesRead);
    return {
      identityDigest: createHash("sha256")
        .update(JSON.stringify(openedVersionAfter))
        .update("\n")
        .update(bytes)
        .digest("hex"),
      value: JSON.parse(UTF8_DECODER.decode(bytes)),
    };
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

function readLegacyRepairMarkerSnapshot(
  originalsLibraryPath: string,
): LegacyRepairMarkerSnapshot | null {
  const libraryPath = realpathSync(originalsLibraryPath);
  if (!statSync(libraryPath).isDirectory()) {
    throw new Error(`Originals library is not a directory: ${libraryPath}`);
  }
  const markerPath = join(libraryPath, LEGACY_QUEUE_CUTOVER_MARKER);
  if (!existsSync(markerPath)) {
    return null;
  }
  const markerSnapshot = readBoundedMarker(markerPath);
  const value = objectValue(markerSnapshot.value);
  if (
    value?.schemaVersion !== 4 ||
    value.authoritativeStore !== "sqlite" ||
    value.legacyQueueStatus !== "repair"
  ) {
    return null;
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
  const inventory = value.legacySidecars.map((entry) => {
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
  return {
    identityDigest: markerSnapshot.identityDigest,
    inventory,
    libraryPath,
  };
}

export function reconcileLegacyRepairCutover(
  sqlite: DatabaseSync,
  originalsLibraryPath: string,
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock,
): void {
  const markerSnapshot = readLegacyRepairMarkerSnapshot(
    originalsLibraryPath,
  );
  if (markerSnapshot === null || markerSnapshot.inventory.length === 0) {
    return;
  }
  const { inventory, libraryPath } = markerSnapshot;
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

    const currentMarkerSnapshot = readLegacyRepairMarkerSnapshot(
      originalsLibraryPath,
    );
    if (
      currentMarkerSnapshot === null ||
      currentMarkerSnapshot.libraryPath !== markerSnapshot.libraryPath ||
      currentMarkerSnapshot.identityDigest !== markerSnapshot.identityDigest
    ) {
      throw new Error(
        "Legacy repair marker changed while it was being reconciled",
      );
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
          catalog_review_outcome = 'needs_review',
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
