import { describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  type MediaItem,
  type MediaItemId,
} from "@rip-dvd/data-access";

import {
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
      kind: "dvd_title",
      titleNumber: 1,
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
        kind: "dvd_title",
        titleNumber,
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

    const showResponse = await mutate({
      action: "create_media_item",
      mediaItem: { parentId: null, kind: "tv_show", title: "Chapter Show" },
    });
    expect(showResponse.status).toBe(201);
    const show = (await showResponse.json()).mediaItem;
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
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
    })).status).toBe(201);
    expect((await mutate({
      action: "create_disc_selection",
      selection: {
        mediaItemId: secondEpisode.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 5,
        chapterEnd: 8,
      },
    })).status).toBe(201);
    expect((await mutate({ action: "complete_review" })).status).toBe(200);

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
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        }),
        expect.objectContaining({
          mediaItemId: secondEpisode.id,
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 5,
          chapterEnd: 8,
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
