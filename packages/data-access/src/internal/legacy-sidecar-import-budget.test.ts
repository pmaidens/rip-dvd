import { describe, expect, it } from "vitest";

import type {
  LegacySidecarDiscovery,
  ParsedLegacyJob,
} from "./legacy-sidecars.js";
import {
  createLegacySidecarImportBudgetAccumulator,
} from "./legacy-sidecar-import-budget.js";

function parsedDiscovery(
  sourceBytes: number,
  jobCount: number,
): LegacySidecarDiscovery {
  const jobs: ParsedLegacyJob[] = Array.from(
    { length: jobCount },
    (_, jobIndex) => ({
      completedAt: null,
      jobIndex,
      kind: "dvd_title",
      label: `Job ${jobIndex}`,
      mediaItemKind: "bonus_feature",
      mediaTitle: `Job ${jobIndex}`,
      outputPath: `/movies/job-${jobIndex}.mkv`,
      preset: "Fast 480p30",
      profileKey: "Fast 480p30",
      sourceKey: "archive.iso",
      titleNumber: jobIndex + 1,
    }),
  );
  return {
    outcome: "parsed",
    sidecar: {
      archivedAt: new Date(0),
      archivePath: "/originals/archive.iso",
      archiveSizeBytes: 1,
      archiveSnapshot: {
        changedAtNanoseconds: "0",
        deviceId: "1",
        inode: "1",
        modifiedAtNanoseconds: "0",
        sizeBytes: "1",
      },
      createdAt: new Date(0),
      fingerprint: "fingerprint",
      issues: [],
      jobs,
      movieTitle: "Movie",
      movieYear: null,
      pathBase: "/originals",
      scanData: {},
      sidecarPath: "/originals/archive.rip-dvd.json",
      sourceBytes,
      updatedAt: new Date(0),
    },
  };
}

function skippedDiscovery(sourceBytes: number): LegacySidecarDiscovery {
  return {
    outcome: "skipped",
    issue: {
      code: "corrupt_sidecar",
      message: "Corrupt sidecar",
      sidecarPath: "/originals/archive.rip-dvd.json",
    },
    sourceBytes,
  };
}

describe("legacy sidecar import budget", () => {
  it.each([
    {
      discovery: skippedDiscovery(1_000_000),
      expectedBound: "scan-bytes",
      records: 68,
    },
    {
      discovery: parsedDiscovery(1_000_000, 0),
      expectedBound: "retained-bytes",
      records: 9,
    },
    {
      discovery: parsedDiscovery(1, 100),
      expectedBound: "jobs",
      records: 11,
    },
  ] as const)(
    "identifies the exceeded $expectedBound bound",
    ({ discovery, expectedBound, records }) => {
      const budget = createLegacySidecarImportBudgetAccumulator();

      for (let index = 1; index < records; index += 1) {
        expect(budget.record(discovery)).toBeNull();
      }

      expect(budget.record(discovery)).toBe(expectedBound);
    },
  );
});
