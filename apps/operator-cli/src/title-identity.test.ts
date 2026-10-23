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
  const { archive } = await seedCommittedArchiveEvidence(
    fixture,
    [],
    false,
    true,
  );
  const access = fixture.openAccess();
  const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  const mediaItem = access.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic retained title",
  });
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
          reviewContinuity: { result: "initial" },
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
          reviewContinuity: { result: "initial" },
          observation: { displayTitleNumber: 4 },
        },
      ],
    },
  });
  const catalogRevision = (response.result as { catalogRevision: string })
    .catalogRevision;

  const created = await fixture.run([
    "disc-selection",
    "create",
    archive.id,
    "--key",
    "00000000-0000-4000-8000-000000000401",
    "--revision",
    catalogRevision,
    "--media-item-id",
    mediaItem.id,
    "--source-kind",
    "dvd_title",
    "--title-number",
    "1",
  ]);
  expect(created.exitCode).toBe(0);
  const selectionId = (created.result as {
    discSelection: { id: string };
  }).discSelection.id;
  const afterCreate = await fixture.run([
    "catalog-review",
    "show",
    archive.id,
  ]);
  expect(afterCreate.result).toMatchObject({
    titleIdentity: {
      items: [
        {
          mappingState: "mapped",
          discSelectionMappings: [{
            discSelectionId: selectionId,
            mappingState: "mapped",
          }],
        },
        { mappingState: "unmapped", discSelectionMappings: [] },
      ],
    },
  });

  const unsupportedPreview = await fixture.run([
    "disc-selection",
    "preview",
    "update",
    archive.id,
    selectionId,
    "--source-kind",
    "main_feature",
  ]);
  expect(unsupportedPreview).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "CATALOG_MAPPING_SOURCE_UNSUPPORTED",
      },
    },
  });
  expect((await fixture.run([
    "catalog-review",
    "show",
    archive.id,
  ])).result).toMatchObject({
    titleIdentity: {
      items: [
        {
          mappingState: "mapped",
          discSelectionMappings: [{
            discSelectionId: selectionId,
            mappingState: "mapped",
          }],
        },
        { mappingState: "unmapped", discSelectionMappings: [] },
      ],
    },
  });

  const deletionPreview = await fixture.run([
    "disc-selection",
    "preview",
    "delete",
    archive.id,
    selectionId,
  ]);
  const deletionDecision = deletionPreview.result as {
    catalogRevision: string;
    previewToken: string;
  };
  const deleted = await fixture.run([
    "disc-selection",
    "delete",
    archive.id,
    selectionId,
    "--key",
    "00000000-0000-4000-8000-000000000402",
    "--revision",
    deletionDecision.catalogRevision,
    "--preview-token",
    deletionDecision.previewToken,
    "--acknowledge",
  ]);
  expect(deleted).toMatchObject({ exitCode: 0 });
  expect((await fixture.run([
    "catalog-review",
    "show",
    archive.id,
  ])).result).toMatchObject({
    titleIdentity: {
      items: [
        { mappingState: "unmapped", discSelectionMappings: [] },
        { mappingState: "unmapped", discSelectionMappings: [] },
      ],
    },
  });
}, 15_000);
