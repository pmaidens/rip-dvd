import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess, type DataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it } from "vitest";

import { readDashboardSnapshot } from "./dashboard";

const temporaryDirectories: string[] = [];
const openDataAccess: DataAccess[] = [];

function createTestDataAccess(): DataAccess {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-"));
  temporaryDirectories.push(directory);
  const access = createDataAccess({ databasePath: join(directory, "test.sqlite") });
  openDataAccess.push(access);
  return access;
}

afterEach(() => {
  for (const access of openDataAccess.splice(0)) {
    access.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("readDashboardSnapshot", () => {
  it("returns the five operations sections from facade-backed SQLite state", () => {
    const access = createTestDataAccess();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Upper drive",
      vendor: "Pioneer",
      product: "BDR-XD08",
      isEnabled: true,
      isPresent: true,
    });

    const waitingDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "waiting-disc",
      volumeLabel: "WAITING_DISC",
      scanData: { titles: 12 },
    });
    access.catalog.updateDetectedDiscStatus(waitingDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(waitingDisc.id, "approved");
    access.archiveJobs.enqueue({ detectedDiscId: waitingDisc.id, priority: 10 });

    const reviewDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "review-disc",
      volumeLabel: "REVIEW_DISC",
    });
    access.catalog.updateDetectedDiscStatus(reviewDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(reviewDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: reviewDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Review Disc.iso",
      fingerprint: "review-disc",
      sizeBytes: 4_700_000_000,
    });

    const catalogedDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cataloged-disc",
      volumeLabel: "CATALOGED_DISC",
    });
    access.catalog.updateDetectedDiscStatus(catalogedDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(catalogedDisc.id, "approved");
    const catalogedArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: catalogedDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cataloged Disc.iso",
      fingerprint: "cataloged-disc",
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "The Example",
      year: 2001,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: catalogedArchive.id,
      mediaItemId: mediaItem.id,
      sourceKey: "main-feature",
      kind: "main_feature",
      label: "Main feature",
    });
    const profile = access.catalog.createEncodingProfile({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      version: 1,
      settings: { preset: "Fast 480p30" },
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/The Example (2001).mkv",
      priority: 5,
    });

    const dashboard = readDashboardSnapshot(access);

    expect(dashboard.opticalDrives).toEqual([
      expect.objectContaining({
        displayName: "Upper drive",
        devicePath: "/dev/sr0",
        state: "ready",
      }),
    ]);
    expect(dashboard.detectedDiscs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          volumeLabel: "WAITING_DISC",
          status: "approved",
          opticalDriveName: "Upper drive",
        }),
      ]),
    );
    expect(dashboard.archiveJobs).toEqual([
      expect.objectContaining({
        discLabel: "WAITING_DISC",
        status: "queued",
        progressPercent: 0,
      }),
    ]);
    expect(dashboard.encodeJobs).toEqual([
      expect.objectContaining({
        mediaTitle: "The Example",
        mediaYear: 2001,
        encodingProfileName: "DVD library",
        status: "queued",
      }),
    ]);
    expect(dashboard.catalogReview).toEqual([
      expect.objectContaining({
        discLabel: "REVIEW_DISC",
        archivePath: "/media/originals/Review Disc.iso",
      }),
    ]);
    expect(dashboard.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns explicit empty collections when the database has no operations", () => {
    const dashboard = readDashboardSnapshot(createTestDataAccess());

    expect(dashboard).toEqual({
      generatedAt: expect.any(String),
      opticalDrives: [],
      detectedDiscs: [],
      archiveJobs: [],
      encodeJobs: [],
      catalogReview: [],
    });
  });
});
