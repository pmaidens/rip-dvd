import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { seedRearchiveReviewFixtureForTest } from "@rip-dvd/data-access/rearchive-test-support";
import { afterEach, expect, it } from "vitest";

import { createApplicationOperations } from "./index.js";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-rearchive-accept-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "catalog.sqlite");
  const mediaLibraryPath = join(directory, "media");
  const originalsLibraryPath = join(directory, "originals");
  mkdirSync(mediaLibraryPath);
  mkdirSync(originalsLibraryPath);
  const access = createLegacySidecarDataAccess({
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
  });
  const seeded = seedRearchiveReviewFixtureForTest(access, {
    fixtureId: "application-rearchive-acceptance",
    mutationKey: "00000000-0000-4000-8000-000000000349",
    sourceArchivePath: join(originalsLibraryPath, "source.iso"),
    targetArchivePath: join(originalsLibraryPath, "fresh.iso"),
    volumeLabel: "SYNTHETIC_REARCHIVE_ACCEPTANCE",
    mediaItemTitle: "Synthetic accepted feature",
    integrityPolicyVersion: "test-clean-v1",
  });
  const operations = createApplicationOperations(access);
  const initialProposal = access.catalog.readRearchiveMappingProposal(
    seeded.targetArchive.id,
  );
  if (initialProposal === null) {
    throw new Error("Expected a Re-archive Mapping Proposal");
  }
  const saved = operations.saveRearchiveMappingProposal({
    originalDiscArchiveId: seeded.targetArchive.id,
    mutationKey: "00000000-0000-4000-8000-000000000350",
    catalogRevision: initialProposal.catalogRevision,
    sourceCatalogRevision: initialProposal.sourceCatalogRevision,
    mappings: initialProposal.mappings.map((mapping) => ({
      sourceDiscSelectionId: mapping.sourceDiscSelectionId,
      ...mapping.proposedMapping,
    })),
  }).proposal;
  const profile = (suffix: string) => access.encodingProfiles.create({
    key: `rearchive-acceptance-${suffix}`,
    displayName: `Re-archive acceptance ${suffix}`,
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  const enqueue = (suffix: string) => access.encodeJobs.enqueue({
    discSelectionId: seeded.sourceSelection.id,
    encodingProfileId: profile(suffix).id,
    outputPath: join(mediaLibraryPath, `${suffix}.mkv`),
  });
  return {
    access,
    operations,
    saved,
    seeded,
    enqueue,
    profile,
    databasePath,
    mediaLibraryPath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("adopts a reviewed re-archive atomically and preserves worker ownership", () => {
  const current = fixture();
  try {
    const completed = current.enqueue("completed");
    const completedClaim = current.access.encodeJobs.claimNext("completed-worker");
    if (!completedClaim || completedClaim.id !== completed.id) {
      throw new Error("Expected the completed Encode Job claim");
    }
    current.access.encodeJobs.complete(completedClaim);

    const running = current.enqueue("running");
    const runningClaim = current.access.encodeJobs.claimNext("running-worker");
    if (!runningClaim || runningClaim.id !== running.id) {
      throw new Error("Expected the running Encode Job claim");
    }
    const publication = current.access.encodeJobs.registerPartialCleanup(
      runningClaim,
      { publicationPending: true },
    );
    const fencedPublication = current.access.encodeJobs
      .beginPublicationMutation(runningClaim, publication);
    const queued = current.enqueue("queued");
    const command = {
      action: "accept_rearchive" as const,
      catalogRevision: current.saved.catalogRevision,
      sourceCatalogRevision: current.saved.sourceCatalogRevision,
    };

    const stalePreview = current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      command,
    );
    expect(stalePreview.affectedEncodeJobs).toEqual([
      expect.objectContaining({ id: running.id, status: "running" }),
      expect.objectContaining({ id: queued.id, status: "queued" }),
    ]);
    const lateQueued = current.enqueue("late-queued");
    expect(() => current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      {
        mutationKey: "00000000-0000-4000-8000-000000000351",
        acknowledgedRevision: stalePreview.catalogRevision,
        acknowledgedSourceRevision: stalePreview.sourceCatalogRevision,
        previewToken: stalePreview.previewToken,
        acknowledge: true,
      },
    )).toThrow("Re-archive Acceptance preview is stale");
    expect(current.access.catalog.listDiscSelections({
      originalDiscArchiveId: current.seeded.targetArchive.id,
    })).toEqual([]);
    expect(current.access.encodeJobs.find(running.id)?.status).toBe("running");
    expect(current.access.encodeJobs.find(queued.id)?.status).toBe("queued");

    const preview = current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      command,
    );
    expect(preview.affectedEncodeJobs.map(({ id, status }) => ({ id, status })))
      .toEqual([
        { id: running.id, status: "running" },
        { id: queued.id, status: "queued" },
        { id: lateQueued.id, status: "queued" },
      ]);
    const acceptanceInput = {
      mutationKey: "00000000-0000-4000-8000-000000000352",
      acknowledgedRevision: preview.catalogRevision,
      acknowledgedSourceRevision: preview.sourceCatalogRevision,
      previewToken: preview.previewToken,
      acknowledge: true,
    };
    const accepted = current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      acceptanceInput,
    );
    const replay = current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      acceptanceInput,
    );

    expect(replay).toEqual(accepted);
    expect(accepted).toMatchObject({
      message: "Re-archive accepted",
      sourceArchive: { id: current.seeded.sourceArchive.id },
      targetArchive: {
        id: current.seeded.targetArchive.id,
        catalogReviewOutcome: "reviewed_with_selections",
      },
      createdDiscSelections: [{
        priorDiscSelectionId: current.seeded.sourceSelection.id,
        discSelection: {
          originalDiscArchiveId: current.seeded.targetArchive.id,
          mediaItemId: current.seeded.mediaItem.id,
        },
      }],
      affectedEncodeJobs: [
        { id: running.id, status: "cancellation_requested" },
        { id: queued.id, status: "cancelled" },
        { id: lateQueued.id, status: "cancelled" },
      ],
    });
    const adoptedSelection = current.access.catalog.listDiscSelections({
      originalDiscArchiveId: current.seeded.targetArchive.id,
    })[0]!;
    expect(current.access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [current.seeded.sourceSelection.id],
    })).toEqual([expect.objectContaining({
      supersededDiscSelectionId: current.seeded.sourceSelection.id,
      replacementDiscSelectionId: adoptedSelection.id,
      reason: "Re-archive Acceptance",
    })]);
    expect(current.access.catalog.listDiscSelections({
      ids: [current.seeded.sourceSelection.id],
    })).toEqual([expect.objectContaining({
      id: current.seeded.sourceSelection.id,
      originalDiscArchiveId: current.seeded.sourceArchive.id,
    })]);
    expect(current.access.encodeJobs.find(completed.id)?.status).toBe("completed");
    expect(current.access.catalog.listOriginalDiscArchives()).toHaveLength(2);
    expect(current.access.catalog.readRearchiveMappingProposal(
      current.seeded.targetArchive.id,
    )).toBeNull();

    const afterAcceptanceProfile = current.profile("after-acceptance");
    expect(() => current.access.encodeJobs.enqueue({
      discSelectionId: current.seeded.sourceSelection.id,
      encodingProfileId: afterAcceptanceProfile.id,
      outputPath: join(current.mediaLibraryPath, "after-acceptance.mkv"),
    })).toThrow("disc selection");
    expect(current.access.encodeJobs.enqueue({
      discSelectionId: adoptedSelection.id,
      encodingProfileId: afterAcceptanceProfile.id,
      outputPath: join(current.mediaLibraryPath, "accepted-source.mkv"),
    })).toMatchObject({
      discSelectionId: adoptedSelection.id,
      status: "queued",
    });
    expect(() => current.access.encodeJobs.completePublishedClaim(
      runningClaim,
      fencedPublication,
      () => true,
    )).toThrow("Stale encode job publication attempt");
    expect(current.access.encodeJobs.find(running.id)).toMatchObject({
      status: "cancellation_requested",
      claimToken: runningClaim.claimToken,
      claimedBy: runningClaim.claimedBy,
    });
  } finally {
    current.access.close();
  }
});

it("rolls back adoption writes when a late persistence step fails", () => {
  const current = fixture();
  try {
    const queued = current.enqueue("rollback");
    const command = {
      action: "accept_rearchive" as const,
      catalogRevision: current.saved.catalogRevision,
      sourceCatalogRevision: current.saved.sourceCatalogRevision,
    };
    const preview = current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      command,
    );
    const acceptanceInput = {
      mutationKey: "00000000-0000-4000-8000-000000000353",
      acknowledgedRevision: preview.catalogRevision,
      acknowledgedSourceRevision: preview.sourceCatalogRevision,
      previewToken: preview.previewToken,
      acknowledge: true,
    };
    const sqlite = new DatabaseSync(current.databasePath);
    sqlite.exec(`
      create trigger synthetic_rearchive_acceptance_failure
      before update on original_disc_archives
      begin
        select raise(abort, 'synthetic Re-archive Acceptance failure');
      end;
    `);
    sqlite.close();

    expect(() => current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      acceptanceInput,
    )).toThrow("Failed query");
    expect(current.access.catalog.listDiscSelections({
      originalDiscArchiveId: current.seeded.targetArchive.id,
    })).toEqual([]);
    expect(current.access.catalog.listDiscSelections({
      originalDiscArchiveId: current.seeded.sourceArchive.id,
    })).toEqual([expect.objectContaining({
      id: current.seeded.sourceSelection.id,
    })]);
    expect(current.access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [current.seeded.sourceSelection.id],
    })).toEqual([]);
    expect(current.access.encodeJobs.find(queued.id)?.status).toBe("queued");
    expect(current.access.catalog.listOriginalDiscArchives().find(
      (archive) => archive.id === current.seeded.targetArchive.id,
    )?.catalogReviewedAt).toBeNull();

    const retrySqlite = new DatabaseSync(current.databasePath);
    retrySqlite.exec("drop trigger synthetic_rearchive_acceptance_failure");
    retrySqlite.close();
    expect(current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      acceptanceInput,
    )).toMatchObject({ message: "Re-archive accepted" });
  } finally {
    current.access.close();
  }
});

it("requires a fresh preview when publication wins the acceptance race", () => {
  const current = fixture();
  try {
    const running = current.enqueue("publication-wins");
    const claim = current.access.encodeJobs.claimNext("publication-worker");
    if (!claim || claim.id !== running.id) {
      throw new Error("Expected the publication Encode Job claim");
    }
    const cleanup = current.access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    const publication = current.access.encodeJobs.beginPublicationMutation(
      claim,
      cleanup,
    );
    const command = {
      action: "accept_rearchive" as const,
      catalogRevision: current.saved.catalogRevision,
      sourceCatalogRevision: current.saved.sourceCatalogRevision,
    };
    const stalePreview = current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      command,
    );

    expect(current.access.encodeJobs.completePublishedClaim(
      claim,
      publication,
      () => true,
    ).status).toBe("completed");
    expect(() => current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      {
        mutationKey: "00000000-0000-4000-8000-000000000354",
        acknowledgedRevision: stalePreview.catalogRevision,
        acknowledgedSourceRevision: stalePreview.sourceCatalogRevision,
        previewToken: stalePreview.previewToken,
        acknowledge: true,
      },
    )).toThrow("Re-archive Acceptance preview is stale");

    const freshPreview = current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      command,
    );
    expect(freshPreview.affectedEncodeJobs).toEqual([]);
    expect(current.operations.acceptRearchive(
      current.seeded.targetArchive.id,
      command,
      {
        mutationKey: "00000000-0000-4000-8000-000000000355",
        acknowledgedRevision: freshPreview.catalogRevision,
        acknowledgedSourceRevision: freshPreview.sourceCatalogRevision,
        previewToken: freshPreview.previewToken,
        acknowledge: true,
      },
    )).toMatchObject({
      message: "Re-archive accepted",
      affectedEncodeJobs: [],
    });
    expect(current.access.encodeJobs.find(running.id)?.status).toBe("completed");
  } finally {
    current.access.close();
  }
});

it("rejects unsupported replacement plans before acceptance", () => {
  const current = fixture();
  try {
    expect(() => current.operations.previewRearchiveAcceptance(
      current.seeded.targetArchive.id,
      {
        action: "accept_rearchive",
        catalogRevision: current.saved.catalogRevision,
        sourceCatalogRevision: current.saved.sourceCatalogRevision,
        replacementEncodes: [{ predecessorEncodeJobId: "unsupported" }],
      } as never,
    )).toThrow("Re-archive replacement encodes are not supported yet");
  } finally {
    current.access.close();
  }
});
