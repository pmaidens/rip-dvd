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
      },
      reviewStatus: "needs_review",
      rawScan: {
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
      mediaItems: [],
      mediaItemsPage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
        itemIds: [],
      },
      discSelections: [],
      discSelectionsPage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
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
    })).status).toBe(200);
    expect(firstClient.catalog.listOriginalDiscArchives({ ids: [archive.id] }))
      .toEqual([expect.objectContaining({ catalogReviewedAt: expect.any(Date) })]);
  });

  it("pages a large Media Item catalog without blocking review", async () => {
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

    const firstResponse = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json();
    expect(firstPage.mediaItems).toHaveLength(100);
    expect(firstPage.mediaItemsPage).toMatchObject({
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: true,
    });
    expect(firstPage.mediaItemsPage.itemIds).toHaveLength(100);

    const lastResponse = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}?mediaOffset=500`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(lastResponse.status).toBe(200);
    const lastPage = await lastResponse.json();
    expect(lastPage.mediaItems).toHaveLength(1);
    expect(lastPage.mediaItemsPage).toMatchObject({
      offset: 500,
      limit: 100,
      hasPrevious: true,
      hasNext: false,
    });
    expect(lastPage.mediaItemsPage.itemIds).toEqual([
      lastPage.mediaItems[0].id,
    ]);
  });

  it("includes a cross-page parent without making context-only items editable", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cross-page-parent",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cross Page Parent.iso",
      fingerprint: "cross-page-parent",
    });
    const parent = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Parent Show",
    });
    for (let index = 1; index < 100; index += 1) {
      access.catalog.createMediaItem({
        kind: "movie",
        title: `Root Movie ${index}`,
      });
    }
    const child = access.catalog.createMediaItem({
      parentId: parent.id,
      kind: "season",
      title: "Child Season",
      seasonNumber: 1,
    });

    const response = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}?mediaOffset=100`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(200);
    const review = await response.json();
    expect(review.mediaItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, parentId: null }),
        expect.objectContaining({ id: child.id, parentId: parent.id }),
      ]),
    );
    expect(review.mediaItemsPage).toEqual({
      offset: 100,
      limit: 100,
      hasPrevious: true,
      hasNext: false,
      itemIds: [child.id],
    });
  });

  it("hydrates selection targets and complete ancestor context across Media Item pages", async () => {
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
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 1_800,
          chapters: 4,
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
      archivePath: "/media/originals/Selection Context.iso",
      fingerprint: contentId,
    });
    const reparentTarget = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cross-page parent target",
    });
    for (let index = 1; index < 100; index += 1) {
      access.catalog.createMediaItem({
        kind: "movie",
        title: `Page root ${index}`,
      });
    }
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Context Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Context Season",
      seasonNumber: 1,
    });
    const episode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Context Episode",
      episodeNumber: 1,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });

    const response = await createCatalogReviewRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}?mediaOffset=0&editingMediaItemId=${episode.id}`,
      ),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(200);
    const review = await response.json();
    expect(review.mediaItemsPage.itemIds).toHaveLength(100);
    expect(review.mediaItemsPage.itemIds).toContain(reparentTarget.id);
    expect(review.mediaItemsPage.itemIds).not.toContain(episode.id);
    expect(review.mediaItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: show.id, parentId: null }),
        expect.objectContaining({ id: season.id, parentId: show.id }),
        expect.objectContaining({ id: episode.id, parentId: season.id }),
      ]),
    );
    expect(review.discSelections).toEqual([
      expect.objectContaining({ id: selection.id, mediaItemId: episode.id }),
    ]);
  });

  it("fails closed for over-depth page and edit-context ancestor chains", async () => {
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
    const timestamp = new Date("2026-08-03T20:00:00.000Z");
    const items: MediaItem[] = Array.from({
      length: MAX_MEDIA_ITEM_HIERARCHY_DEPTH + 1,
    }, (_, index) => ({
      id: `deep-${index}` as MediaItemId,
      parentId: index === 0 ? null : `deep-${index - 1}` as MediaItemId,
      kind: "movie",
      title: `Deep item ${index}`,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const withDeepHierarchy = (includeLeafOnPage: boolean) =>
      withSnapshotOverrides(access, {
        catalog: {
          listMediaItems(options) {
            if (options?.ids) {
              const ids = new Set(options.ids);
              return items.filter((item) => ids.has(item.id));
            }
            return includeLeafOnPage ? [items.at(-1)!] : [];
          },
        },
      });

    const responses = await Promise.all([
      createCatalogReviewRoute(
        new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
        archive.id,
        () => withDeepHierarchy(true),
        () => "http://localhost:3000",
      ),
      createCatalogReviewRoute(
        new Request(
          `http://localhost:3000/api/catalog-reviews/${archive.id}?editingMediaItemId=${items.at(-1)!.id}`,
        ),
        archive.id,
        () => withDeepHierarchy(false),
        () => "http://localhost:3000",
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Media Item hierarchy exceeds the supported depth",
      });
    }
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
        titles: [{
          number: 4,
          durationSeconds: 600,
          chapters: 6,
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

    const response = await mutation({
      action: "create_mapping_proposal",
      catalogRevision: archive.updatedAt.toISOString(),
      mediaItem: {
        kind: "bonus_feature",
        title: "Route Proposal Disc 2",
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
        label: "Deleted scene",
      },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      mediaItem: expect.objectContaining({
        kind: "bonus_feature",
        title: "Route Proposal Disc 2",
      }),
      discSelection: expect.objectContaining({
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
        label: "Deleted scene",
      }),
    });
    expect(access.catalog.listMediaItems()).toHaveLength(1);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(1);

    const staleResponse = await mutation({
      action: "create_mapping_proposal",
      catalogRevision: archive.updatedAt.toISOString(),
      mediaItem: { kind: "movie", title: "Orphaned stale item" },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
      },
    });
    expect(staleResponse.status).toBe(409);
    expect(access.catalog.listMediaItems()).toHaveLength(1);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(1);
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
    })).status).toBe(200);
    const deleteResponse = await mutate({
      action: "delete_disc_selection",
      discSelectionId: firstSelection.id,
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
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
    })).status).toBe(200);

    const reviewed = await createCatalogReviewRoute(
      new Request(`http://localhost:3000/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => "http://localhost:3000",
    );
    const body = await reviewed.json();
    expect(body.reviewStatus).toBe("reviewed");
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
          parentId: show.id,
          kind: "other",
          title: "Edited Local Recording",
          year: 1800,
          seasonNumber: 0,
          episodeNumber: 1,
        }),
        expect.objectContaining({
          id: secondEpisode.id,
          parentId: season.id,
          title: "Episode Two",
        }),
      ]),
    );
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
