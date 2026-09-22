import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCleanReadArchiveIntegrityEvidence,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import { afterEach, expect, it } from "vitest";

import { createApplicationOperations } from "./index.js";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-rearchive-review-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "media"));
  mkdirSync(join(directory, "originals"));
  const access = createLegacySidecarDataAccess({
    databasePath: join(directory, "catalog.sqlite"),
    mediaLibraryPath: join(directory, "media"),
    originalsLibraryPath: join(directory, "originals"),
  });
  const fingerprint = `dvdmeta-sha256:${"a".repeat(64)}`;
  const scanData = {
    schemaVersion: 2 as const,
    contentId: fingerprint,
    titles: [
      {
        number: 1,
        durationSeconds: 5_400,
        chapters: 12,
        audioStreams: [],
        subtitles: [],
      },
      {
        number: 2,
        durationSeconds: 900,
        chapters: 3,
        audioStreams: [],
        subtitles: [],
      },
    ],
  };
  const sourceDrive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-rearchive-review-source",
    isEnabled: true,
    isPresent: true,
  });
  const sourceDisc = access.catalog.registerDetectedDisc({
    opticalDriveId: sourceDrive.id,
    discKind: "dvd",
    fingerprint,
    scanData,
    sizeBytes: 4_096,
    volumeLabel: "SYNTHETIC_REARCHIVE_REVIEW",
  });
  access.catalog.updateDetectedDiscStatus(sourceDisc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(sourceDisc.id, "approved");
  const sourceArchive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: sourceDisc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: join(directory, "originals", "source.iso"),
    fingerprint,
    sizeBytes: 4_096,
  });
  const movie = access.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic feature",
  });
  const sourceSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: sourceArchive.id,
    mediaItemId: movie.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: "Feature",
  });
  access.catalog.completeCatalogReview(
    sourceArchive.id,
    access.catalog.listOriginalDiscArchives({ ids: [sourceArchive.id] })[0]!
      .updatedAt,
    "reviewed_with_selections",
  );

  const request = access.archiveRequests.submitRearchive({
    mutationKey: "00000000-0000-4000-8000-000000000348",
    sourceArchiveId: sourceArchive.id,
  });
  const freshDrive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-rearchive-review-fresh",
    isEnabled: true,
    isPresent: true,
  });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: freshDrive.id,
    mediaGeneration: "synthetic-rearchive-review-generation",
    mediaCapacityBytes: 4_096,
  });
  access.discInspections.record(started.claim!, {
    type: "metadata",
    volumeLabel: "SYNTHETIC_REARCHIVE_REVIEW",
    titleCount: 2,
    chapterCount: 15,
    audioStreamCount: 0,
    subtitleStreamCount: 0,
    totalBytes: 4_096,
  });
  const observed = access.catalog.registerDetectedDisc({
    opticalDriveId: freshDrive.id,
    discKind: "dvd",
    fingerprint,
    scanData,
    sizeBytes: 4_096,
    volumeLabel: "SYNTHETIC_REARCHIVE_REVIEW",
  });
  const inspected = access.discInspections.record(started.claim!, {
    type: "complete",
    detectedDiscId: observed.id,
  });
  started.restoreSystemTime();
  const claim = access.archiveJobs.startForInspection(
    inspected.id,
    "synthetic-rearchive-review-worker",
  );
  if (!claim) throw new Error("Expected the Re-archive Request to start");
  const job = access.archiveJobs.publish(claim, {
    archivePath: join(directory, "originals", "fresh.iso"),
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(4_096),
    sizeBytes: 4_096,
    integrityEvidence: createCleanReadArchiveIntegrityEvidence(
      "dvd-recovery-v1",
    ),
  });
  const freshArchive = access.catalog.listOriginalDiscArchives({
    ids: [job.originalDiscArchiveId!],
  })[0]!;
  expect(request.status).toBe("pending");
  return { access, freshArchive, movie, sourceArchive, sourceSelection };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("offers prior mappings for review without adopting them", () => {
  const { access, freshArchive, movie, sourceArchive, sourceSelection } =
    fixture();
  try {
    const review = createApplicationOperations(access).catalogReview(
      freshArchive.id,
      {
        discSelectionOffset: 0,
        correctionHistoryOffset: 0,
        correctionEncodeHistoryOffset: 0,
        correctionRetainedOutputHistoryOffset: 0,
        replacementOffset: 0,
        replacementProfileOffset: 0,
      },
      false,
    );

    expect(review).toMatchObject({
      archive: { id: freshArchive.id },
      rearchiveProposal: {
        state: "ready",
        persisted: false,
        sourceArchive: {
          id: sourceArchive.id,
          catalogReviewOutcome: "reviewed_with_selections",
          integrityPolicyVersion: null,
          badSectorCountsByTitle: null,
        },
        targetArchive: {
          id: freshArchive.id,
          integrityPolicyVersion: "dvd-recovery-v1",
          badSectorCountsByTitle: null,
        },
        mappings: [{
          state: "valid",
          reason: null,
          sourceDiscSelectionId: sourceSelection.id,
          priorMapping: {
            mediaItemId: movie.id,
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: "Feature",
          },
          proposedMapping: {
            mediaItemId: movie.id,
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: "Feature",
          },
        }],
      },
      reviewActionAvailability: {
        completeWithSelections: {
          state: "blocked",
          reason: "Fresh re-archive review is completed through Re-archive Acceptance",
        },
        completeArchiveOnly: {
          state: "blocked",
          reason: "Fresh re-archive review is completed through Re-archive Acceptance",
        },
      },
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: freshArchive.id,
    })).toEqual([]);
    expect(access.catalog.listDiscSelections({ ids: [sourceSelection.id] }))
      .toEqual([expect.objectContaining({
        id: sourceSelection.id,
        originalDiscArchiveId: sourceArchive.id,
      })]);
    expect(() => access.catalog.createDiscSelection({
      originalDiscArchiveId: freshArchive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    })).toThrow("Fresh re-archive mappings require Re-archive Acceptance");
    expect(() => access.catalog.completeCatalogReview(
      freshArchive.id,
      freshArchive.updatedAt,
      "archive_only",
    )).toThrow(
      "Fresh re-archive review is completed through Re-archive Acceptance",
    );
  } finally {
    access.close();
  }
});

it("keeps intentional source overlap valid against the fresh inspection", () => {
  const { access, freshArchive, sourceArchive } = fixture();
  try {
    const bonusFeature = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Synthetic alternate edit",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: sourceArchive.id,
      mediaItemId: bonusFeature.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      label: "Alternate edit",
    });

    const proposal = proposalFromReview(access, freshArchive.id);
    expect(proposal.mappings.map(({ state, reason }) => ({ state, reason })))
      .toEqual([
        { state: "valid", reason: null },
        { state: "valid", reason: null },
      ]);
    expect(proposal).toMatchObject({
      state: "ready",
      mappings: [
        { state: "valid" },
        {
          state: "valid",
          proposedMapping: {
            mediaItemId: bonusFeature.id,
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
          },
        },
      ],
    });
  } finally {
    access.close();
  }
});

function proposalFromReview(
  access: ReturnType<typeof fixture>["access"],
  archiveId: ReturnType<typeof fixture>["freshArchive"]["id"],
) {
  const review = createApplicationOperations(access).catalogReview(
    archiveId,
    {
      discSelectionOffset: 0,
      correctionHistoryOffset: 0,
      correctionEncodeHistoryOffset: 0,
      correctionRetainedOutputHistoryOffset: 0,
      replacementOffset: 0,
      replacementProfileOffset: 0,
    },
    false,
  );
  const proposal = review && "rearchiveProposal" in review
    ? review.rearchiveProposal
    : undefined;
  if (proposal === undefined) {
    throw new Error("Expected a Re-archive Mapping Proposal");
  }
  return proposal;
}

it("persists an edited proposal with revision checks and replay", () => {
  const { access, freshArchive, movie, sourceArchive, sourceSelection } =
    fixture();
  try {
    const operations = createApplicationOperations(access);
    const initial = proposalFromReview(access, freshArchive.id);
    const input = {
      originalDiscArchiveId: freshArchive.id,
      catalogRevision: initial.catalogRevision,
      sourceCatalogRevision: initial.sourceCatalogRevision,
      mappings: [{
        sourceDiscSelectionId: sourceSelection.id,
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 2 },
        label: "Edited feature",
      }],
    };

    const preview = operations.previewRearchiveMappingProposal(input);
    expect(preview).toMatchObject({
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
    expect(JSON.stringify(preview)).not.toMatch(/archivePath|fingerprint/);
    const mutation = {
      ...input,
      mutationKey: "00000000-0000-4000-8000-000000000448",
    };
    const saved = operations.saveRearchiveMappingProposal(mutation);
    expect(saved).toMatchObject({
      message: "Re-archive Mapping Proposal saved",
      proposal: {
        state: "ready",
        persisted: true,
        mappings: [{
          sourceDiscSelectionId: sourceSelection.id,
          proposedMapping: {
            mediaItemId: movie.id,
            sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
            label: "Edited feature",
          },
        }],
      },
    });
    expect(JSON.stringify(saved)).not.toMatch(/archivePath|fingerprint/);
    expect(operations.saveRearchiveMappingProposal(mutation)).toEqual(saved);
    expect(proposalFromReview(access, freshArchive.id)).toMatchObject({
      state: "ready",
      persisted: true,
      mappings: saved.proposal.mappings,
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: freshArchive.id,
    })).toEqual([]);
    expect(access.catalog.listDiscSelections({ ids: [sourceSelection.id] }))
      .toEqual([expect.objectContaining({
        id: sourceSelection.id,
        originalDiscArchiveId: sourceArchive.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      })]);
    access.catalog.deleteDiscSelection(sourceSelection.id);
    expect(proposalFromReview(access, freshArchive.id)).toMatchObject({
      state: "stale",
      persisted: true,
      mappings: [{
        state: "stale",
        sourceDiscSelectionId: sourceSelection.id,
        priorMapping: null,
        proposedMapping: {
          mediaItemId: movie.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      }],
    });
  } finally {
    access.close();
  }
});

it("reports and rejects incomplete, incompatible, and stale proposals", () => {
  const { access, freshArchive, movie, sourceArchive, sourceSelection } =
    fixture();
  try {
    const operations = createApplicationOperations(access);
    const initial = proposalFromReview(access, freshArchive.id);
    const base = {
      originalDiscArchiveId: freshArchive.id,
      catalogRevision: initial.catalogRevision,
      sourceCatalogRevision: initial.sourceCatalogRevision,
    };
    const incomplete = { ...base, mappings: [] };
    expect(operations.previewRearchiveMappingProposal(incomplete))
      .toMatchObject({
        state: "incomplete",
        mappings: [{
          state: "incomplete",
          sourceDiscSelectionId: sourceSelection.id,
        }],
      });
    expect(() => operations.saveRearchiveMappingProposal({
      ...incomplete,
      mutationKey: "00000000-0000-4000-8000-000000000449",
    })).toThrow("Re-archive Mapping Proposal is incomplete");

    const incompatible = {
      ...base,
      mappings: [{
        sourceDiscSelectionId: sourceSelection.id,
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 99 },
        label: null,
      }],
    };
    expect(operations.previewRearchiveMappingProposal(incompatible))
      .toMatchObject({
        state: "incompatible",
        mappings: [{ state: "incompatible" }],
      });
    expect(() => operations.saveRearchiveMappingProposal({
      ...incompatible,
      mutationKey: "00000000-0000-4000-8000-000000000450",
    })).toThrow("Re-archive Mapping Proposal is incompatible");

    access.catalog.updateDiscSelection(sourceSelection.id, {
      originalDiscArchiveId: sourceArchive.id,
      label: "Changed after preview",
    });
    expect(operations.previewRearchiveMappingProposal({
      ...base,
      mappings: [{
        sourceDiscSelectionId: sourceSelection.id,
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
        label: "Feature",
      }],
    })).toMatchObject({
      state: "stale",
      mappings: [{ state: "stale" }],
    });
  } finally {
    access.close();
  }
});
