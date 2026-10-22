import { afterEach, expect, it } from "vitest";

import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("shows every checkpoint-bound Title Identity through the public JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedCommittedArchiveEvidence(fixture);
  const access = fixture.openAccess();
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
        chapterEnd: 12,
        chapterCount: 12,
        sourceExtents: [{ startLba: 10, sectorCount: 300 }],
      },
      {
        displayTitleNumber: 4,
        navigation: {
          videoTitleSetNumber: 2,
          titleSetTitleNumber: 1,
          programChainNumber: 3,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 2,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 2,
        chapterCount: 2,
        sourceExtents: [{ startLba: 500, sectorCount: 25 }],
      },
    ],
  });
  access.close();

  const response = await fixture.run(["catalog-review", "show", archive.id]);
  expect(response.exitCode).toBe(0);
  expect(response.result).toMatchObject({
    titleIdentity: {
      available: true,
      unavailableReason: null,
      checkpoint: { manifestRevision: 1 },
      policyVersion: "dvd-title-identity-continuity-v1",
      reviewSetIdentity: reviewSet.reviewSetIdentity,
      items: [
        {
          presentAtCurrentCheckpoint: true,
          mappingState: "unmapped",
          continuity: { result: "initial" },
          observation: {
            displayTitleNumber: 1,
            angleNumber: 1,
            chapterStart: 1,
            chapterEnd: 12,
            sourceExtents: [{ startLba: 10, sectorCount: 300 }],
          },
        },
        {
          presentAtCurrentCheckpoint: true,
          mappingState: "unmapped",
          continuity: { result: "initial" },
          observation: { displayTitleNumber: 4 },
        },
      ],
    },
  });
});
