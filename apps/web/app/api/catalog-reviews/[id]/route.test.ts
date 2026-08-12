import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  type MediaItem,
  type MediaItemId,
} from "@rip-dvd/data-access";

import {
  completeCatalogReview,
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../../../../test/data-access-fixture";
import { createCatalogReviewRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

describe("Catalog Review API", () => {
  it("returns an archived DVD's raw title map separately from reviewed catalog data", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"e".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EPISODE_DISC",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Episode Disc.iso",
      fingerprint: contentId,
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      catalogRevision: archive.updatedAt.toISOString(),
      archive: {
        id: archive.id,
        discLabel: "EPISODE_DISC",
        discKind: "dvd",
        archiveFormat: "iso",
        archivedAt: archive.archivedAt.toISOString(),
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
      },
      reviewOutcome: "needs_review",
      rawScan: {
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
      coverage: {
        discSelectionCount: 0,
        mediaItemsWithSelections: 0,
        mappedTitles: 0,
        partiallyMappedTitles: 0,
        unmappedTitles: 1,
        mainFeatureSelections: 0,
        titles: [{
          titleNumber: 1,
          status: "unmapped",
          hasOverlap: false,
        }],
      },
      mediaItems: [],
      discSelections: [],
      discSelectionsPage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
    });
  });

  it.each([
    "?selectionOffset=-1",
    "?selectionOffset=1&selectionOffset=2",
    "?mediaOffset=0",
    "?editingMediaItemId=unrelated-item",
  ])("fails closed on malformed review query input: %s", async (query) => {
    const getAccess = vi.fn();
    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/archive-1${query}`),
      "archive-1",
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getAccess).not.toHaveBeenCalled();
  });

  it("limits the main hierarchy to mapped Media Items and their ancestors", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"7".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Scoped Hierarchy.iso",
      fingerprint: contentId,
    });
    const unrelated = access.catalog.createMediaItem({
      kind: "movie",
      title: "Unrelated global item",
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Mapped Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Mapped Season",
      seasonNumber: 1,
    });
    const episode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Mapped Episode",
      episodeNumber: 1,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const review = await response.json();
    const reviewMediaItemIds = review.mediaItems.map(
      (item: MediaItem) => item.id,
    );
    expect(reviewMediaItemIds).toHaveLength(3);
    expect(reviewMediaItemIds).toEqual(expect.arrayContaining([
      show.id,
      season.id,
      episode.id,
    ]));
    expect(reviewMediaItemIds).not.toContain(unrelated.id);
  });

  it("completes Archive-only Review explicitly and rejects stale or contradictory outcomes", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "route-archive-only-review",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Route Archive Only.iso",
      fingerprint: "route-archive-only-review",
    });
    const getReview = async () => {
      const response = await createCatalogReviewRoute(
        new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
        archive.id,
        () => access,
        () => "http://localhost:3000",
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const mutate = (body: unknown) => createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    const pending = await getReview();
    expect(pending.reviewOutcome).toBe("needs_review");
    const contradictorySelections = await mutate({
      action: "complete_review",
      catalogRevision: pending.catalogRevision,
      outcome: "reviewed_with_selections",
    });
    expect(contradictorySelections.status).toBe(409);
    await expect(contradictorySelections.json()).resolves.toEqual({
      error: "Catalog review requires at least one Disc Selection",
    });

    const completed = await mutate({
      action: "complete_review",
      catalogRevision: pending.catalogRevision,
      outcome: "archive_only",
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      archive: {
        id: archive.id,
        catalogReviewedAt: expect.any(String),
        catalogReviewOutcome: "archive_only",
      },
    });
    expect((await getReview()).reviewOutcome).toBe("archive_only");

    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Review Reopened",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const reopened = await getReview();
    expect(reopened).toMatchObject({
      reviewOutcome: "needs_review",
      archive: {
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
      },
    });
    expect(reopened.catalogRevision).not.toBe(pending.catalogRevision);

    const staleCompletion = await mutate({
      action: "complete_review",
      catalogRevision: pending.catalogRevision,
      outcome: "archive_only",
    });
    expect(staleCompletion.status).toBe(409);
    expect((await getReview()).reviewOutcome).toBe("needs_review");
    const currentArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;
    const activeSelectionContradiction = await mutate({
      action: "complete_review",
      catalogRevision: currentArchive.updatedAt.toISOString(),
      outcome: "archive_only",
    });
    expect(activeSelectionContradiction.status).toBe(409);
    await expect(activeSelectionContradiction.json()).resolves.toEqual({
      error: "Archive-only Review cannot contain Disc Selections",
    });
  });

  it("offers direct actions for a job-free selection unless legacy cutover repair blocks mutation", async () => {
    const { access, databasePath } =
      dataAccessFixture.createWithDatabasePath();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"1".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Editable Selection.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Editable Selection",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      label: "Original label",
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.discSelections).toEqual([
      expect.objectContaining({
        id: selection.id,
        actionAvailability: {
          state: "editable",
          availableActions: ["correct", "edit_label", "remove"],
          reason: null,
          relatedEncodeJob: null,
        },
      }),
    ]);

    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update original_disc_archives
      set legacy_cutover_pending = 1
      where id = ?
    `).run(archive.id);
    sqlite.close();

    const cutoverResponse = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(cutoverResponse.status).toBe(200);
    const cutoverBody = await cutoverResponse.json();
    expect(cutoverBody.discSelections).toEqual([
      expect.objectContaining({
        id: selection.id,
        actionAvailability: {
          state: "changes_unavailable",
          availableActions: [],
          reason:
            "Disc Selection changes are unavailable while legacy cutover repair is pending",
          relatedEncodeJob: null,
        },
      }),
    ]);
  });

  it("locks ordinary Encode Job provenance and identifies active dependency states without exposing paths", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"2".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: Array.from({ length: 4 }, (_, index) => ({
          number: index + 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Locked Selections.iso",
      fingerprint: contentId,
    });
    const selections = Array.from({ length: 4 }, (_, index) => {
      const item = access.catalog.createMediaItem({
        kind: "bonus_feature",
        title: `Locked Selection ${index + 1}`,
      });
      return access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: index + 1 },
      });
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "locked-selections",
      displayName: "Locked selections",
      mediaDomain: "dvd_video",
      settings: {},
    });
    access.encodeJobs.enqueue({
      discSelectionId: selections[0]!.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Completed provenance.mkv",
    });
    const completedClaim = access.encodeJobs.claimNext("completed-worker");
    if (!completedClaim) {
      throw new Error("Expected completed Encode Job claim");
    }
    const completedJob = access.encodeJobs.complete(completedClaim);
    access.encodeJobs.enqueue({
      discSelectionId: selections[1]!.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Failed provenance.mkv",
    });
    const failedClaim = access.encodeJobs.claimNext("failed-worker");
    if (!failedClaim) {
      throw new Error("Expected failed Encode Job claim");
    }
    const failedJob = access.encodeJobs.fail(
      failedClaim,
      "expected test failure",
    );
    access.encodeJobs.enqueue({
      discSelectionId: selections[2]!.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Running provenance.mkv",
    });
    const runningClaim = access.encodeJobs.claimNext("running-worker");
    if (!runningClaim) {
      throw new Error("Expected running Encode Job claim");
    }
    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: selections[3]!.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Queued provenance.mkv",
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const availabilityBySelection = new Map(
      body.discSelections.map((selection: {
        id: string;
        actionAvailability: unknown;
      }) => [selection.id, selection.actionAvailability]),
    );
    for (const [selection, job] of [
      [selections[0]!, completedJob],
      [selections[1]!, failedJob],
      [selections[2]!, runningClaim],
      [selections[3]!, queuedJob],
    ] as const) {
      expect(availabilityBySelection.get(selection.id)).toMatchObject({
        state: "locked_provenance",
        availableActions: [],
        reason: expect.stringContaining(job.status),
        relatedEncodeJob: { id: job.id, status: job.status },
      });
    }
    expect(JSON.stringify([...availabilityBySelection.values()]))
      .not.toContain("/media/");
  });

  it("exposes only repair and removal for unsafe legacy selections while retaining quarantine provenance", async () => {
    const { access, databasePath } =
      dataAccessFixture.createWithDatabasePath();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"4".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Legacy Recovery.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Legacy Recovery",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    const queuedMovie = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Legacy Recovery queued dependency",
    });
    const queuedSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: queuedMovie.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 1,
      },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "legacy-recovery",
      displayName: "Legacy recovery",
      mediaDomain: "dvd_video",
      settings: {},
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Legacy Recovery.mkv",
    });
    const claim = access.encodeJobs.claimNext("legacy-recovery-worker");
    if (!claim) {
      throw new Error("Expected legacy recovery Encode Job claim");
    }
    const completedJob = access.encodeJobs.complete(claim);
    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: queuedSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Legacy Recovery queued.mkv",
    });
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update disc_selections
      set source_key = 'caller:title-one'
      where id = ?
    `).run(selection.id);
    sqlite.prepare(`
      update disc_selections
      set source_key = 'caller:title-one-chapter-one'
      where id = ?
    `).run(queuedSelection.id);
    sqlite.close();

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.discSelections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: selection.id,
        actionAvailability: {
          state: "needs_repair",
          availableActions: ["repair", "remove"],
          reason:
            "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review",
          relatedEncodeJob: null,
        },
      }),
      expect.objectContaining({
        id: queuedSelection.id,
        actionAvailability: {
          state: "needs_repair",
          availableActions: [],
          reason: expect.stringContaining("is queued"),
          relatedEncodeJob: { id: queuedJob.id, status: "queued" },
        },
      }),
    ]));

    const repairResponse = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "repair_disc_selection",
          discSelectionId: selection.id,
          selection: {
            mediaItemId: movie.id,
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
          },
        }),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(repairResponse.status).toBe(200);
    const repaired = (await repairResponse.json()).discSelection;
    expect(repaired.id).not.toBe(selection.id);
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([expect.objectContaining({ id: selection.id })]);
    expect(access.encodeJobs.list(["completed"]))
      .toEqual([expect.objectContaining({
        id: completedJob.id,
        discSelectionId: selection.id,
      })]);
  });

  it("returns bounded archived legacy title evidence for catalog review", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "legacy-review-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Legacy Review.iso",
      fingerprint: "legacy-review-disc",
    });
    const legacyAccess = withSnapshotOverrides(access, {
      catalog: {
        listDetectedDiscs: () => [{
          ...disc,
          status: "archived",
          scanData: {
            legacySchemaVersion: 2,
            titles: [{
              number: 1,
              seconds: 5_400,
              chapters: 8,
              audio_streams: 2,
              subtitles: 1,
            }],
          },
        }],
      },
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => legacyAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rawScan.titles).toEqual([
      expect.objectContaining({
        number: 1,
        durationSeconds: 5_400,
        chapters: 8,
        audioStreams: [{ id: 0 }, { id: 1 }],
        subtitles: [{ id: 0 }],
      }),
    ]);
  });

  it("rejects stale review completion until the client reloads the catalog revision", async () => {
    const [firstClient, secondClient] = dataAccessFixture.createPair();
    const drive = firstClient.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const disc = firstClient.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    firstClient.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    firstClient.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = firstClient.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Stale Catalog Review.iso",
      fingerprint: contentId,
    });
    const movie = firstClient.catalog.createMediaItem({
      kind: "movie",
      title: "Stale Catalog Review",
    });
    firstClient.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const getReview = async (client: typeof firstClient) => {
      const response = await createCatalogReviewRoute(
        new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
        archive.id,
        () => client,
        () => "http://localhost:3000",
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const mutate = (client: typeof firstClient, body: unknown) =>
      createCatalogReviewRoute(
        new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify(body),
        }),
        archive.id,
        () => client,
        () => "http://localhost:3000",
      );

    const staleReview = await getReview(firstClient);
    await getReview(secondClient);
    const missingRevision = await mutate(firstClient, {
      action: "complete_review",
    });
    expect(missingRevision.status).toBe(400);
    await expect(missingRevision.json()).resolves.toEqual({
      error: "Invalid catalog review revision",
    });
    expect((await mutate(secondClient, {
      action: "create_disc_selection",
      selection: {
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    })).status).toBe(201);

    const staleCompletion = await mutate(firstClient, {
      action: "complete_review",
      catalogRevision: staleReview.catalogRevision,
      outcome: "reviewed_with_selections",
    });
    expect(staleCompletion.status).toBe(409);
    await expect(staleCompletion.json()).resolves.toEqual({
      error: "Catalog review changed; reload before completing review",
    });
    expect(firstClient.catalog.listOriginalDiscArchives({ ids: [archive.id] }))
      .toEqual([expect.objectContaining({ catalogReviewedAt: null })]);

    const currentReview = await getReview(firstClient);
    expect(currentReview.catalogRevision).not.toBe(staleReview.catalogRevision);
    expect((await mutate(firstClient, {
      action: "complete_review",
      catalogRevision: currentReview.catalogRevision,
      outcome: "reviewed_with_selections",
    })).status).toBe(200);
    expect(firstClient.catalog.listOriginalDiscArchives({ ids: [archive.id] }))
      .toEqual([expect.objectContaining({ catalogReviewedAt: expect.any(Date) })]);
  });

  it("does not leak a large unrelated Media Item catalog into review", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "large-media-catalog",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Large Catalog.iso",
      fingerprint: "large-media-catalog",
    });
    for (let index = 0; index < 501; index += 1) {
      access.catalog.createMediaItem({
        kind: "movie",
        title: `Catalog Movie ${index}`,
      });
    }

    const response = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mediaItems: [] });
  });

  it("fails closed for an over-depth mapped ancestor chain", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "deep-hierarchy",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Deep Hierarchy.iso",
      fingerprint: "deep-hierarchy",
    });
    const mappedItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Mapped deep leaf",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mappedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const timestamp = new Date("2026-08-03T20:00:00.000Z");
    const items: MediaItem[] = Array.from({
      length: MAX_MEDIA_ITEM_HIERARCHY_DEPTH + 1,
    }, (_, index) => ({
      id: index === MAX_MEDIA_ITEM_HIERARCHY_DEPTH
        ? mappedItem.id
        : `deep-${index}` as MediaItemId,
      parentId: index === 0 ? null : `deep-${index - 1}` as MediaItemId,
      kind: "movie",
      title: `Deep item ${index}`,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const withDeepHierarchy = withSnapshotOverrides(access, {
      catalog: {
        listMediaItems(options) {
          if (options?.ids) {
            const ids = new Set(options.ids);
            return items.filter((item) => ids.has(item.id));
          }
          return [];
        },
      },
    });

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => withDeepHierarchy,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Media Item hierarchy exceeds the supported depth",
    });
  });

  it("pages more than 500 valid Disc Selections without blocking review", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"b".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: Array.from({ length: 501 }, (_, index) => ({
          number: index + 1,
          durationSeconds: 60,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Many Selections.iso",
      fingerprint: contentId,
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Disc feature",
    });
    for (let titleNumber = 1; titleNumber <= 501; titleNumber += 1) {
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber },
      });
    }

    const firstResponse = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.discSelections).toHaveLength(100);
    expect(first.discSelectionsPage).toEqual({
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: true,
    });
    expect(first.coverage).toMatchObject({
      discSelectionCount: 501,
      mediaItemsWithSelections: 1,
      mappedTitles: 501,
      partiallyMappedTitles: 0,
      unmappedTitles: 0,
      mainFeatureSelections: 0,
    });
    expect(first.coverage.titles).toHaveLength(501);

    const lastResponse = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}?selectionOffset=500`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(lastResponse.status).toBe(200);
    const last = await lastResponse.json();
    expect(last.discSelections).toHaveLength(1);
    expect(last.discSelectionsPage).toEqual({
      offset: 500,
      limit: 100,
      hasPrevious: true,
      hasNext: false,
    });
    expect(last.coverage).toEqual(first.coverage);
  });

  it("bounds maintenance reads for a full selection page plus ancestors", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"6".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: Array.from({ length: 101 }, (_, index) => ({
          number: index + 1,
          durationSeconds: 60,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Many Items.iso",
      fingerprint: contentId,
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Many Items Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Many Items Season",
      seasonNumber: 1,
    });
    const episodes = Array.from({ length: 101 }, (_, index) =>
      access.catalog.createMediaItem({
        parentId: season.id,
        kind: "episode",
        title: `Many Items Episode ${index + 1}`,
        episodeNumber: index + 1,
      }));
    episodes.forEach((episode, index) =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: episode.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: index + 1 },
      }));

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(200);
    const review = await response.json();
    expect(review.discSelections).toHaveLength(100);
    expect(review.mediaItems).toHaveLength(102);
    expect(review.mediaItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: show.id }),
      expect.objectContaining({ id: season.id }),
    ]));
    expect(review.discSelectionsPage.hasNext).toBe(true);
  });

  it("reports preserved completed Encode Job history when selection removal is refused", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"c".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Preserved History.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Preserved History",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "preserved-history",
      displayName: "Preserved history",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Preserved History.mkv",
    });
    const claim = access.encodeJobs.claimNext("preserved-history-worker");
    if (!claim) {
      throw new Error("Expected Encode Job claim");
    }
    access.encodeJobs.complete(claim);

    const response = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "delete_disc_selection",
          discSelectionId: selection.id,
        }),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        `Disc Selection ${selection.id} cannot be deleted because Encode Job history must be preserved (job ${job.id})`,
    });
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toHaveLength(1);
    expect(access.encodeJobs.list(["completed"])).toEqual([
      expect.objectContaining({
        id: job.id,
        discSelectionId: selection.id,
      }),
    ]);
  });

  it("creates a new Media Item and exact-title Disc Selection through one Mapping Proposal mutation", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"9".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "ROUTE_PROPOSAL_DISC_2",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [4, 5].map((number) => ({
          number,
          durationSeconds: 600,
          chapters: 6,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Route Proposal.iso",
      fingerprint: contentId,
    });
    const mutation = (body: unknown) => createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    const exactTitleMatch = access.catalog.createMediaItem({
      kind: "movie",
      title: "Route Proposal Disc 2",
    });

    const response = await mutation({
      action: "create_mapping_proposal",
      catalogRevision: archive.updatedAt.toISOString(),
      target: {
        choice: "create_new",
        mediaItem: {
          kind: "bonus_feature",
          title: "Route Proposal Disc 2",
        },
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
        label: "Deleted scene",
      },
    });

    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      message: "Mapping changed; review required",
      mediaItem: expect.objectContaining({
        kind: "bonus_feature",
        title: "Route Proposal Disc 2",
      }),
      discSelection: expect.objectContaining({
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
        label: "Deleted scene",
      }),
    });
    expect(access.catalog.listMediaItems()).toHaveLength(2);
    expect(responseBody.mediaItem.id).not.toBe(exactTitleMatch.id);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(1);

    const reuseResponse = await mutation({
      action: "create_mapping_proposal",
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      target: {
        choice: "use_existing",
        mediaItemId: exactTitleMatch.id,
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
      },
    });
    expect(reuseResponse.status).toBe(201);
    await expect(reuseResponse.json()).resolves.toEqual({
      message: "Mapping changed; review required",
      mediaItem: expect.objectContaining({ id: exactTitleMatch.id }),
      discSelection: expect.objectContaining({
        mediaItemId: exactTitleMatch.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
      }),
    });
    expect(access.catalog.listMediaItems()).toHaveLength(2);

    const staleResponse = await mutation({
      action: "create_mapping_proposal",
      catalogRevision: archive.updatedAt.toISOString(),
      target: {
        choice: "create_new",
        mediaItem: { kind: "movie", title: "Orphaned stale item" },
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
      },
    });
    expect(staleResponse.status).toBe(409);
    expect(access.catalog.listMediaItems()).toHaveLength(2);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(2);
  });

  it("warns about shared metadata edits without reopening reviews and blocks unsafe deletion", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const sharedItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Shared title",
    });
    const correctedParent = access.catalog.createMediaItem({
      kind: "other",
      title: "Corrected hierarchy parent",
    });
    const archives = ["first", "second"].map((suffix) => {
      const fingerprint = `shared-route-${suffix}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel: `SHARED_${suffix.toUpperCase()}`,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/sensitive/originals/${suffix}.iso`,
        fingerprint,
      });
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: sharedItem.id,
        sourceIdentity: { kind: "main_feature" },
      });
      completeCatalogReview(access, archive.id);
      return archive;
    });
    const mutation = (body: unknown) => createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archives[0]!.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify(body),
        },
      ),
      archives[0]!.id,
      () => access,
      () => "http://localhost:3000",
    );

    const readResponse = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archives[0]!.id}`,
      ),
      archives[0]!.id,
      () => access,
      () => "http://localhost:3000",
    );
    const review = await readResponse.json();
    expect(review.mediaItems).toEqual([expect.objectContaining({
      id: sharedItem.id,
      maintenance: {
        childCount: 0,
        discSelectionReferenceCount: 2,
        referencedArchiveCount: 2,
        otherArchiveCount: 1,
        deletionAvailability: {
          state: "unavailable",
          reason: "2 Disc Selection references",
        },
      },
    })]);

    const updateResponse = await mutation({
      action: "update_media_item",
      mediaItemId: sharedItem.id,
      changes: {
        parentId: correctedParent.id,
        title: "Corrected shared title",
      },
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      message: "Metadata saved",
      mediaItem: {
        id: sharedItem.id,
        parentId: correctedParent.id,
        title: "Corrected shared title",
      },
    });
    expect(archives.map((archive) =>
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .catalogReviewedAt
    )).toEqual([expect.any(Date), expect.any(Date)]);

    const deleteResponse = await mutation({
      action: "delete_media_item",
      mediaItemId: sharedItem.id,
    });
    expect(deleteResponse.status).toBe(409);
    const deleteBody = await deleteResponse.json();
    expect(deleteBody).toEqual({
      error:
        "Media Item deletion is unavailable: 2 Disc Selection references",
    });
    expect(JSON.stringify(deleteBody)).not.toContain("/sensitive/");
    expect(access.catalog.listMediaItems({ ids: [sharedItem.id] }))
      .toHaveLength(1);
  });

  it("rolls back a job-free Assisted Mapping by removing its selection and unused leaf item", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "job-free-route-rollback",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Job-free rollback.iso",
      fingerprint: "job-free-route-rollback",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Mistaken mapping",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const mutate = (body: unknown) => createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    const removeSelectionResponse = await mutate({
      action: "delete_disc_selection",
      discSelectionId: selection.id,
    });
    expect(removeSelectionResponse.status).toBe(200);
    await expect(removeSelectionResponse.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
      discSelection: { id: selection.id },
    });
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
      .catalogReviewedAt).toBeNull();

    const deleteItemResponse = await mutate({
      action: "delete_media_item",
      mediaItemId: item.id,
    });
    expect(deleteItemResponse.status).toBe(200);
    await expect(deleteItemResponse.json()).resolves.toMatchObject({
      message: "Media Item deleted",
      mediaItem: { id: item.id },
    });
    expect(access.catalog.listMediaItems({ ids: [item.id] })).toEqual([]);
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([]);
  });

  it("commits an episodic hierarchy and its whole-title Disc Selections atomically", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"8".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EPISODIC_ROUTE",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [3, 5, 8].map((number) => ({
          number,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Episodic Route.iso",
      fingerprint: contentId,
    });

    const mutate = (body: unknown) => createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    const validProposal = {
      action: "create_episodic_mapping_proposal",
      catalogRevision: archive.updatedAt.toISOString(),
      tvShow: {
        choice: "create_new",
        title: "Route Show",
        year: 2004,
      },
      season: {
        choice: "create_new",
        title: "Route Show Season 2",
        seasonNumber: 2,
      },
      episodes: [
        { titleNumber: 3, title: "Third", episodeNumber: 5 },
        { titleNumber: 5, title: "Fifth", episodeNumber: 7 },
        { titleNumber: 8, title: "Eighth", episodeNumber: 6 },
      ],
    };
    const failed = await mutate({
      ...validProposal,
      episodes: [
        validProposal.episodes[0],
        { titleNumber: 99, title: "Missing source", episodeNumber: 6 },
      ],
    });
    expect(failed.status).toBe(409);
    expect(access.catalog.listMediaItems()).toEqual([]);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([]);

    const response = await mutate(validProposal);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: "Mapping changed; review required",
      tvShow: { kind: "tv_show", title: "Route Show" },
      season: { kind: "season", seasonNumber: 2 },
      episodes: [
        {
          mediaItem: { title: "Third", episodeNumber: 5 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
          },
        },
        {
          mediaItem: { title: "Fifth", episodeNumber: 7 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
          },
        },
        {
          mediaItem: { title: "Eighth", episodeNumber: 6 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 8 },
          },
        },
      ],
    });
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(3);
  });

  it("creates and edits nested Media Items, maps episode ranges, and completes review", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"f".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "TWO_EPISODES",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
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
      archivePath: "/media/originals/Two Episodes.iso",
      fingerprint: contentId,
    });
    const mutate = async (body: unknown) =>
      createCatalogReviewRoute(
        new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: "localhost:3000",
            Origin: "http://localhost:3000",
          },
          body: JSON.stringify(body),
        }),
        archive.id,
        () => access,
        () => "http://localhost:3000",
      );

    const invalidMissingRepair = await mutate({
      action: "repair_disc_selection",
      discSelectionId: "missing-selection",
      selection: { kind: "main_feature" },
    });
    expect(invalidMissingRepair.status).toBe(404);
    await expect(invalidMissingRepair.json()).resolves.toEqual({
      error: "Disc Selection not found",
    });

    const showResponse = await mutate({
      action: "create_media_item",
      mediaItem: { parentId: null, kind: "tv_show", title: "Chapter Show" },
    });
    expect(showResponse.status).toBe(201);
    const show = (await showResponse.json()).mediaItem;
    const localItemResponse = await mutate({
      action: "create_media_item",
      mediaItem: { parentId: null, kind: "other", title: "Local Recording" },
    });
    expect(localItemResponse.status).toBe(201);
    const localItemBody = await localItemResponse.json();
    expect(localItemBody).toEqual({
      message: "Media Item created",
      mediaItem: expect.objectContaining({
        kind: "other",
        title: "Local Recording",
      }),
    });
    const seasonResponse = await mutate({
      action: "create_media_item",
      mediaItem: {
        parentId: show.id,
        kind: "season",
        title: "Season 1",
        seasonNumber: 1,
      },
    });
    const season = (await seasonResponse.json()).mediaItem;
    const firstEpisodeResponse = await mutate({
      action: "create_media_item",
      mediaItem: {
        parentId: season.id,
        kind: "episode",
        title: "Episode One",
        episodeNumber: 1,
      },
    });
    const firstEpisode = (await firstEpisodeResponse.json()).mediaItem;
    const secondEpisodeResponse = await mutate({
      action: "create_media_item",
      mediaItem: {
        parentId: season.id,
        kind: "episode",
        title: "Episode Two (draft)",
        episodeNumber: 2,
      },
    });
    const secondEpisode = (await secondEpisodeResponse.json()).mediaItem;

    const localItemUpdateResponse = await mutate({
      action: "update_media_item",
      mediaItemId: localItemBody.mediaItem.id,
      changes: {
        parentId: show.id,
        kind: "other",
        title: "Edited Local Recording",
        year: 1800,
        seasonNumber: 0,
        episodeNumber: 1,
      },
    });
    expect(localItemUpdateResponse.status).toBe(200);
    await expect(localItemUpdateResponse.json()).resolves.toEqual({
      message: "Metadata saved",
      mediaItem: expect.objectContaining({
        parentId: show.id,
        kind: "other",
        title: "Edited Local Recording",
        year: 1800,
        seasonNumber: 0,
        episodeNumber: 1,
      }),
    });

    const editedResponse = await mutate({
      action: "update_media_item",
      mediaItemId: secondEpisode.id,
      changes: { title: "Episode Two" },
    });
    expect(editedResponse.status).toBe(200);
    await expect(editedResponse.json()).resolves.toEqual({
      message: "Metadata saved",
      mediaItem: expect.objectContaining({
        id: secondEpisode.id,
        parentId: season.id,
        title: "Episode Two",
      }),
    });
    expect((await mutate({
      action: "update_media_item",
      mediaItemId: secondEpisode.id,
      changes: { unsupportedField: "ignored" },
    })).status).toBe(400);

    expect((await mutate({
      action: "create_disc_selection",
      selection: {
        mediaItemId: firstEpisode.id,
        sourceIdentity: { kind: "main_feature", titleNumber: 1 },
      },
    })).status).toBe(400);

    const firstSelectionResponse = await mutate({
      action: "create_disc_selection",
      selection: {
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      },
    });
    expect(firstSelectionResponse.status).toBe(201);
    const firstSelection = (await firstSelectionResponse.json()).discSelection;
    const repairSelectionResponse = await mutate({
      action: "repair_disc_selection",
      discSelectionId: firstSelection.id,
      selection: {
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      },
    });
    expect(repairSelectionResponse.status).toBe(200);
    await expect(repairSelectionResponse.json()).resolves.toEqual({
      message: "Mapping changed; review required",
      discSelection: expect.objectContaining({
        id: firstSelection.id,
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      }),
    });
    expect((await mutate({
      action: "create_disc_selection",
      selection: {
        mediaItemId: secondEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 5,
          chapterEnd: 8,
        },
      },
    })).status).toBe(201);
    expect((await mutate({
      action: "complete_review",
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      outcome: "reviewed_with_selections",
    })).status).toBe(200);
    const deleteResponse = await mutate({
      action: "delete_disc_selection",
      discSelectionId: firstSelection.id,
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      message: "Mapping changed; review required",
      discSelection: expect.objectContaining({ id: firstSelection.id }),
      deletedEncodeJobs: 0,
      deletionComplete: true,
    });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect((await mutate({
      action: "create_disc_selection",
      selection: {
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      },
    })).status).toBe(201);
    expect((await mutate({
      action: "complete_review",
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt.toISOString(),
      outcome: "reviewed_with_selections",
    })).status).toBe(200);

    const reviewed = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    const body = await reviewed.json();
    expect(body.reviewOutcome).toBe("reviewed_with_selections");
    expect(body.archive.catalogReviewedAt).not.toBeNull();
    expect(body.rawScan.titles).toEqual([
      expect.objectContaining({ number: 1, chapters: 8 }),
    ]);
    expect(body.mediaItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: show.id, kind: "tv_show" }),
        expect.objectContaining({ id: season.id, parentId: show.id }),
        expect.objectContaining({ id: firstEpisode.id, parentId: season.id }),
        expect.objectContaining({
          id: secondEpisode.id,
          parentId: season.id,
          title: "Episode Two",
        }),
      ]),
    );
    expect(body.mediaItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: localItemBody.mediaItem.id }),
    ]));
    expect(body.discSelections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaItemId: firstEpisode.id,
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 1,
            chapterStart: 1,
            chapterEnd: 4,
          },
        }),
        expect.objectContaining({
          mediaItemId: secondEpisode.id,
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 1,
            chapterStart: 5,
            chapterEnd: 8,
          },
        }),
      ]),
    );
  });

  it("does not create catalog records for an unknown archive", async () => {
    const access = dataAccessFixture.create();
    const response = await createCatalogReviewRoute(
      new Request("http://localhost:3000/api/catalog-reviews/missing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          action: "create_media_item",
          mediaItem: { kind: "movie", title: "Orphaned Movie" },
        }),
      }),
      "missing",
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(404);
    expect(access.catalog.listMediaItems()).toEqual([]);
  });

  it("rejects cross-origin catalog mutations before opening data access", async () => {
    const getAccess = vi.fn();
    const response = await createCatalogReviewRoute(
      new Request("http://attacker.example/api/catalog-reviews/archive-1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "attacker.example",
          Origin: "http://attacker.example",
        },
        body: JSON.stringify({ action: "complete_review" }),
      }),
      "archive-1",
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });
});
