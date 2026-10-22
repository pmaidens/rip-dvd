import { afterEach, expect, it } from "vitest";

import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
} from "./archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("pages revision-bound Title Damage evidence through the public JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [
    {
      startLba: 15,
      sectorCount: 5,
      classification: "skipped_untested",
    },
    {
      startLba: 205,
      sectorCount: 2,
      classification: "skipped_untested",
    },
  ]);
  const access = fixture.openAccess();
  const structuralResult = await access.assessDvdStructure(
    archive.id,
    createArchiveImageOwnership({
      authorityRootPath: fixture.originalsLibraryPath,
    }),
    async () => ({
      outcome: "completed" as const,
      findings: [
        {
          checkKind: "filesystem_structure" as const,
          policyVersion: "synthetic-filesystem-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 1_000,
            observedSectorCount: 50,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:filesystem",
        },
        {
          checkKind: "dvd_navigation" as const,
          policyVersion: "synthetic-navigation-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 250,
            observedSectorCount: 25,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:navigation",
        },
        {
          checkKind: "title_enumeration" as const,
          policyVersion: "synthetic-titles-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 250,
            observedSectorCount: 25,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:titles",
        },
      ],
    }),
  );
  if (structuralResult?.outcome !== "completed") {
    throw new Error("Expected a completed Structural Assessment");
  }
  const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  const reviewSet = access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: archive.id,
    checkpoint: {
      manifestId: header.currentManifestId,
      manifestRevision: header.currentManifestRevision,
      manifestDigest: header.currentManifestDigest,
    },
    observations: [
      {
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 4,
        chapterCount: 4,
        sourceExtents: [{ startLba: 0, sectorCount: 110 }],
      },
      {
        displayTitleNumber: 2,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 2,
          programChainNumber: 2,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 2,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 2,
        chapterCount: 2,
        sourceExtents: [{ startLba: 0, sectorCount: 60 }],
      },
      {
        displayTitleNumber: 3,
        navigation: {
          videoTitleSetNumber: 2,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 2,
          cellId: 1,
        }],
        angleNumber: 2,
        angleCount: 2,
        chapterStart: 2,
        chapterEnd: 3,
        chapterCount: 3,
        sourceExtents: [{ startLba: 200, sectorCount: 2 }],
      },
    ],
  });
  const currentItems = reviewSet.items.filter((item) =>
    item.presentAtCurrentCheckpoint
  );
  const mappings = [
    {
      titleIdentityObservationId: currentItems[0]!.observation.id,
      sourceReferences: [
        { kind: "navigation", startLba: 0, sectorCount: 10 },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 100,
        },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 100,
        },
      ],
      mappingCoverage: {
        state: "complete",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [],
      },
    },
    {
      titleIdentityObservationId: currentItems[1]!.observation.id,
      sourceReferences: [
        { kind: "navigation", startLba: 0, sectorCount: 10 },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 50,
        },
      ],
      mappingCoverage: {
        state: "complete",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [],
      },
    },
    {
      titleIdentityObservationId: currentItems[2]!.observation.id,
      sourceReferences: [{
        kind: "multiplexed_content",
        startLba: 200,
        sectorCount: 2,
      }],
      mappingCoverage: {
        state: "partial",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [{
          code: "TITLE_SOURCE_MAP_INCOMPLETE",
          message: "The selected path has unresolved navigation.",
        }],
      },
    },
  ] as const;
  const ownership = createArchiveImageOwnership({
    authorityRootPath: fixture.originalsLibraryPath,
  });
  const recorded = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async ({ titleIdentity, structuralAssessmentIdentity }, handle) => {
      handle.assertOwned();
      expect(titleIdentity.reviewSetIdentity).toBe(
        reviewSet.reviewSetIdentity,
      );
      expect(structuralAssessmentIdentity).toBe(
        structuralResult.assessment.id,
      );
      return mappings;
    },
  );
  if (recorded === null) {
    throw new Error("Expected a recorded Title Damage Assessment");
  }
  const repeated = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => recorded.items.map((item) => ({
      titleIdentityObservationId: item.titleIdentityObservationId,
      sourceReferences: item.uniqueSourceRanges.map((range) => ({
        kind: "multiplexed_content" as const,
        ...range,
      })),
      mappingCoverage: item.mappingCoverage,
    })),
  );
  expect(repeated?.id).toBe(recorded.id);
  access.close();

  const review = await fixture.run(["catalog-review", "show", archive.id]);
  expect(review).toMatchObject({
    exitCode: 0,
    result: {
      titleDamage: {
        state: "current",
        checkpointRevision: 1,
        assessmentIdentity: recorded.id,
        currentAssessmentIdentity: recorded.id,
        items: [
          { displayTitleNumber: 1 },
          { displayTitleNumber: 2 },
          { displayTitleNumber: 3 },
        ],
        truncated: false,
      },
    },
  });

  const first = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--limit",
    "1",
  ]);
  expect(first.exitCode).toBe(0);
  expect(first.result).toMatchObject({
    state: "current",
    checkpointRevision: 1,
    assessmentIdentity: recorded.id,
    items: [{
      displayTitleNumber: 1,
      uniqueSourceSectorCount: 110,
      unrecoveredUniqueSourceSectorCount: 5,
      titleMissingSourcePercentage: 5 / 110 * 100,
    }],
    truncated: true,
    nextCursor: expect.any(String),
    unknownTitleImpact: {
      unrecoveredSourceSectorCount: 2,
    },
  });
  const cursor = (first.result as { nextCursor: string }).nextCursor;
  const second = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--limit",
    "2",
    "--cursor",
    cursor,
  ]);
  expect(second).toMatchObject({
    exitCode: 0,
    result: {
      checkpointRevision: 1,
      itemOffset: 1,
      items: [
        { displayTitleNumber: 2 },
        {
          displayTitleNumber: 3,
          uniqueSourceSectorCount: null,
          titleMissingSourcePercentage: null,
        },
      ],
      truncated: false,
      nextCursor: null,
    },
  });

  advanceCommittedArchiveEvidence(fixture, manifest);
  const staleResult = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--cursor",
    cursor,
  ]);
  expect(staleResult).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "TITLE_DAMAGE_CURSOR_STALE",
        current: {
          checkpointRevision: 2,
          assessmentIdentity: null,
        },
      },
    },
  });
}, 20_000);
