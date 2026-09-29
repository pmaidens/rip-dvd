import { describe, expect, it } from "vitest";

import {
  createIncompleteReadArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
} from "./archive-integrity.js";

describe("Archive Integrity evidence", () => {
  it("creates a compatible projection for versioned incomplete-read evidence", () => {
    expect(createIncompleteReadArchiveIntegrityEvidence([
      { startLba: 12, sectorCount: 4 },
      { startLba: 20, sectorCount: 2 },
    ])).toEqual({
      integrity: "incomplete_read",
      policyVersion: "dvd-recovery-evidence-v1",
      badSectorCount: 6,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 12, sectorCount: 4 },
        { startLba: 20, sectorCount: 2 },
      ],
    });
  });

  it.each([
    { ranges: [] },
    { ranges: [{ startLba: -1, sectorCount: 1 }] },
    { ranges: [{ startLba: 1, sectorCount: 0 }] },
    { ranges: [
      { startLba: 2, sectorCount: 2 },
      { startLba: 3, sectorCount: 1 },
    ] },
  ])("rejects invalid incomplete-read ranges", ({ ranges }) => {
    expect(() => createIncompleteReadArchiveIntegrityEvidence(ranges))
      .toThrow();
  });

  it("normalizes bounded isolated-sector evidence for watchable salvage", () => {
    expect(createWatchableSalvageArchiveIntegrityEvidence(
      " dvd-watchable-salvage-v2 ",
      [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      [
        { titleNumber: 2, badSectorCount: 1 },
        { titleNumber: 5, badSectorCount: 2 },
      ],
    )).toEqual({
      integrity: "watchable_salvage",
      policyVersion: "dvd-watchable-salvage-v2",
      badSectorCount: 2,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      badSectorCountsByTitle: [
        { titleNumber: 2, badSectorCount: 1 },
        { titleNumber: 5, badSectorCount: 2 },
      ],
    });
  });

  it.each([
    ["policy bound", [{ startLba: 1, sectorCount: 2 }]],
    ["normalized shape", [
      { startLba: 1, sectorCount: 1 },
      { startLba: 2, sectorCount: 1 },
    ]],
    ["policy count bound", Array.from({ length: 33 }, (_, index) => ({
      startLba: index * 2,
      sectorCount: 1,
    }))],
  ] as const)("rejects evidence outside the watchability %s", (
    _description,
    ranges,
  ) => {
    expect(() => createWatchableSalvageArchiveIntegrityEvidence(
      "dvd-unused-space-v1",
      ranges,
      [],
    )).toThrow();
  });

  it.each([
    ["per-title policy bound", [{ titleNumber: 1, badSectorCount: 17 }]],
    ["ascending title order", [
      { titleNumber: 2, badSectorCount: 1 },
      { titleNumber: 1, badSectorCount: 1 },
    ]],
    ["positive title number", [{ titleNumber: 0, badSectorCount: 1 }]],
    ["disc evidence consistency", [{ titleNumber: 1, badSectorCount: 3 }]],
  ] as const)("rejects invalid %s evidence", (_description, titleCounts) => {
    expect(() => createWatchableSalvageArchiveIntegrityEvidence(
      "dvd-watchable-salvage-v2",
      [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      titleCounts,
    )).toThrow();
  });
});
