import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
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
    const predecessor = access.encodeJobs.complete(claim);
    const correction = access.catalog.correctDiscSelection(previousSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
      reason: "Correct the synthetic mapping.",
    });
    return { archive, previousSelection, correctedSelection: correction.discSelection, predecessor };
  } finally {
    access.close();
  }
}
