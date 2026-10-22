import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DvdFullExtentMetadataDecision,
} from "./dvd-full-extent-validator.js";
import { createNodeDvdStructuralChecker } from "./dvd-structural-check.js";
import { isoProfileImage } from "./dvd-metadata-profile-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

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

function structuralChecks({
  blocked = null,
  unproved = false,
}: {
  blocked?: "filesystem_structure" | "dvd_navigation" |
    "title_enumeration" | null;
  unproved?: boolean;
} = {}): DvdFullExtentMetadataDecision["structuralChecks"] {
  return ([
    "filesystem_structure",
    "dvd_navigation",
    "title_enumeration",
  ] as const).map((checkKind, index) => ({
    checkKind,
    execution: checkKind === blocked ? "interrupted" as const : "completed" as const,
    testedExtent: {
      startLba: index + 1,
      endLbaExclusive: index + 2,
      observedSectorCount: 1,
    },
    hasUnprovedDependencies: unproved && checkKind === "filesystem_structure",
  }));
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
  it("preserves completed prerequisite checks and observed extents after a navigation contradiction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dvd-structural-check-"));
    directories.push(directory);
    const imagePath = join(directory, "synthetic.iso");
    const image = isoProfileImage();
    image.writeUInt32BE(0xffffffff, 40 * 2048 + 45);
    await writeFile(imagePath, image);
    const stat = await lstat(imagePath, { bigint: true });

    const findings = await createNodeDvdStructuralChecker().check({
      checkpoint,
      descriptor: 17,
      imageFilesystemIdentity: `${stat.dev}:${stat.ino}`,
      imagePath,
      unrecoveredSourceRanges: [],
      signal: new AbortController().signal,
      assertStable() {},
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkKind: "filesystem_structure",
        outcome: "valid",
        testedExtent: expect.objectContaining({
          observedSectorCount: expect.any(Number),
        }),
      }),
      expect.objectContaining({
        checkKind: "dvd_navigation",
        outcome: "invalid",
        testedExtent: expect.objectContaining({
          observedSectorCount: expect.any(Number),
        }),
      }),
      expect.objectContaining({
        checkKind: "title_enumeration",
        outcome: "valid",
        testedExtent: expect.objectContaining({
          observedSectorCount: expect.any(Number),
        }),
      }),
    ]);
    for (const finding of findings) {
      if (finding.testedExtent !== null) {
        expect(finding.testedExtent.observedSectorCount).toBeLessThanOrEqual(
          finding.testedExtent.endLbaExclusive -
            finding.testedExtent.startLba,
        );
      }
    }
    const [filesystem, navigation, titles] = findings;
    expect(titles?.testedExtent).toMatchObject({
      startLba: filesystem?.testedExtent?.startLba,
    });
    expect(navigation?.testedExtent).toMatchObject({
      startLba: filesystem?.testedExtent?.startLba,
    });
  });

  it("reports valid only when the complete structural profile is proved", async () => {
    const findings = await check({
      policyVersion: "dvd-full-extent-metadata-v1",
      decision: "publishable",
      impact: "listed_checks_agree",
      observations: [],
      blockers: [],
      blockedCheckKind: null,
      structuralChecks: structuralChecks(),
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
      blockedCheckKind: null,
      structuralChecks: structuralChecks({ unproved: true }),
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
      blockedCheckKind: "dvd_navigation",
      structuralChecks: structuralChecks({ blocked: "dvd_navigation" }),
    });
    expect(contradiction).toEqual([
      expect.objectContaining({
        checkKind: "filesystem_structure",
        outcome: "valid",
      }),
      expect.objectContaining({
        checkKind: "dvd_navigation",
        outcome: "invalid",
        reason: { code: "STRUCTURAL_CONTRADICTION", message: expect.any(String) },
      }),
      expect.objectContaining({
        checkKind: "title_enumeration",
        outcome: "valid",
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
      blockedCheckKind: "filesystem_structure",
      structuralChecks: structuralChecks({ blocked: "filesystem_structure" }),
    })).rejects.toThrow("failed locally");
  });
});
