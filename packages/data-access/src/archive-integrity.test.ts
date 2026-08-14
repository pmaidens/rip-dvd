import { describe, expect, it } from "vitest";

import { createWatchableSalvageArchiveIntegrityEvidence } from "./archive-integrity.js";

describe("Archive Integrity evidence", () => {
  it("normalizes bounded isolated-sector evidence for watchable salvage", () => {
    expect(createWatchableSalvageArchiveIntegrityEvidence(
      " dvd-unused-space-v1 ",
      [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
    )).toEqual({
      integrity: "watchable_salvage",
      policyVersion: "dvd-unused-space-v1",
      badSectorCount: 2,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
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
    )).toThrow();
  });
});
