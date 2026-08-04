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

import { isPathWithinDirectory } from "./path-containment.js";

const LEGACY_QUEUE_CUTOVER_MARKER = ".rip-dvd-sqlite-catalog";
const MAX_LEGACY_MARKER_BYTES = 8_388_608;
const MAX_LEGACY_LIBRARY_ENTRIES = 10_000;
const MAX_LEGACY_IMPORT_JOBS = 1_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface LegacyRepairArchiveIdentity {
  archivePath: string;
  fingerprint: string;
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
    return { archivePath, fingerprint };
  });
}

export function reconcileLegacyRepairCutover(
  sqlite: DatabaseSync,
  originalsLibraryPath: string,
): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const inventory = readLegacyRepairArchiveInventory(originalsLibraryPath);
    if (inventory.length === 0) {
      sqlite.exec("COMMIT");
      return;
    }
    const timestamp = Date.now();
    const fenceArchive = sqlite.prepare(`
      UPDATE original_disc_archives
      SET catalog_reviewed_at = NULL,
          legacy_cutover_pending = true,
          updated_at = max(updated_at + 1, ?)
      WHERE fingerprint = ? OR archive_path = ?
    `);
    for (const identity of inventory) {
      fenceArchive.run(
        timestamp,
        identity.fingerprint,
        identity.archivePath,
      );
    }
    sqlite.prepare(`
      UPDATE encode_jobs
      SET status = 'failed',
          completed_at = NULL,
          error_message = 'Encode Job invalidated by legacy catalog cutover repair',
          updated_at = max(updated_at + 1, ?)
      WHERE (status = 'running' OR (status = 'completed' AND claim_token IS NOT NULL))
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
}
