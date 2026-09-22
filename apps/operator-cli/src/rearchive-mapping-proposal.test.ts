import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  createOperatorWorkflowFixture,
  seedRearchiveCatalogReviewFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const key = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function fixture() {
  const current = createOperatorWorkflowFixture();
  fixtures.push(current);
  return { current, ...seedRearchiveCatalogReviewFixture(current) };
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.dispose();
});

it("shows, previews, and saves an edited Re-archive Mapping Proposal", async () => {
  const { current, mediaItem, sourceArchive, sourceSelection, targetArchive } =
    fixture();
  const shown = await current.run([
    "catalog-review",
    "show",
    targetArchive.id,
  ]);
  expect(shown.result).toMatchObject({
    rearchiveProposal: {
      state: "ready",
      persisted: false,
      sourceArchive: { id: sourceArchive.id },
      targetArchive: { id: targetArchive.id },
      mappings: [{ sourceDiscSelectionId: sourceSelection.id }],
    },
  });
  const proposal = {
    action: "save_rearchive_mapping_proposal",
    catalogRevision: (shown.result as {
      rearchiveProposal: { catalogRevision: string };
    }).rearchiveProposal.catalogRevision,
    sourceCatalogRevision: (shown.result as {
      rearchiveProposal: { sourceCatalogRevision: string };
    }).rearchiveProposal.sourceCatalogRevision,
    mappings: [{
      sourceDiscSelectionId: sourceSelection.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      label: "Edited feature",
    }],
  };
  const preview = await current.run([
    "catalog-review",
    "preview-rearchive-proposal",
    targetArchive.id,
    "--json",
    JSON.stringify({ ...proposal, action: "preview_rearchive_mapping_proposal" }),
  ]);
  expect(preview.exitCode).toBe(0);
  expect(preview.result).toMatchObject({
    state: "ready",
    persisted: false,
    mappings: [{
      state: "valid",
      proposedMapping: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        label: "Edited feature",
      },
    }],
  });
  expect(JSON.stringify(preview.result)).not.toMatch(/archivePath|fingerprint/);

  const args = [
    "catalog-review",
    "save-rearchive-proposal",
    targetArchive.id,
    "--key",
    key(1),
  ] as const;
  const saved = await current.run([
    ...args,
    "--json",
    JSON.stringify(proposal),
  ]);
  expect(saved.exitCode).toBe(0);
  expect(saved.stderr).toBe("");
  expect(saved.result).toMatchObject({
    message: "Re-archive Mapping Proposal saved",
    proposal: {
      state: "ready",
      persisted: true,
      mappings: [{
        sourceDiscSelectionId: sourceSelection.id,
        proposedMapping: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      }],
    },
  });
  expect(JSON.stringify(saved.result)).not.toMatch(/archivePath|fingerprint/);
  expect((await current.run(
    [...args, "--stdin"],
    null,
    JSON.stringify(proposal),
  )).result).toEqual(saved.result);
  const inputPath = join(current.mediaLibraryPath, "rearchive-proposal.json");
  writeFileSync(inputPath, JSON.stringify(proposal));
  expect((await current.run([...args, "--file", inputPath])).result)
    .toEqual(saved.result);

  const access = current.openAccess();
  expect(access.catalog.listDiscSelections({
    originalDiscArchiveId: targetArchive.id,
  })).toEqual([]);
  expect(access.catalog.listDiscSelections({ ids: [sourceSelection.id] }))
    .toEqual([expect.objectContaining({
      id: sourceSelection.id,
      originalDiscArchiveId: sourceArchive.id,
    })]);
  access.close();
});

it("returns structured rejection codes without partially saving", async () => {
  const { current, mediaItem, sourceSelection, targetArchive } = fixture();
  const shown = await current.run([
    "catalog-review",
    "show",
    targetArchive.id,
  ]) as { result: {
    rearchiveProposal: {
      catalogRevision: string;
      sourceCatalogRevision: string;
    };
  } };
  const base = {
    action: "save_rearchive_mapping_proposal",
    catalogRevision: shown.result.rearchiveProposal.catalogRevision,
    sourceCatalogRevision: shown.result.rearchiveProposal.sourceCatalogRevision,
  };
  const incomplete = await current.run([
    "catalog-review",
    "save-rearchive-proposal",
    targetArchive.id,
    "--key",
    key(2),
    "--json",
    JSON.stringify({ ...base, mappings: [] }),
  ]);
  expect(incomplete.result).toMatchObject({
    error: { code: "REARCHIVE_PROPOSAL_INCOMPLETE" },
  });
  const incompatible = await current.run([
    "catalog-review",
    "save-rearchive-proposal",
    targetArchive.id,
    "--key",
    key(3),
    "--json",
    JSON.stringify({
      ...base,
      mappings: [{
        sourceDiscSelectionId: sourceSelection.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 99 },
        label: null,
      }],
    }),
  ]);
  expect(incompatible.result).toMatchObject({
    error: { code: "REARCHIVE_PROPOSAL_INCOMPATIBLE" },
  });
  const access = current.openAccess();
  expect(access.catalog.readRearchiveMappingProposal(targetArchive.id))
    .toMatchObject({ persisted: false });
  access.close();
});
