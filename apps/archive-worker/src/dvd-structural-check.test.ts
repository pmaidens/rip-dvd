import type { OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import type {
  DvdFullExtentMetadataDecision,
} from "./dvd-full-extent-validator.js";
import { createNodeDvdStructuralChecker } from "./dvd-structural-check.js";

const checkpoint = {
  originalDiscArchiveId: "synthetic-archive" as OriginalDiscArchiveId,
  manifestId: "synthetic-manifest",
  manifestRevision: 1,
  manifestDigest: "a".repeat(64),
  acceptedEndLbaExclusive: 64,
};

function checkerFor(decision: DvdFullExtentMetadataDecision) {
  return createNodeDvdStructuralChecker({
    metadataValidator: {
      async validate() {
        return decision;
      },
    },
  });
}

async function check(decision: DvdFullExtentMetadataDecision) {
  const assertStable = vi.fn();
  const findings = await checkerFor(decision).check({
    checkpoint,
    descriptor: 17,
    imageFilesystemIdentity: "1:2",
    imagePath: "/synthetic/archive.iso",
    unrecoveredSourceRanges: [],
    signal: new AbortController().signal,
    assertStable,
  });
  expect(assertStable).toHaveBeenCalledTimes(2);
  return findings;
}

describe("node DVD structural checker", () => {
  it("reports valid only when the complete structural profile is proved", async () => {
    const findings = await check({
      policyVersion: "dvd-full-extent-metadata-v1",
      decision: "publishable",
      impact: "listed_checks_agree",
      observations: [],
      blockers: [],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkKind: "filesystem_structure",
        outcome: "valid",
        reason: null,
      }),
      expect.objectContaining({
        checkKind: "dvd_navigation",
        outcome: "valid",
        reason: null,
      }),
      expect.objectContaining({
        checkKind: "title_enumeration",
        outcome: "valid",
        reason: null,
      }),
    ]);
  });

  it("keeps unproved coverage unknown and classifies contradictions", async () => {
    expect(await check({
      policyVersion: "dvd-full-extent-metadata-v1",
      decision: "publishable",
      impact: "unknown",
      observations: [],
      blockers: [],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: "indeterminate",
        reason: { code: "UNPROVED_STRUCTURAL_EXTENT", message: expect.any(String) },
      }),
    ]));

    const contradiction = await check({
      policyVersion: "dvd-full-extent-metadata-v1",
      decision: "blocked",
      impact: "unknown",
      observations: [],
      blockers: [{
        field: "VIDEO_TS/VTS_01_1.VOB.NAV.PCI",
        reason: "contradiction",
        message: "Synthetic readable claims disagree.",
      }],
    });
    expect(contradiction).toEqual([
      expect.objectContaining({
        checkKind: "filesystem_structure",
        outcome: "not_run",
      }),
      expect.objectContaining({
        checkKind: "dvd_navigation",
        outcome: "invalid",
        reason: { code: "STRUCTURAL_CONTRADICTION", message: expect.any(String) },
      }),
      expect.objectContaining({
        checkKind: "title_enumeration",
        outcome: "not_run",
      }),
    ]);
  });

  it("treats a local validator failure as an attempt failure", async () => {
    await expect(check({
      policyVersion: "dvd-full-extent-metadata-v1",
      decision: "blocked",
      impact: "unknown",
      observations: [],
      blockers: [{
        field: "image",
        reason: "local_failure",
        message: "Synthetic local failure.",
      }],
    })).rejects.toThrow("failed locally");
  });
});
