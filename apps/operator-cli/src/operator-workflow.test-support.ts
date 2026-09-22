import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCleanReadArchiveIntegrityEvidence,
  createDataAccess,
} from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import type { CatalogMetadataLookup } from "@rip-dvd/application";

import { runCommand } from "./command.js";

export function createOperatorWorkflowFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-operator-cli-"));
  const databasePath = join(directory, "catalog.sqlite");
  const mediaLibraryPath = join(directory, "movies");
  const originalsLibraryPath = join(directory, "originals");
  mkdirSync(mediaLibraryPath);
  mkdirSync(originalsLibraryPath);

  const openAccess = () => createDataAccess({
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
  });

  return {
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
    openAccess,
    async run(args: readonly string[], lookup?: CatalogMetadataLookup | null, stdin?: string) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCommand(args, {
        openAccess,
        readFile: (path) => readFileSync(path, "utf8"),
        mediaLibraryPath: () => mediaLibraryPath,
        ...(lookup === undefined ? {} : { getLookup: () => lookup }),
        ...(stdin === undefined ? {} : { readStdin: () => stdin }),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      return {
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        result: JSON.parse(stdout.join("")) as unknown,
      };
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function seedCatalogReviewForReadFixture(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
  options: {
    predecessorOutcome?: "completed" | "running" | "failed_cleanup_pending";
  } = {},
) {
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-disc",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EXAMPLE_FILM_2020",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 5_400,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/example-film.iso",
      fingerprint: contentId,
    });
    const previousItem = access.catalog.createMediaItem({ kind: "movie", title: "Previous Film" });
    const correctedItem = access.catalog.createMediaItem({ kind: "movie", title: "Corrected Film" });
    const previousSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: previousItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.create({
      key: "synthetic-review-profile",
      displayName: "Synthetic review profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    access.encodeJobs.enqueue({
      discSelectionId: previousSelection.id,
      encodingProfileId: profile.id,
      outputPath: join(current.mediaLibraryPath, "previous-film.mkv"),
    });
    const claim = access.encodeJobs.claimNext("synthetic-review-worker");
    if (!claim) throw new Error("Expected synthetic Encode Job claim");
    const runningClaim = options.predecessorOutcome === "running"
      ? claim
      : undefined;
    const partialCleanupClaim =
      options.predecessorOutcome === "failed_cleanup_pending"
        ? access.encodeJobs.registerPartialCleanup(claim)
        : undefined;
    const predecessor = options.predecessorOutcome === "running"
      ? claim
      : options.predecessorOutcome === "failed_cleanup_pending"
        ? access.encodeJobs.fail(claim, "Synthetic predecessor failure")
        : access.encodeJobs.complete(claim);
    const correction = access.catalog.correctDiscSelection(previousSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
      reason: "Correct the synthetic mapping.",
    });
    return {
      archive,
      previousSelection,
      correctedSelection: correction.discSelection,
      predecessor,
      runningClaim,
      partialCleanupClaim,
    };
  } finally {
    access.close();
  }
}

export function seedRearchiveCatalogReviewFixture(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
) {
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  try {
    const fingerprint = `dvdmeta-sha256:${"d".repeat(64)}`;
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
      devicePath: "/dev/synthetic-rearchive-cli-source",
      isEnabled: true,
      isPresent: true,
    });
    const sourceDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: sourceDrive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
      sizeBytes: 4_096,
      volumeLabel: "SYNTHETIC_REARCHIVE_CLI",
    });
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(sourceDisc.id, "approved");
    const sourceArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: sourceDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: join(current.originalsLibraryPath, "rearchive-cli-source.iso"),
      fingerprint,
      sizeBytes: 4_096,
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Synthetic re-archive feature",
    });
    const sourceSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: sourceArchive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      label: "Feature",
    });
    access.catalog.completeCatalogReview(
      sourceArchive.id,
      access.catalog.listOriginalDiscArchives({ ids: [sourceArchive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
    );
    access.archiveRequests.submitRearchive({
      mutationKey: "00000000-0000-4000-8000-000000000548",
      sourceArchiveId: sourceArchive.id,
    });
    const targetDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-rearchive-cli-target",
      isEnabled: true,
      isPresent: true,
    });
    const started = beginSettledDiscInspectionForTest(access, {
      opticalDriveId: targetDrive.id,
      mediaGeneration: "synthetic-rearchive-cli-generation",
      mediaCapacityBytes: 4_096,
    });
    access.discInspections.record(started.claim!, {
      type: "metadata",
      volumeLabel: "SYNTHETIC_REARCHIVE_CLI",
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
      volumeLabel: "SYNTHETIC_REARCHIVE_CLI",
    });
    const inspection = access.discInspections.record(started.claim!, {
      type: "complete",
      detectedDiscId: targetDisc.id,
    });
    started.restoreSystemTime();
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "synthetic-rearchive-cli-worker",
    );
    if (!claim) throw new Error("Expected the Re-archive Request to start");
    const completed = access.archiveJobs.publish(claim, {
      archivePath: join(current.originalsLibraryPath, "rearchive-cli-target.iso"),
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(4_096),
      sizeBytes: 4_096,
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        "dvd-recovery-v1",
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
  } finally {
    access.close();
  }
}
