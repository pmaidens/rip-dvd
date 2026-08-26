import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

const databasePath = process.env.RIP_DVD_DATABASE_PATH;
const mediaLibraryPath = process.env.RIP_DVD_MEDIA_LIBRARY_PATH;
const originalsLibraryPath = process.env.RIP_DVD_ORIGINALS_LIBRARY_PATH;

if (!databasePath || !mediaLibraryPath || !originalsLibraryPath) {
  throw new Error("Catalog Review browser fixture paths are required");
}

const expectedFixtureRoot = resolve("test-results/catalog-review-browser-data");
if (
  resolve(databasePath) !== join(expectedFixtureRoot, "rip-dvd.sqlite") ||
  resolve(mediaLibraryPath) !== join(expectedFixtureRoot, "media") ||
  resolve(originalsLibraryPath) !== join(expectedFixtureRoot, "originals")
) {
  throw new Error(
    `Refusing to seed outside the Catalog Review browser fixture root: ${expectedFixtureRoot}`,
  );
}

const fixtureRoot = dirname(databasePath);
rmSync(fixtureRoot, { force: true, recursive: true });
mkdirSync(mediaLibraryPath, { recursive: true });
mkdirSync(originalsLibraryPath, { recursive: true });

const access = createLegacySidecarDataAccess({
  databasePath,
  mediaLibraryPath,
  originalsLibraryPath,
});

const longToken = "UNBROKEN-CATALOG-LABEL-".repeat(8);
const longMediaTitle = "A deliberately long Catalog Review title with edition, language, season, and archival context ";

function createArchive({ key, label, fingerprintFill, titles }) {
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/browser-${key}`,
    displayName: `Browser fixture ${key}`,
    isPresent: true,
  });
  const fingerprint = `sha256:${fingerprintFill.repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: label,
    scanData: {
      schemaVersion: 2,
      contentId: fingerprint,
      titles,
    },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  return access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: join(originalsLibraryPath, `${key}.iso`),
    fingerprint,
  });
}

function completeReview(archiveId) {
  const archive = access.catalog.listOriginalDiscArchives({ ids: [archiveId] })[0];
  if (!archive) throw new Error(`Missing browser fixture archive ${archiveId}`);
  access.catalog.completeCatalogReview(
    archive.id,
    archive.updatedAt,
    "reviewed_with_selections",
  );
}

function detailedTitle(number, durationSeconds, chapters) {
  return {
    number,
    durationSeconds,
    chapters,
    audioStreams: Array.from({ length: 8 }, (_, index) => ({
      id: 128 + index,
      language: `Language-${number}-${index}-${"x".repeat(34)}`,
      format: `DTS-HD-Master-Audio-${"y".repeat(24)}`,
      channels: index % 2 === 0 ? 6 : 2,
    })),
    subtitles: Array.from({ length: 12 }, (_, index) => ({
      id: 32 + index,
      language: `Subtitle-${number}-${index}-${"z".repeat(34)}`,
      content: `Closed-captions-and-forced-narrative-${index}`,
    })),
  };
}

function seedKeyboardJourney(variant, fingerprintFill) {
  createArchive({
    key: `keyboard-${variant}`,
    label: `CATALOG_BROWSER_KEYBOARD_${variant.toUpperCase()}`,
    fingerprintFill,
    titles: [
      detailedTitle(1, 5_400, 14),
      detailedTitle(2, 2_400, 8),
    ],
  });
}

function seedComplexLayout(variant, fingerprintFill) {
  const key = `layout-${variant}`;
  const archive = createArchive({
    key,
    label: `CATALOG_BROWSER_LAYOUT_${variant.toUpperCase()}_${longToken}`.slice(0, 256),
    fingerprintFill,
    titles: [
      detailedTitle(1, 7_200, 18),
      detailedTitle(2, 5_100, 16),
      detailedTitle(3, 2_400, 10),
      detailedTitle(4, 2_360, 9),
      detailedTitle(5, 2_320, 9),
      detailedTitle(6, 75, 2),
    ],
  });
  const mistakenItem = access.catalog.createMediaItem({
    kind: "movie",
    title: `${longMediaTitle}mistaken ${variant} ${longToken}`.slice(0, 256),
  });
  const correctedItem = access.catalog.createMediaItem({
    kind: "movie",
    title: `${longMediaTitle}corrected ${variant} ${longToken}`.slice(0, 256),
  });
  const lockedItem = access.catalog.createMediaItem({
    kind: "bonus_feature",
    title: `${longMediaTitle}locked provenance ${variant} ${longToken}`.slice(0, 256),
  });
  const partialItem = access.catalog.createMediaItem({
    kind: "other",
    title: `${longMediaTitle}partial chapter selection ${variant}`,
  });
  const correctedSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: mistakenItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    label: `${longToken} corrected source`.slice(0, 256),
  });
  const lockedSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: lockedItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    label: `${longToken} locked source`.slice(0, 256),
  });
  access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: partialItem.id,
    sourceIdentity: {
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 1,
      chapterEnd: 4,
    },
    label: `${longToken} partial source`.slice(0, 256),
  });
  completeReview(archive.id);

  const profile = access.encodingProfiles.create({
    key: `browser-${variant}`,
    displayName: `Browser replacement profile with long descriptive context ${variant}`,
    mediaDomain: "dvd_video",
    settings: { preset: "HQ 480p30 Surround" },
  });
  const correctedJob = access.encodeJobs.enqueue({
    discSelectionId: correctedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `${key}-corrected-output.mkv`),
  });
  access.encodeJobs.enqueue({
    discSelectionId: lockedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `${key}-locked-output.mkv`),
  });
  for (let index = 0; index < 2; index += 1) {
    const claim = access.encodeJobs.claimNext(`browser-seed-${variant}-${index}`);
    if (!claim) throw new Error(`Missing browser fixture Encode Job ${index}`);
    access.encodeJobs.complete(claim);
  }
  const currentArchive = access.catalog.listOriginalDiscArchives({
    ids: [archive.id],
  })[0];
  if (!currentArchive) throw new Error(`Missing browser fixture archive ${archive.id}`);
  access.catalog.correctDiscSelection(correctedSelection.id, {
    originalDiscArchiveId: archive.id,
    catalogRevision: currentArchive.updatedAt,
    mediaItemId: correctedItem.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    reason: "The completed encode used the mistaken Catalog Review mapping.",
  });

  const plan = access.catalog.listCorrectedEncodeReplacementPlans({
    originalDiscArchiveId: archive.id,
    limit: 10,
  });
  if (plan[0]?.predecessorEncodeJobId !== correctedJob.id) {
    throw new Error("Browser fixture replacement plan was not created");
  }
}

function createEncodeQueueSelection({ key, label, fingerprintFill, title }) {
  const archive = createArchive({
    key,
    label,
    fingerprintFill,
    titles: [detailedTitle(1, 5_400, 14)],
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title,
    year: 2026,
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeReview(archive.id);
  return selection;
}

function seedEncodeQueue(variant, fingerprintFills) {
  const profile = access.encodingProfiles.create({
    key: `queue-${variant}`,
    displayName: `Queue browser profile ${variant}`,
    mediaDomain: "dvd_video",
    settings: { preset: "HQ 480p30 Surround", container: "mkv" },
  });
  const newSelection = createEncodeQueueSelection({
    key: `queue-new-${variant}`,
    label: `ENCODE_QUEUE_NEW_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.newSelection,
    title: `Queue new ${variant}`,
  });
  const completedSelection = createEncodeQueueSelection({
    key: `queue-completed-${variant}`,
    label: `ENCODE_QUEUE_COMPLETED_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.completedSelection,
    title: `Queue completed ${variant}`,
  });
  const completedJob = access.encodeJobs.enqueue({
    discSelectionId: completedSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(
      mediaLibraryPath,
      `Queue completed ${variant} authoritative.mkv`,
    ),
    priority: 10,
  });
  const claim = access.encodeJobs.claimNext(`queue-completed-${variant}`);
  if (claim?.id !== completedJob.id) {
    throw new Error(`Missing completed queue fixture for ${variant}`);
  }
  access.encodeJobs.complete(claim);

  const activeSelection = createEncodeQueueSelection({
    key: `queue-active-${variant}`,
    label: `ENCODE_QUEUE_ACTIVE_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.activeSelection,
    title: `Queue active ${variant}`,
  });
  access.encodeJobs.enqueue({
    discSelectionId: activeSelection.id,
    encodingProfileId: profile.id,
    outputPath: join(mediaLibraryPath, `Queue active ${variant}.mkv`),
  });

  const overflowArchive = createArchive({
    key: `queue-overflow-${variant}`,
    label: `ENCODE_QUEUE_OVERFLOW_${variant.toUpperCase()}`,
    fingerprintFill: fingerprintFills.overflowSelection,
    titles: Array.from({ length: 101 }, (_, index) =>
      detailedTitle(index + 1, 5_400, 14)
    ),
  });
  for (let index = 0; index < 101; index += 1) {
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: `Queue filler ${variant} ${String(index).padStart(3, "0")}`,
      year: 2026,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: overflowArchive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: index + 1 },
    });
  }
  completeReview(overflowArchive.id);

  const sqlite = new DatabaseSync(databasePath);
  sqlite.prepare(`
    update original_disc_archives
    set catalog_reviewed_at = 1
    where id = ?
  `).run(newSelection.originalDiscArchiveId);
  sqlite.close();
}

try {
  seedKeyboardJourney("desktop", "1");
  seedComplexLayout("desktop", "2");
  seedKeyboardJourney("mobile", "3");
  seedComplexLayout("mobile", "4");
  seedEncodeQueue("desktop", {
    newSelection: "5",
    completedSelection: "6",
    activeSelection: "7",
    overflowSelection: "b",
  });
  seedEncodeQueue("mobile", {
    newSelection: "8",
    completedSelection: "9",
    activeSelection: "a",
    overflowSelection: "c",
  });
} finally {
  access.close();
}
