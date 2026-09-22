import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

import {
  createOperatorWorkflowFixture,
  seedCatalogReviewForReadFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const key = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function fixture() {
  const current = createOperatorWorkflowFixture();
  fixtures.push(current);
  const seeded = seedCatalogReviewForReadFixture(current);
  return { current, ...seeded };
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.dispose();
});

async function reviewPlan(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
  archiveId: string,
) {
  const review = await current.run(["catalog-review", "show", archiveId]);
  return review.result as {
    catalogRevision: string;
    replacementPlan: {
      jobs: Array<{
        predecessorEncodeJobId: string;
        proposedEncodingProfileId: string;
        proposedOutputPath: string;
      }>;
    };
  };
}

it("previews and completes a review while explicitly omitting replacements", async () => {
  const { current, archive } = fixture();
  const review = await reviewPlan(current, archive.id);
  const command = {
    action: "complete_review",
    catalogRevision: review.catalogRevision,
    outcome: "reviewed_with_selections",
    replacementEncodes: [],
  };
  const json = JSON.stringify(command);
  const preview = await current.run([
    "catalog-review", "preview-completion", archive.id, "--json", json,
  ]);
  expect(preview.exitCode).toBe(0);
  expect(preview.result).toMatchObject({
    state: "available",
    catalogRevision: review.catalogRevision,
    consequences: {
      replacementEncodes: [],
      availableReplacementEncodeCount: 1,
      omittedReplacementEncodeCount: 1,
    },
  });
  const accepted = preview.result as {
    catalogRevision: string;
    previewToken: string;
  };
  const missingKey = await current.run([
    "catalog-review", "complete", archive.id,
    "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken,
    "--acknowledge", "--json", json,
  ]);
  expect(missingKey.result).toMatchObject({
    error: { code: "INVALID_MUTATION_KEY" },
  });
  const missingAcknowledgement = await current.run([
    "catalog-review", "complete", archive.id,
    "--key", key(1),
    "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken,
    "--json", json,
  ]);
  expect(missingAcknowledgement.result).toMatchObject({
    error: { code: "INVALID_ARGUMENTS" },
  });
  const args = [
    "catalog-review", "complete", archive.id,
    "--key", key(1),
    "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken,
    "--acknowledge", "--json", json,
  ];
  const completed = await current.run(args);
  expect(completed.exitCode).toBe(0);
  expect(completed.result).toEqual({
    archive: {
      id: archive.id,
      catalogReviewedAt: expect.any(String),
      catalogReviewOutcome: "reviewed_with_selections",
    },
  });
  expect((await current.run(args)).result).toEqual(completed.result);
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  expect(access.encodeJobs.list()).toHaveLength(1);
  access.close();
});

it("queues an included replacement atomically and rejects changed-key replay", async () => {
  const { current, archive, predecessor, correctedSelection } = fixture();
  const review = await reviewPlan(current, archive.id);
  const proposed = review.replacementPlan.jobs[0]!;
  const command = {
    action: "complete_review",
    catalogRevision: review.catalogRevision,
    outcome: "reviewed_with_selections",
    replacementEncodes: [{
      predecessorEncodeJobId: proposed.predecessorEncodeJobId,
      encodingProfileId: proposed.proposedEncodingProfileId,
      outputPath: proposed.proposedOutputPath,
    }],
  };
  const json = JSON.stringify(command);
  const preview = await current.run([
    "catalog-review", "preview-completion", archive.id, "--json", json,
  ]);
  const accepted = preview.result as {
    catalogRevision: string;
    previewToken: string;
  };
  const args = [
    "catalog-review", "complete", archive.id,
    "--key", key(2), "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken, "--acknowledge",
    "--stdin",
  ];
  const alteredPlan = await current.run([
    "catalog-review", "complete", archive.id,
    "--key", key(99), "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken, "--acknowledge", "--json",
    JSON.stringify({ ...command, replacementEncodes: [] }),
  ]);
  expect(alteredPlan.result).toMatchObject({
    error: { code: "REVIEW_COMPLETION_REJECTED" },
  });
  const completed = await current.run(args, null, json);
  expect(completed.result).toMatchObject({
    archive: { catalogReviewOutcome: "reviewed_with_selections" },
    replacementEncodeJobs: [{
      predecessorEncodeJobId: predecessor.id,
      discSelectionId: correctedSelection.id,
      status: "queued",
    }],
  });
  expect((await current.run(args, null, json)).result).toEqual(completed.result);

  const changed = await current.run([
    "catalog-review", "complete", archive.id,
    "--key", key(2), "--revision", accepted.catalogRevision,
    "--preview-token", accepted.previewToken, "--acknowledge", "--json",
    JSON.stringify({ ...command, replacementEncodes: [] }),
  ]);
  expect(changed.result).toMatchObject({
    error: { code: "MUTATION_KEY_CONFLICT" },
  });
  const access = current.openAccess();
  expect(access.encodeJobs.list().filter((job) =>
    job.predecessorEncodeJobId === predecessor.id
  )).toHaveLength(1);
  access.close();
});

it("accepts completion plans from files and rejects stale revisions and invalid profiles", async () => {
  const { current, archive, correctedSelection } = fixture();
  const review = await reviewPlan(current, archive.id);
  const proposed = review.replacementPlan.jobs[0]!;
  const invalidProfileAccess = current.openAccess();
  const audioProfile = invalidProfileAccess.encodingProfiles.create({
    key: "synthetic-audio",
    displayName: "Synthetic audio",
    mediaDomain: "audio",
    settings: {},
  });
  invalidProfileAccess.close();
  const invalidCommand = {
    action: "complete_review",
    catalogRevision: review.catalogRevision,
    outcome: "reviewed_with_selections",
    replacementEncodes: [{
      predecessorEncodeJobId: proposed.predecessorEncodeJobId,
      encodingProfileId: audioProfile.id,
      outputPath: proposed.proposedOutputPath,
    }],
  };
  const file = join(current.mediaLibraryPath, "completion.json");
  writeFileSync(file, JSON.stringify(invalidCommand));
  const invalid = await current.run([
    "catalog-review", "preview-completion", archive.id, "--file", file,
  ]);
  expect(invalid.result).toMatchObject({
    error: { code: "REVIEW_COMPLETION_REJECTED" },
  });
  const access = current.openAccess();
  access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: correctedSelection.mediaItemId,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: "Updated synthetic label",
  });
  access.close();
  const stale = await current.run([
    "catalog-review", "preview-completion", archive.id,
    "--json", JSON.stringify({ ...invalidCommand, replacementEncodes: [] }),
  ]);
  expect(stale.result).toMatchObject({
    error: { code: "STALE_CATALOG_REVISION" },
  });
  const reader = current.openAccess();
  expect(reader.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
    .toMatchObject({ catalogReviewOutcome: "needs_review" });
  expect(reader.encodeJobs.list()).toHaveLength(1);
  reader.close();
});

it("rejects output conflicts during preview without partial completion", async () => {
  const { current, archive } = fixture();
  const review = await reviewPlan(current, archive.id);
  const proposed = review.replacementPlan.jobs[0]!;
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-conflict-disc",
    isPresent: true,
  });
  const contentId = `sha256:${"b".repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    scanData: {
      schemaVersion: 2,
      contentId,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 8,
        audioStreams: [],
        subtitles: [],
      }],
    },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const otherArchive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/media/originals/synthetic-conflict.iso",
    fingerprint: contentId,
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic conflict",
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: otherArchive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  access.catalog.completeCatalogReview(
    otherArchive.id,
    access.catalog.listOriginalDiscArchives({ ids: [otherArchive.id] })[0]!
      .updatedAt,
    "reviewed_with_selections",
  );
  access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: proposed.proposedEncodingProfileId as Parameters<
      typeof access.encodeJobs.enqueue
    >[0]["encodingProfileId"],
    outputPath: join(current.mediaLibraryPath, "reserved.mkv"),
  });
  access.close();

  const conflict = await current.run([
    "catalog-review", "preview-completion", archive.id, "--json",
    JSON.stringify({
      action: "complete_review",
      catalogRevision: review.catalogRevision,
      outcome: "reviewed_with_selections",
      replacementEncodes: [{
        predecessorEncodeJobId: proposed.predecessorEncodeJobId,
        encodingProfileId: proposed.proposedEncodingProfileId,
        outputPath: join(current.mediaLibraryPath, "reserved.mkv"),
      }],
    }),
  ]);
  expect(conflict.result).toMatchObject({
    error: { code: "REVIEW_COMPLETION_REJECTED" },
  });
  const reader = current.openAccess();
  expect(reader.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
    .toMatchObject({ catalogReviewOutcome: "needs_review" });
  expect(reader.encodeJobs.list()).toHaveLength(2);
  reader.close();
});
