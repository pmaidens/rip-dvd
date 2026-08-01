import type { DataAccess } from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import { readDashboardSnapshot } from "./dashboard";
import {
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

function seedEncodeJob(access: DataAccess): void {
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
  const profile = access.encodingProfiles.create({
    key: "enrichment-profile",
    displayName: "Enriched profile",
    mediaDomain: "dvd_video",
    settings: {},
  });
  access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: "/media/movies/enrichment.mkv",
  });
}

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
      scanData: {
        schemaVersion: 2,
        contentId:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        titles: [
          {
            number: 1,
            durationSeconds: 5_711,
            chapters: 12,
            audioStreams: [
              {
                id: 128,
                languageCode: "en",
                language: "English",
                format: "ac3",
                channels: 6,
              },
              {
                id: 137,
                languageCode: "fr",
                language: "Francais",
                format: "dts",
                channels: 2,
              },
            ],
            subtitles: [
              {
                id: 32,
                languageCode: "en",
                language: "English",
                content: "Normal",
              },
            ],
          },
        ],
      },
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
    const profile = access.encodingProfiles.create({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
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
          fingerprint: "waiting-disc",
          titles: [
            {
              number: 1,
              durationSeconds: 5_711,
              chapters: 12,
              audioStreams: [
                {
                  id: 128,
                  languageCode: "en",
                  language: "English",
                  format: "ac3",
                  channels: 6,
                },
                {
                  id: 137,
                  languageCode: "fr",
                  language: "Francais",
                  format: "dts",
                  channels: 2,
                },
              ],
              subtitles: [
                {
                  id: 32,
                  languageCode: "en",
                  language: "English",
                  content: "Normal",
                },
              ],
            },
          ],
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

  it("does not combine dashboard records from opposite sides of a worker commit", () => {
    const [reader, writer] = dataAccessFixture.createPair();
    const drive = writer.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const disc = writer.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "interleaved-dashboard-disc",
      volumeLabel: "INTERLEAVED_DISC",
    });
    writer.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    writer.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const job = writer.archiveJobs.enqueue({ detectedDiscId: disc.id });
    let archiveCommitted = false;
    const interleavedReader: DataAccess = {
      ...reader,
      readConsistentSnapshot(read) {
        return reader.readConsistentSnapshot((snapshotAccess) =>
          read({
            ...snapshotAccess,
            catalog: {
              ...snapshotAccess.catalog,
              listDetectedDiscs(statuses) {
                const records =
                  snapshotAccess.catalog.listDetectedDiscs(statuses);
                if (!archiveCommitted) {
                  archiveCommitted = true;
                  writer.catalog.createOriginalDiscArchive({
                    detectedDiscId: disc.id,
                    discKind: "dvd",
                    archiveFormat: "iso",
                    archivePath: "/media/originals/Interleaved Disc.iso",
                    fingerprint: "interleaved-dashboard-disc",
                  });
                }
                return records;
              },
            },
          }),
        );
      },
    };

    const dashboard = readDashboardSnapshot(interleavedReader);

    expect(dashboard.detectedDiscs).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ id: disc.id, status: "approved" })],
    });
    expect(dashboard.archiveJobs).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ id: job.id, status: "queued" })],
    });
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });
    expect(writer.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ id: disc.id, status: "archived" }),
    ]);
  });

  it("keeps unrelated sections available when one facade read fails", () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const partiallyUnavailableAccess = withSnapshotOverrides(access, {
      encodeJobs: {
        list() {
          throw new Error("encode queue unavailable");
        },
      },
    });

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

  it("keeps activity relationship reads bounded when Encode Jobs fail", () => {
    const access = dataAccessFixture.create();
    const listDiscSelections = vi.fn((options) =>
      access.catalog.listDiscSelections(options),
    );
    const listMediaItems = vi.fn((options) =>
      access.catalog.listMediaItems(options),
    );
    const listEncodingProfiles = vi.fn((options) =>
      access.encodingProfiles.list(options),
    );
    const dashboard = readDashboardSnapshot(
      withSnapshotOverrides(access, {
        catalog: { listDiscSelections, listMediaItems },
        encodingProfiles: { list: listEncodingProfiles },
        encodeJobs: {
          list() {
            throw new Error("encode queue unavailable");
          },
        },
      }),
      { activityLimit: 20 },
    );

    expect(listDiscSelections).toHaveBeenCalledWith({ ids: [] });
    expect(listMediaItems).toHaveBeenCalledWith({ ids: [] });
    expect(listEncodingProfiles).toHaveBeenCalledWith({ ids: [] });
    expect(dashboard.encodeJobs).toEqual({ status: "error" });
  });

  it("keeps activity media reads bounded when Disc Selections fail", () => {
    const access = dataAccessFixture.create();
    seedEncodeJob(access);
    const listMediaItems = vi.fn((options) =>
      access.catalog.listMediaItems(options),
    );
    const dashboard = readDashboardSnapshot(
      withSnapshotOverrides(access, {
        catalog: {
          listDiscSelections() {
            throw new Error("disc selections unavailable");
          },
          listMediaItems,
        },
      }),
      { activityLimit: 20 },
    );

    expect(listMediaItems).toHaveBeenCalledWith({ ids: [] });
    expect(dashboard.encodeJobs).toEqual({ status: "error" });
    expect(dashboard.catalogReview).toEqual({ status: "error" });
  });

  it("marks drive-dependent sections unavailable when the drive read fails", () => {
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

    const dashboard = readDashboardSnapshot(withSnapshotOverrides(access, {
      catalog: {
        listOpticalDrives() {
          throw new Error("drive inventory unavailable");
        },
      },
    }));

    expect(dashboard.opticalDrives).toEqual({ status: "error" });
    expect(dashboard.detectedDiscs).toEqual({ status: "error" });
    expect(dashboard.archiveJobs).toEqual({ status: "error" });
    expect(dashboard.encodeJobs).toEqual({ status: "loaded", items: [] });
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });
  });

  it("marks Archive Jobs unavailable when the Detected Disc read fails", () => {
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

    const dashboard = readDashboardSnapshot(withSnapshotOverrides(access, {
      catalog: {
        listDetectedDiscs() {
          throw new Error("disc inventory unavailable");
        },
      },
    }));

    expect(dashboard.detectedDiscs).toEqual({ status: "error" });
    expect(dashboard.archiveJobs).toEqual({ status: "error" });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(dashboard.encodeJobs).toEqual({ status: "loaded", items: [] });
  });

  it("marks Catalog Review unavailable when the Detected Disc read fails", () => {
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

    const dashboard = readDashboardSnapshot(withSnapshotOverrides(access, {
      catalog: {
        listDetectedDiscs() {
          throw new Error("disc inventory unavailable");
        },
      },
    }));

    expect(dashboard.catalogReview).toEqual({ status: "error" });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(dashboard.encodeJobs.status).toBe("loaded");
  });

  it("marks Encode Jobs unavailable when media and profile reads fail", () => {
    const access = dataAccessFixture.create();
    seedEncodeJob(access);

    const dashboard = readDashboardSnapshot(withSnapshotOverrides(access, {
      catalog: {
        listMediaItems() {
          throw new Error("media catalog unavailable");
        },
      },
      encodingProfiles: {
        ...access.encodingProfiles,
        list() {
          throw new Error("profile catalog unavailable");
        },
      },
    }));

    expect(dashboard.encodeJobs).toEqual({ status: "error" });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(dashboard.detectedDiscs.status).toBe("loaded");
    expect(dashboard.catalogReview.status).toBe("loaded");
  });

  it("marks both selection-dependent sections unavailable when selections fail", () => {
    const access = dataAccessFixture.create();
    seedEncodeJob(access);

    const dashboard = readDashboardSnapshot(withSnapshotOverrides(access, {
      catalog: {
        listDiscSelections() {
          throw new Error("disc selections unavailable");
        },
      },
    }));

    expect(dashboard.encodeJobs).toEqual({ status: "error" });
    expect(dashboard.catalogReview).toEqual({ status: "error" });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(dashboard.detectedDiscs.status).toBe("loaded");
    expect(dashboard.archiveJobs.status).toBe("loaded");
  });
});
