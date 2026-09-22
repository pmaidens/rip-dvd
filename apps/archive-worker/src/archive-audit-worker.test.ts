import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DetectedDiscId,
  DiscInspectionId,
  OpticalDriveId,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import type { ArchiveAuditRecord } from "@rip-dvd/data-access/archive-audit-records";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { expect, it } from "vitest";

import { pollArchiveAudit } from "./archive-audit-worker.js";

function auditRecord(id: string): ArchiveAuditRecord {
  return {
    archiveId: `archive-${id}` as OriginalDiscArchiveId,
    detectedDiscId: `disc-${id}` as DetectedDiscId,
    opticalDriveId: "synthetic-drive" as OpticalDriveId,
    discInspectionId: `inspection-${id}` as DiscInspectionId,
    mediaGeneration: `generation-${id}`,
    discInspectionCapacityBytes: 2_048,
    archivePath: `/synthetic/${id}.iso`,
    archivePathRejected: false,
    recordedSizeBytes: null,
    reportedBoundarySizeBytes: null,
    publishedBoundarySizeBytes: null,
    boundaryExcludedSectorCount: null,
    archivedAt: new Date("2026-09-22T12:00:00.000Z"),
  };
}

it("retains partial findings and marks a bounded runtime result incomplete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-audit-worker-"));
  const databasePath = join(directory, "catalog.sqlite");
  const access = createLegacySidecarDataAccess({
    databasePath,
    mediaLibraryPath: directory,
    originalsLibraryPath: directory,
  });
  try {
    const submitted = access.archiveAudits.submit({
      mutationKey: "synthetic-partial-archive-audit",
      bounds: {
        recordLimit: 3,
        concurrency: 1,
        fileTimeoutMs: 5_000,
        runtimeTimeoutMs: 25,
      },
    });
    let inspection = 0;

    expect(await pollArchiveAudit({
      access,
      databasePath,
      originalsLibraryPath: directory,
      dependencies: {
        readRecords: async () => ({
          records: [auditRecord("one"), auditRecord("two"), auditRecord("three")],
          truncated: true,
        }),
        createFileInspector: () => ({
          inspect(_path, _root, signal) {
            inspection += 1;
            if (inspection <= 2) {
              return Promise.resolve({
                actualSizeBytes: 2_048,
                geometry: {
                  imageSectorCount: 1,
                  isoVolumeSectorCount: null,
                  udfMaximumDeclaredSectorCount: null,
                },
                outcome: "ok" as const,
              });
            }
            return new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
      },
    })).toBe(true);

    expect(access.archiveAudits.find(submitted.id)).toMatchObject({
      status: "completed",
      progressPhase: "completed",
      recordCount: 3,
      recordsProcessed: 2,
      truncated: true,
      resultStatus: "incomplete",
      incompleteReason: "runtime_timeout",
      findings: [
        {
          archiveId: "archive-one",
          classification: "suspicious_capacity_reuse",
          reason: "distinct_media_generations_reused_exact_capacity",
        },
        {
          archiveId: "archive-two",
          classification: "suspicious_capacity_reuse",
          reason: "distinct_media_generations_reused_exact_capacity",
        },
      ],
    });
  } finally {
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("settles a runtime timeout while bounded records are still loading", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-audit-worker-"));
  const databasePath = join(directory, "catalog.sqlite");
  const access = createLegacySidecarDataAccess({
    databasePath,
    mediaLibraryPath: directory,
    originalsLibraryPath: directory,
  });
  try {
    const submitted = access.archiveAudits.submit({
      mutationKey: "synthetic-record-loading-timeout",
      bounds: {
        recordLimit: 1,
        concurrency: 1,
        fileTimeoutMs: 5_000,
        runtimeTimeoutMs: 25,
      },
    });

    expect(await pollArchiveAudit({
      access,
      databasePath,
      originalsLibraryPath: directory,
      dependencies: {
        readRecords: async (_path, _limit, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }),
        createFileInspector: () => {
          throw new Error("file inspection should not begin");
        },
      },
    })).toBe(true);

    expect(access.archiveAudits.find(submitted.id)).toMatchObject({
      status: "completed",
      progressPhase: "completed",
      recordCount: null,
      recordsProcessed: 0,
      truncated: null,
      resultStatus: "incomplete",
      incompleteReason: "runtime_timeout",
      findings: [],
    });
  } finally {
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
