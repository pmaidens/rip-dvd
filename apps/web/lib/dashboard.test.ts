import type { DataAccess } from "@rip-dvd/data-access";
import { describe, expect, it } from "vitest";

import { readDashboardSnapshot } from "./dashboard";
import { useDataAccessFixture } from "../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

describe("readDashboardSnapshot", () => {
  it("returns the five operations sections from facade-backed SQLite state", () => {
    const access = dataAccessFixture.create();
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
    const encodeJob = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/The Example (2001).mkv",
      priority: 5,
    });
    const encodeClaim = access.encodeJobs.claimNext("encode-worker-test");
    expect(encodeClaim?.id).toBe(encodeJob.id);
    access.encodeJobs.fail(
      encodeClaim!,
      "HandBrake failed while reading /private/media/secret.iso",
    );

    const dashboard = readDashboardSnapshot(access);

    expect(dashboard.opticalDrives).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          displayName: "Upper drive",
          state: "ready",
        }),
      ],
    });
    expect(dashboard.detectedDiscs).toEqual({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          volumeLabel: "WAITING_DISC",
          status: "approved",
          opticalDriveName: "Upper drive",
        }),
      ]),
    });
    expect(dashboard.archiveJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          discLabel: "WAITING_DISC",
          status: "queued",
          progressPercent: 0,
        }),
      ],
    });
    expect(dashboard.encodeJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          mediaTitle: "The Example",
          mediaYear: 2001,
          encodingProfileName: "DVD library",
          status: "failed",
        }),
      ],
    });
    expect(dashboard.catalogReview).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ discLabel: "REVIEW_DISC" })],
    });
    expect(dashboard.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(dashboard)).not.toContain("/dev/sr0");
    expect(JSON.stringify(dashboard)).not.toContain("/media/");
    expect(JSON.stringify(dashboard)).not.toContain("secret.iso");
  });

  it("returns explicit empty collections when the database has no operations", () => {
    const dashboard = readDashboardSnapshot(dataAccessFixture.create());

    expect(dashboard).toEqual({
      generatedAt: expect.any(String),
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: { status: "loaded", items: [] },
      encodeJobs: { status: "loaded", items: [] },
      catalogReview: { status: "loaded", items: [] },
    });
  });

  it("keeps unrelated sections available when one facade read fails", () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const partiallyUnavailableAccess: DataAccess = {
      ...access,
      encodeJobs: {
        ...access.encodeJobs,
        list() {
          throw new Error("encode queue unavailable");
        },
      },
    };

    const dashboard = readDashboardSnapshot(partiallyUnavailableAccess);

    expect(dashboard.opticalDrives).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ displayName: "Archive drive" })],
    });
    expect(dashboard.detectedDiscs).toEqual({ status: "loaded", items: [] });
    expect(dashboard.archiveJobs).toEqual({ status: "loaded", items: [] });
    expect(dashboard.encodeJobs).toEqual({ status: "error" });
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });
  });

  it("keeps primary records available when display enrichment fails", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Enrichment drive",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "enrichment-disc",
      volumeLabel: "ENRICHMENT_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    access.archiveJobs.enqueue({ detectedDiscId: disc.id });

    const dashboard = readDashboardSnapshot({
      ...access,
      catalog: {
        ...access.catalog,
        listOpticalDrives() {
          throw new Error("drive inventory unavailable");
        },
      },
    });

    expect(dashboard.opticalDrives).toEqual({ status: "error" });
    expect(dashboard.detectedDiscs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          volumeLabel: "ENRICHMENT_DISC",
          opticalDriveName: "Unknown Optical Drive",
        }),
      ],
    });
    expect(dashboard.archiveJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          discLabel: "ENRICHMENT_DISC",
          opticalDriveName: "Unknown Optical Drive",
        }),
      ],
    });
  });

  it("does not hide archive jobs when detected-disc enrichment fails", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "archive-enrichment-disc",
      volumeLabel: "ARCHIVE_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    access.archiveJobs.enqueue({ detectedDiscId: disc.id });

    const dashboard = readDashboardSnapshot({
      ...access,
      catalog: {
        ...access.catalog,
        listDetectedDiscs() {
          throw new Error("disc inventory unavailable");
        },
      },
    });

    expect(dashboard.detectedDiscs).toEqual({ status: "error" });
    expect(dashboard.archiveJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          discLabel: "Unlabeled disc",
          opticalDriveName: "Unknown Optical Drive",
        }),
      ],
    });
    expect(dashboard.opticalDrives.status).toBe("loaded");
  });

  it("keeps catalog review available when disc labels cannot be enriched", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "catalog-enrichment-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/catalog-enrichment.iso",
      fingerprint: "catalog-enrichment-disc",
    });

    const dashboard = readDashboardSnapshot({
      ...access,
      catalog: {
        ...access.catalog,
        listDetectedDiscs() {
          throw new Error("disc inventory unavailable");
        },
      },
    });

    expect(dashboard.catalogReview).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ discLabel: "Unlabeled disc" })],
    });
  });

  it("keeps encode jobs available when optional catalog labels fail", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "encode-enrichment-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/encode-enrichment.iso",
      fingerprint: "encode-enrichment-disc",
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Enriched title",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceKey: "main-feature",
      kind: "main_feature",
      label: "Main feature",
    });
    const profile = access.catalog.createEncodingProfile({
      key: "enrichment-profile",
      displayName: "Enriched profile",
      mediaDomain: "dvd_video",
      version: 1,
      settings: {},
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/enrichment.mkv",
    });

    const dashboard = readDashboardSnapshot({
      ...access,
      catalog: {
        ...access.catalog,
        listMediaItems() {
          throw new Error("media catalog unavailable");
        },
        listEncodingProfiles() {
          throw new Error("profile catalog unavailable");
        },
      },
    });

    expect(dashboard.encodeJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          mediaTitle: "Unknown Media Item",
          encodingProfileName: "Unknown Encoding Profile",
        }),
      ],
    });
  });
});
