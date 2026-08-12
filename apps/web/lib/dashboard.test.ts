import { createDataAccess, type DataAccess } from "@rip-dvd/data-access";
import {
  createLegacySidecarDataAccess,
  type LegacySidecarDataAccess,
} from "@rip-dvd/data-access/legacy-sidecars";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readDashboardSnapshot } from "./dashboard";
import {
  completeDiscInspection,
  seedFailedArchiveJobAndQueuedDuplicate,
  startArchiveJob,
} from "../test/archive-job-fixture";
import {
  completeCatalogReview,
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

function seedEncodeJob(access: LegacySidecarDataAccess) {
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
    sourceIdentity: { kind: "main_feature" },
    label: "Main feature",
  });
  completeCatalogReview(access, archive.id);
  const profile = access.encodingProfiles.create({
    key: "enrichment-profile",
    displayName: "Enriched profile",
    mediaDomain: "dvd_video",
    settings: {},
  });
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: "/media/movies/enrichment.mkv",
  });
  return { archive, job };
}

describe("readDashboardSnapshot", () => {
  it("serializes explicit verification results without exposing paths", async () => {
    const access = dataAccessFixture.create();
    const { job } = seedEncodeJob(access);
    const drive = access.catalog.listOpticalDrives()[0]!;
    const reviewDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "verification-review-disc",
      volumeLabel: "VERIFY_REVIEW_DISC",
    });
    access.catalog.updateDetectedDiscStatus(reviewDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(reviewDisc.id, "approved");
    const reviewArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: reviewDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/verification-review.iso",
      fingerprint: reviewDisc.fingerprint,
    });

    await access.filesystemVerification.verifyEncodeJobOutput(job.id);
    await access.filesystemVerification.verifyOriginalDiscArchive(
      reviewArchive.id,
    );
    const dashboard = readDashboardSnapshot(access, { activityLimit: 20 });

    expect(dashboard.encodeJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          id: job.id,
          verificationStatus: "missing",
          verificationMessage: "File is missing at the recorded path.",
          verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ],
    });
    expect(dashboard.catalogReview).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          id: reviewArchive.id,
          verificationStatus: "missing",
          verificationMessage: "File is missing at the recorded path.",
          verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ],
    });
    expect(JSON.stringify(dashboard)).not.toContain("/media/");
  });

  it("keeps a partially mapped archive visible until catalog review completes", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "partial-review-disc",
      volumeLabel: "PARTIAL_REVIEW",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Partial Review.iso",
      fingerprint: "partial-review-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Partial Review",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });

    expect(readDashboardSnapshot(access, { activityLimit: 20 }).catalogReview)
      .toEqual({
        status: "loaded",
        items: [expect.objectContaining({ id: archive.id })],
      });

    completeCatalogReview(access, archive.id);
    expect(readDashboardSnapshot(access, { activityLimit: 20 }).catalogReview)
      .toEqual({ status: "loaded", items: [] });
  });

  it("shows imported legacy catalog review and Encode Job state", () => {
    const libraryRoot = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-import-"));
    const originalsLibraryPath = join(libraryRoot, "originals");
    mkdirSync(originalsLibraryPath, { recursive: true });
    const databasePath = join(libraryRoot, "dashboard.sqlite");
    const access = createDataAccess({ databasePath });
    const importer = createLegacySidecarDataAccess({ databasePath });
    try {
      const queuedArchivePath = join(originalsLibraryPath, "Queued Movie.iso");
      const reviewArchivePath = join(originalsLibraryPath, "Review Movie.iso");
      writeFileSync(queuedArchivePath, "queued archive");
      writeFileSync(reviewArchivePath, "review archive");
      writeFileSync(
        join(originalsLibraryPath, "Queued Movie.rip-dvd.json"),
        JSON.stringify({
          schema_version: 2,
          source: queuedArchivePath,
          title: "Queued Movie",
          year: "2004",
          disc_fingerprint: "queued-movie-import",
          jobs: [
            {
              label: "Movie: Queued Movie",
              source: queuedArchivePath,
              output: join(libraryRoot, "movies", "Queued Movie.mkv"),
              preset: "Fast 480p30",
              selection: "main_feature",
              title_number: null,
            },
          ],
        }),
      );
      writeFileSync(
        join(originalsLibraryPath, "Review Movie.rip-dvd.json"),
        JSON.stringify({
          schema_version: 2,
          source: reviewArchivePath,
          title: "Review Movie",
          disc_fingerprint: "review-movie-import",
          jobs: [],
        }),
      );
      importer.legacySidecars.importLibrary({ originalsLibraryPath });

      const dashboard = readDashboardSnapshot(access);

      expect(dashboard.encodeJobs).toEqual({
        status: "loaded",
        items: [
          expect.objectContaining({
            mediaTitle: "Queued Movie",
            mediaYear: 2004,
            encodingProfileName: "Fast 480p30 · Version 1",
            status: "queued",
          }),
        ],
      });
      expect(dashboard.catalogReview).toEqual({
        status: "loaded",
        items: [expect.objectContaining({ discLabel: "Review Movie" })],
      });
    } finally {
      importer.close();
      access.close();
      rmSync(libraryRoot, { force: true, recursive: true });
    }
  });

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
      fingerprint:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
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
    access.archiveRequests.create({ detectedDiscId: waitingDisc.id, priority: 10 });

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
      sourceIdentity: { kind: "main_feature" },
      label: "Main feature",
    });
    completeCatalogReview(access, catalogedArchive.id);
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
      "HandBrake failed while reading '/private/media/secret file.iso': output /media/movies/partial.mkv",
    );

    access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "dashboard-inspection",
    });
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
          fingerprint:
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
        }),
      ]),
    });
    expect(dashboard.archiveJobs).toEqual({ status: "loaded", items: [] });
    expect(dashboard.detectedDiscs.status === "loaded" &&
      dashboard.detectedDiscs.items.find((disc) => disc.volumeLabel === "WAITING_DISC")
        ?.archiveRequest).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(dashboard.encodeJobs).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          mediaTitle: "The Example",
          mediaYear: 2001,
          encodingProfileName: "DVD library · Version 1",
          status: "failed",
          failureDetail: "The worker could not read its input.",
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
    expect(JSON.stringify(dashboard)).not.toContain("secret file.iso");
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

  it("collapses completed inspection detail only after its Archive Request is fulfilled", () => {
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
      fingerprint: "completed-inspection-disc",
      volumeLabel: "COMPLETED_INSPECTION",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const inspection = completeDiscInspection(
      access,
      disc,
      "completed-inspection-generation",
    );
    access.archiveRequests.create({ detectedDiscId: disc.id });

    const beforeArchive = readDashboardSnapshot(access);
    expect(beforeArchive.opticalDrives).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          currentInspection: expect.objectContaining({
            id: inspection.id,
            status: "completed",
            archiveWorkFulfilled: false,
          }),
        }),
      ],
    });

    const job = access.archiveJobs.startForInspection(inspection.id, "worker-1")!;
    access.archiveJobs.publish(job, {
      archivePath: "/media/originals/completed-inspection.iso",
      sizeBytes: 9,
    });

    const afterArchive = readDashboardSnapshot(access);
    expect(afterArchive.opticalDrives).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          currentInspection: expect.objectContaining({
            id: inspection.id,
            archiveWorkFulfilled: true,
          }),
        }),
      ],
    });
  });

  it("keeps each displayed request linked to its latest attempt across activity bounds", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const seedFailure = (fingerprint: string, message: string) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel: fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const inspection = completeDiscInspection(
        access,
        disc,
        `${fingerprint}-generation`,
      );
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const job = access.archiveJobs.startForInspection(
        inspection.id,
        `${fingerprint}-worker`,
      )!;
      access.archiveJobs.fail(job, message);
      return { disc, request };
    };
    const older = seedFailure("OLDER_FAILURE", "older attempt failed");
    seedFailure("NEWER_FAILURE", "newer attempt failed");

    const snapshot = readDashboardSnapshot(access, { activityLimit: 1 });
    expect(snapshot.detectedDiscs.status).toBe("loaded");
    const olderDisc = snapshot.detectedDiscs.status === "loaded"
      ? snapshot.detectedDiscs.items.find((disc) => disc.id === older.disc.id)
      : undefined;
    expect(olderDisc?.archiveRequest).toMatchObject({
      id: older.request.id,
      attemptCount: 1,
      latestFailureDetail: expect.any(String),
      status: "needs_attention",
    });
  });

  it("keeps a failed duplicate Archive Job visible but projects it as non-retryable", () => {
    const access = dataAccessFixture.create();
    const fixture = seedFailedArchiveJobAndQueuedDuplicate(
      access,
      "dashboard-superseded-archive-job",
    );

    expect(readDashboardSnapshot(access).archiveJobs).toEqual({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.failedJob.id,
          status: "failed",
          failureDetail: "The worker could not read its input.",
        }),
      ]),
    });
    const publishedJob = fixture.publishDuplicate();

    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        id: fixture.failedJob.id,
        detectedDiscId: fixture.failedDisc.id,
        errorMessage: "disc read failed",
      }),
    ]);
    expect(readDashboardSnapshot(access).archiveJobs).toEqual({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.failedJob.id,
          discLabel: "FAILED_DUPLICATE",
          status: "failed",
          failureDetail: "The worker could not read its input.",
        }),
        expect.objectContaining({
          id: publishedJob.id,
          status: "completed",
        }),
      ]),
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
    const request = writer.archiveRequests.create({ detectedDiscId: disc.id });
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
    expect(dashboard.archiveJobs).toEqual({ status: "loaded", items: [] });
    expect(dashboard.detectedDiscs).toEqual({
      status: "loaded",
      items: [expect.objectContaining({
        id: disc.id,
        archiveRequest: expect.objectContaining({ id: request.id, status: "pending" }),
      })],
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
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });
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
    access.archiveRequests.create({ detectedDiscId: disc.id });

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
    access.archiveRequests.create({ detectedDiscId: disc.id });

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

  it("keeps Catalog Review available when Encode Job selection enrichment fails", () => {
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
    expect(dashboard.catalogReview).toEqual({ status: "loaded", items: [] });
    expect(dashboard.opticalDrives.status).toBe("loaded");
    expect(dashboard.detectedDiscs.status).toBe("loaded");
    expect(dashboard.archiveJobs.status).toBe("loaded");
  });
});
