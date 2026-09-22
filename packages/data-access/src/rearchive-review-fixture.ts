import { createCleanReadArchiveIntegrityEvidence } from "./archive-integrity.js";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "./disc-settling-fixture.js";
import type { LegacySidecarDataAccess } from "./legacy-sidecar-types.js";
import type {
  DiscInspection,
  DiscSelection,
  MediaItem,
  OriginalDiscArchive,
} from "./types.js";

export interface RearchiveReviewFixtureInput {
  fixtureId: string;
  mutationKey: string;
  sourceArchivePath: string;
  targetArchivePath: string;
  volumeLabel: string;
  mediaItemTitle: string;
  integrityPolicyVersion: string;
}

export function seedRearchiveReviewFixtureForTest(
  access: LegacySidecarDataAccess,
  input: RearchiveReviewFixtureInput,
): {
  mediaItem: MediaItem;
  sourceArchive: OriginalDiscArchive;
  sourceSelection: DiscSelection;
  targetArchive: OriginalDiscArchive;
} {
  const fingerprint = `dvdmeta-sha256:${"e".repeat(64)}`;
  const scanData = {
    schemaVersion: 2 as const,
    contentId: fingerprint,
    titles: [1, 2].map((number) => ({
      number,
      durationSeconds: number === 1 ? 5_400 : 900,
      chapters: number === 1 ? 12 : 3,
      audioStreams: [],
      subtitles: [],
    })),
  };
  const sourceDrive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/synthetic-${input.fixtureId}-source`,
    isEnabled: true,
    isPresent: true,
  });
  const sourceDisc = access.catalog.registerDetectedDisc({
    opticalDriveId: sourceDrive.id,
    discKind: "dvd",
    fingerprint,
    scanData,
    sizeBytes: 4_096,
    volumeLabel: input.volumeLabel,
  });
  access.catalog.updateDetectedDiscStatus(sourceDisc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(sourceDisc.id, "approved");
  const sourceArchive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: sourceDisc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: input.sourceArchivePath,
    fingerprint,
    sizeBytes: 4_096,
  });
  const mediaItem = access.catalog.createMediaItem({
    kind: "movie",
    title: input.mediaItemTitle,
  });
  const sourceSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: sourceArchive.id,
    mediaItemId: mediaItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: "Feature",
  });
  const currentSource = access.catalog.listOriginalDiscArchives({
    ids: [sourceArchive.id],
  })[0]!;
  access.catalog.completeCatalogReview(
    sourceArchive.id,
    currentSource.updatedAt,
    "reviewed_with_selections",
  );
  const request = access.archiveRequests.submitRearchive({
    mutationKey: input.mutationKey,
    sourceArchiveId: sourceArchive.id,
  });
  if (request.status !== "pending") {
    throw new Error("Expected a pending synthetic Re-archive Request");
  }
  const targetDrive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/synthetic-${input.fixtureId}-target`,
    isEnabled: true,
    isPresent: true,
  });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: targetDrive.id,
    mediaGeneration: `synthetic-${input.fixtureId}-generation`,
    mediaCapacityBytes: 4_096,
  });
  let inspection: DiscInspection;
  try {
    access.discInspections.record(started.claim, {
      type: "metadata",
      volumeLabel: input.volumeLabel,
      titleCount: 2,
      chapterCount: 15,
      audioStreamCount: 0,
      subtitleStreamCount: 0,
      totalBytes: 4_096,
    });
    const targetDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: targetDrive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
      sizeBytes: 4_096,
      volumeLabel: input.volumeLabel,
    });
    inspection = access.discInspections.record(started.claim, {
      type: "complete",
      detectedDiscId: targetDisc.id,
    });
  } finally {
    started.restoreSystemTime();
  }
  const claim = access.archiveJobs.startForInspection(
    inspection.id,
    `synthetic-${input.fixtureId}-worker`,
  );
  if (!claim) throw new Error("Expected the Re-archive Request to start");
  const completed = access.archiveJobs.publish(claim, {
    archivePath: input.targetArchivePath,
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(4_096),
    sizeBytes: 4_096,
    integrityEvidence: createCleanReadArchiveIntegrityEvidence(
      input.integrityPolicyVersion,
    ),
  });
  const targetArchive = access.catalog.listOriginalDiscArchives({
    ids: [completed.originalDiscArchiveId!],
  })[0]!;
  return {
    mediaItem,
    sourceArchive,
    sourceSelection,
    targetArchive,
  };
}
