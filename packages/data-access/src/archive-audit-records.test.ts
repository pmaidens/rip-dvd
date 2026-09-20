import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { readArchiveAuditRecords } from "./archive-audit-records.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createAuditDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-audit-records-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "catalog.sqlite");
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec(`
    pragma user_version = 17;
    create table optical_drives (id text primary key);
    create table detected_discs (
      id text primary key,
      optical_drive_id text not null
    );
    create table disc_inspections (
      id text primary key,
      media_generation text not null,
      media_capacity_bytes integer
    );
    create table original_disc_archives (
      id text primary key,
      detected_disc_id text not null,
      disc_kind text not null,
      archive_format text not null,
      archive_path text not null,
      size_bytes integer,
      boundary_reported_size_bytes integer,
      boundary_published_size_bytes integer,
      boundary_excluded_sector_count integer,
      archived_at integer not null
    );
    create table archive_jobs (
      id text primary key,
      original_disc_archive_id text,
      disc_inspection_id text,
      status text not null,
      completed_at integer
    );
    insert into optical_drives values ('drive-1'), ('drive-2');
    insert into detected_discs values
      ('disc-1', 'drive-1'),
      ('disc-2', 'drive-2'),
      ('disc-cd', 'drive-1');
    insert into disc_inspections values
      ('inspection-old', 'generation-old', 1000),
      ('inspection-1', 'generation-1', 1228800),
      ('inspection-2', 'generation-2', 1228800);
    insert into original_disc_archives values
      ('archive-1', 'disc-1', 'dvd', 'iso', '/archives/one.iso',
       1228800, 1228800, 1228800, 0, 1000),
      ('archive-2', 'disc-2', 'dvd', 'iso', '/archives/two.iso',
       1228800, 1228800, 1228800, 0, 2000),
      ('archive-cd', 'disc-cd', 'cd', 'bin_cue', '/archives/cd.bin',
       1000, null, null, null, 3000);
    insert into archive_jobs values
      ('job-old', 'archive-1', 'inspection-old', 'completed', 900),
      ('job-1', 'archive-1', 'inspection-1', 'completed', 1100),
      ('job-2', 'archive-2', 'inspection-2', 'completed', 2100);
  `);
  sqlite.close();
  return databasePath;
}

describe("read-only archive audit records", () => {
  it("returns a bounded chronological DVD projection and exact publication inspection", () => {
    const databasePath = createAuditDatabase();

    const firstPage = readArchiveAuditRecords(databasePath, 1);
    const allRecords = readArchiveAuditRecords(databasePath, 10);

    expect(firstPage).toMatchObject({
      truncated: true,
      records: [{
        archiveId: "archive-1",
        detectedDiscId: "disc-1",
        opticalDriveId: "drive-1",
        discInspectionId: "inspection-1",
        mediaGeneration: "generation-1",
        discInspectionCapacityBytes: 1_228_800,
        archivePath: "/archives/one.iso",
        archivePathRejected: false,
        recordedSizeBytes: 1_228_800,
        reportedBoundarySizeBytes: 1_228_800,
        publishedBoundarySizeBytes: 1_228_800,
        boundaryExcludedSectorCount: 0,
        archivedAt: new Date(1_000),
      }],
    });
    expect(allRecords.records.map(({ archiveId }) => archiveId)).toEqual([
      "archive-1",
      "archive-2",
    ]);
    expect(allRecords.truncated).toBe(false);

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    expect(verification.prepare("pragma user_version").get()).toEqual({
      user_version: 17,
    });
    verification.close();
  });

  it("rejects unbounded requests and contains oversized paths", () => {
    const databasePath = createAuditDatabase();
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update original_disc_archives
      set archive_path = ?
      where id = 'archive-1'
    `).run(`/archives/${"x".repeat(4_096)}.iso`);
    sqlite.close();

    expect(() => readArchiveAuditRecords(databasePath, 1_001)).toThrow(
      "Archive audit limit must be between 1 and 1000",
    );
    expect(readArchiveAuditRecords(databasePath, 1).records[0]).toMatchObject({
      archivePath: null,
      archivePathRejected: true,
    });
  });
});
