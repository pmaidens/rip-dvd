import type { ArchiveAuditRecord } from "@rip-dvd/data-access/archive-audit-records";
import type {
  DetectedDiscId,
  DiscInspectionId,
  OpticalDriveId,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { describe, expect, it } from "vitest";

import {
  type ArchiveAuditFileInspection,
  type ArchiveAuditFileInspector,
  runArchiveAudit,
} from "./archive-audit.js";

const IMAGE_BYTES = 600 * 2_048;

const archiveId = (value: string) => value as OriginalDiscArchiveId;
const detectedDiscId = (value: string) => value as DetectedDiscId;
const discInspectionId = (value: string) => value as DiscInspectionId;
const opticalDriveId = (value: string) => value as OpticalDriveId;

function auditRecord(
  id: string,
  overrides: Partial<ArchiveAuditRecord> = {},
): ArchiveAuditRecord {
  return {
    archiveId: archiveId(`archive-${id}`),
    detectedDiscId: detectedDiscId(`disc-${id}`),
    opticalDriveId: opticalDriveId(`drive-${id}`),
    discInspectionId: discInspectionId(`inspection-${id}`),
    mediaGeneration: `generation-${id}`,
    discInspectionCapacityBytes: IMAGE_BYTES,
    archivePath: `/archives/${id}.iso`,
    archivePathRejected: false,
    recordedSizeBytes: IMAGE_BYTES,
    reportedBoundarySizeBytes: IMAGE_BYTES,
    publishedBoundarySizeBytes: IMAGE_BYTES,
    boundaryExcludedSectorCount: 0,
    archivedAt: new Date(`2026-09-${String(Number(id) + 1).padStart(2, "0")}T12:00:00.000Z`),
    ...overrides,
  };
}

function successfulInspection(
  actualSizeBytes = IMAGE_BYTES,
): ArchiveAuditFileInspection {
  return {
    actualSizeBytes,
    geometry: {
      imageSectorCount: actualSizeBytes / 2_048,
      isoVolumeSectorCount: actualSizeBytes / 2_048,
      udfMaximumDeclaredSectorCount: null,
    },
    outcome: "ok",
  };
}

describe("Original Disc Archive audit", () => {
  it("classifies bounded deterministic fixtures without exposing paths", async () => {
    const records = [
      auditRecord("1", {
        opticalDriveId: opticalDriveId("drive-cluster"),
        mediaGeneration: "generation-prior",
      }),
      auditRecord("2", {
        opticalDriveId: opticalDriveId("drive-cluster"),
        mediaGeneration: "generation-current",
      }),
      auditRecord("3", { opticalDriveId: opticalDriveId("drive-legitimate-a") }),
      auditRecord("4", { opticalDriveId: opticalDriveId("drive-legitimate-b") }),
      auditRecord("5"),
      auditRecord("6"),
      auditRecord("7"),
      auditRecord("8", {
        archivePath: null,
        archivePathRejected: true,
      }),
      auditRecord("9", { recordedSizeBytes: IMAGE_BYTES - 2_048 }),
    ];
    const inspections = new Map<string, ArchiveAuditFileInspection>([
      ["/archives/1.iso", successfulInspection()],
      ["/archives/2.iso", {
        actualSizeBytes: IMAGE_BYTES,
        geometry: {
          imageSectorCount: 600,
          isoVolumeSectorCount: 601,
          udfMaximumDeclaredSectorCount: null,
        },
        outcome: "definite_truncation",
      }],
      ["/archives/3.iso", successfulInspection()],
      ["/archives/4.iso", successfulInspection()],
      ["/archives/5.iso", {
        actualSizeBytes: null,
        geometry: null,
        outcome: "missing_file",
      }],
      ["/archives/6.iso", {
        actualSizeBytes: IMAGE_BYTES,
        geometry: null,
        outcome: "malformed_metadata",
      }],
      ["/archives/7.iso", {
        actualSizeBytes: IMAGE_BYTES,
        geometry: null,
        outcome: "unsupported_layout",
      }],
      ["/archives/9.iso", successfulInspection()],
    ]);
    let active = 0;
    let maximumActive = 0;
    const inspectedPaths: string[] = [];
    const fileInspector: ArchiveAuditFileInspector = {
      async inspect(path) {
        inspectedPaths.push(path);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return inspections.get(path)!;
      },
    };
    const clock = [
      new Date("2026-09-19T12:00:00.000Z"),
      new Date("2026-09-19T12:00:01.000Z"),
    ];

    const report = await runArchiveAudit({
      records,
      recordsTruncated: true,
      recordLimit: 9,
      concurrency: 2,
      fileTimeoutMs: 5_000,
      runtimeTimeoutMs: 120_000,
      originalsLibraryPath: "/archives",
      fileInspector,
      signal: new AbortController().signal,
      now: () => clock.shift()!,
    });

    expect(maximumActive).toBe(2);
    expect(inspectedPaths).not.toContain(null);
    expect(report).toMatchObject({
      schemaVersion: 1,
      commandVersion: "archive-audit-v1",
      startedAt: "2026-09-19T12:00:00.000Z",
      completedAt: "2026-09-19T12:00:01.000Z",
      scope: {
        recordLimit: 9,
        concurrency: 2,
        fileTimeoutMs: 5_000,
        runtimeTimeoutMs: 120_000,
        truncated: true,
      },
      counts: {
        suspicious_capacity_reuse: 1,
        definite_truncation: 1,
        consistent: 2,
        missing_file: 1,
        malformed_metadata: 1,
        unsupported_layout: 1,
        containment_rejection: 1,
        size_mismatch: 1,
        suspiciousCapacityReuseSignals: 2,
      },
    });
    expect(report.findings.map(({ classification }) => classification)).toEqual([
      "suspicious_capacity_reuse",
      "definite_truncation",
      "consistent",
      "consistent",
      "missing_file",
      "malformed_metadata",
      "unsupported_layout",
      "containment_rejection",
      "size_mismatch",
    ]);
    expect(report.findings[0]!.capacityReuse).toEqual({
      classification: "suspicious_capacity_reuse",
      capacityBytes: IMAGE_BYTES,
      archiveCount: 2,
      mediaGenerationCount: 2,
      reason: "distinct_media_generations_reused_exact_capacity",
    });
    expect(report.findings[1]).toMatchObject({
      actualSizeBytes: IMAGE_BYTES,
      declaredGeometry: {
        isoVolumeSizeBytes: 601 * 2_048,
        udfMaximumDeclaredSizeBytes: null,
        maximumDeclaredSizeBytes: 601 * 2_048,
      },
      classification: "definite_truncation",
      reason: "declared_geometry_extends_beyond_eof",
    });
    expect(JSON.stringify(report)).not.toContain("/archives/");
    expect(inspectedPaths).toHaveLength(8);
  });

  it("does not treat equal sizes without same-drive generation reuse as suspicious", async () => {
    const report = await runArchiveAudit({
      records: [
        auditRecord("1", { opticalDriveId: opticalDriveId("drive-a") }),
        auditRecord("2", { opticalDriveId: opticalDriveId("drive-b") }),
      ],
      recordsTruncated: false,
      recordLimit: 2,
      concurrency: 1,
      fileTimeoutMs: 5_000,
      runtimeTimeoutMs: 120_000,
      originalsLibraryPath: "/archives",
      fileInspector: { inspect: async () => successfulInspection() },
      signal: new AbortController().signal,
    });

    expect(report.findings.map(({ classification }) => classification)).toEqual([
      "consistent",
      "consistent",
    ]);
    expect(report.counts.suspiciousCapacityReuseSignals).toBe(0);
  });

  it("compares reported boundaries while accepting proven excluded tails", async () => {
    const report = await runArchiveAudit({
      records: [
        auditRecord("1", {
          reportedBoundarySizeBytes: IMAGE_BYTES - 2_048,
        }),
        auditRecord("2", {
          reportedBoundarySizeBytes: IMAGE_BYTES + 2_048,
          boundaryExcludedSectorCount: 1,
        }),
      ],
      recordsTruncated: false,
      recordLimit: 2,
      concurrency: 1,
      fileTimeoutMs: 5_000,
      runtimeTimeoutMs: 120_000,
      originalsLibraryPath: "/archives",
      fileInspector: { inspect: async () => successfulInspection() },
      signal: new AbortController().signal,
    });

    expect(report.findings.map(({ classification }) => classification)).toEqual([
      "size_mismatch",
      "consistent",
    ]);
  });
});
