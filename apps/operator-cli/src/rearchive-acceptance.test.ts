import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import {
  createOperatorWorkflowFixture,
  seedRearchiveCatalogReviewFixture,
} from "./operator-workflow.test-support.js";

let current: ReturnType<typeof createOperatorWorkflowFixture>;

beforeEach(() => {
  current = createOperatorWorkflowFixture();
});

afterEach(() => {
  current.dispose();
});

it("previews, accepts, and replays Re-archive Acceptance through JSON CLI", async () => {
  const seeded = seedRearchiveCatalogReviewFixture(current);
  const show = await current.run([
    "catalog-review",
    "show",
    seeded.targetArchive.id,
  ]);
  const initial = (show.result as {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
      mappings: Array<{
        sourceDiscSelectionId: string;
        proposedMapping: {
          mediaItemId: string;
          sourceIdentity: { kind: "dvd_title"; titleNumber: number };
          label: string | null;
        };
      }>;
    };
  }).rearchiveProposal;
  const proposal = {
    action: "save_rearchive_mapping_proposal",
    catalogRevision: initial.catalogRevision,
    sourceCatalogRevision: initial.sourceCatalogRevision,
    mappings: initial.mappings.map((mapping) => ({
      sourceDiscSelectionId: mapping.sourceDiscSelectionId,
      ...mapping.proposedMapping,
    })),
  };
  const save = await current.run([
    "catalog-review",
    "save-rearchive-proposal",
    seeded.targetArchive.id,
    "--key",
    "00000000-0000-4000-8000-000000000551",
    "--json",
    JSON.stringify(proposal),
  ]);
  expect(save.exitCode).toBe(0);
  const saved = (save.result as {
    proposal: { catalogRevision: string; sourceCatalogRevision: string };
  }).proposal;

  const access = current.openAccess();
  const profile = access.encodingProfiles.create({
    key: "rearchive-cli-acceptance",
    displayName: "Re-archive CLI acceptance",
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  const queued = access.encodeJobs.enqueue({
    discSelectionId: seeded.sourceSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(current.mediaLibraryPath, "rearchive-cli.mkv"),
  });
  access.close();

  const acceptance = {
    action: "accept_rearchive",
    catalogRevision: saved.catalogRevision,
    sourceCatalogRevision: saved.sourceCatalogRevision,
    replacementEncodes: [],
  };
  const preview = await current.run([
    "catalog-review",
    "preview-rearchive-acceptance",
    seeded.targetArchive.id,
    "--json",
    JSON.stringify(acceptance),
  ]);
  expect(preview.exitCode).toBe(0);
  expect(preview.result).toMatchObject({
    state: "available",
    targetArchiveId: seeded.targetArchive.id,
    sourceArchiveId: seeded.sourceArchive.id,
    affectedEncodeJobs: [{ id: queued.id, status: "queued" }],
    consequences: {
      adoptsMappingCount: 1,
      requestsEncodeJobCancellation: [queued.id],
      replacementEncodeCount: 0,
    },
  });
  const previewResult = preview.result as {
    catalogRevision: string;
    sourceCatalogRevision: string;
    previewToken: string;
  };
  const args = [
    "catalog-review",
    "accept-rearchive",
    seeded.targetArchive.id,
    "--key",
    "00000000-0000-4000-8000-000000000552",
    "--revision",
    previewResult.catalogRevision,
    "--source-revision",
    previewResult.sourceCatalogRevision,
    "--preview-token",
    previewResult.previewToken,
    "--acknowledge",
    "--json",
    JSON.stringify(acceptance),
  ];
  const accepted = await current.run(args);
  const replay = await current.run(args);
  expect(accepted.exitCode).toBe(0);
  expect(replay.result).toEqual(accepted.result);
  expect(accepted.result).toMatchObject({
    message: "Re-archive accepted",
    targetArchive: {
      id: seeded.targetArchive.id,
      catalogReviewOutcome: "reviewed_with_selections",
    },
    affectedEncodeJobs: [{ id: queued.id, status: "cancelled" }],
  });
});

it("rejects replacement encodes explicitly", async () => {
  const result = await current.run([
    "catalog-review",
    "preview-rearchive-acceptance",
    "fresh-archive",
    "--json",
    JSON.stringify({
      action: "accept_rearchive",
      catalogRevision: "2026-01-02T00:00:00.000Z",
      sourceCatalogRevision: "2026-01-01T00:00:00.000Z",
      replacementEncodes: [{ predecessorEncodeJobId: "job-1" }],
    }),
  ]);
  expect(result.exitCode).toBe(2);
  expect(result.result).toEqual({
    error: {
      code: "INVALID_REARCHIVE_ACCEPTANCE",
      message: "Re-archive replacement encodes are not supported yet",
    },
  });
});
