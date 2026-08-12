import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataAccess } from "@rip-dvd/data-access";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pollArchiveWorker,
  type OpticalDriveHardware,
} from "../../archive-worker/src/archive-worker.js";
import type { DvdCopyRunner } from "../../archive-worker/src/dvd-archiver.js";
import {
  pollEncodeWorker,
  type HandBrakeRunner,
} from "../../encode-worker/src/encode-worker.js";
import { createArchiveRequestsRoute } from "../app/api/archive-requests/route";
import { createCatalogReviewRoute } from "../app/api/catalog-reviews/[id]/route";
import { createMediaItemSearchRoute } from "../app/api/media-items/route";
import { createDashboardEventResponse } from "../app/api/dashboard/events/route";
import { createDashboardResponse } from "../app/api/dashboard/route";
import { createEncodeJobsRoute } from "../app/api/encode-jobs/route";
import {
  createFilesystemVerificationInventoryRoute,
  createFilesystemVerificationRoute,
} from "../app/api/filesystem-verification/route";
import type {
  DashboardArchiveJob,
  DashboardEncodeJob,
  DashboardSnapshot,
} from "../lib/dashboard";
import {
  CatalogReviewView,
  type CatalogReviewDto,
} from "./catalog-review-editor";
import {
  FilesystemVerificationInventoryView,
  type FilesystemVerificationInventoryState,
} from "./filesystem-verification-inventory";
import { DashboardView } from "./operations-dashboard";

const trustedOrigin = "http://localhost:3000";
const temporaryDirectories: string[] = [];
const openAccess: DataAccess[] = [];
const openEventStreams: AbortController[] = [];

afterEach(() => {
  for (const controller of openEventStreams.splice(0)) {
    controller.abort();
  }
  for (const access of openAccess.splice(0)) {
    access.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createMutationRequest(path: string, body: unknown): Request {
  return new Request(`${trustedOrigin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: trustedOrigin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

async function readDashboard(access: DataAccess): Promise<{
  html: string;
  snapshot: DashboardSnapshot;
}> {
  const snapshot = (await createDashboardResponse(access).json()) as DashboardSnapshot;
  return {
    html: renderToStaticMarkup(<DashboardView state={snapshot} />),
    snapshot,
  };
}

function renderCatalogReview(review: CatalogReviewDto): string {
  return renderToStaticMarkup(
    <CatalogReviewView
      state={{ status: "loaded", review }}
      editingMediaItemId={null}
      isSaving={false}
      requestError={null}
      mappingProposalError={null}
      selectionKind="main_feature"
      activeMappingProposal={null}
      archiveOnlySelected={false}
      onClose={() => undefined}
      onRetry={() => undefined}
      onEditMediaItem={() => undefined}
      onCancelEdit={() => undefined}
      onDiscSelectionsPage={() => undefined}
      onSelectionKindChange={() => undefined}
      onArchiveOnlyChange={() => undefined}
      onStartMappingProposal={() => undefined}
      onCancelMappingProposal={() => undefined}
      onCreateMappingProposal={() => undefined}
      onSaveMediaItem={() => undefined}
      onCreateDiscSelection={() => undefined}
      onDeleteDiscSelection={() => undefined}
      onCompleteReview={() => undefined}
    />,
  );
}

function archiveJob(snapshot: DashboardSnapshot): DashboardArchiveJob {
  if (snapshot.archiveJobs.status !== "loaded") {
    throw new Error("Archive Jobs are unavailable");
  }
  const job = snapshot.archiveJobs.items[0];
  if (!job) {
    throw new Error("Expected an Archive Job");
  }
  return job;
}

function encodeJob(snapshot: DashboardSnapshot): DashboardEncodeJob {
  if (snapshot.encodeJobs.status !== "loaded") {
    throw new Error("Encode Jobs are unavailable");
  }
  const job = snapshot.encodeJobs.items[0];
  if (!job) {
    throw new Error("Expected an Encode Job");
  }
  return job;
}

function createDashboardEventReader(access: DataAccess) {
  const controller = new AbortController();
  openEventStreams.push(controller);
  const response = createDashboardEventResponse(access, {
    signal: controller.signal,
    pollIntervalMs: 2,
  });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected a dashboard event stream");
  }
  const decoder = new TextDecoder();
  const snapshots: DashboardSnapshot[] = [];
  let buffer = "";

  const parseEvents = () => {
    let eventBoundary = buffer.indexOf("\n\n");
    while (eventBoundary >= 0) {
      const event = buffer.slice(0, eventBoundary);
      buffer = buffer.slice(eventBoundary + 2);
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data) {
        snapshots.push(JSON.parse(data) as DashboardSnapshot);
      }
      eventBoundary = buffer.indexOf("\n\n");
    }
  };

  return {
    async next(
      matches: (snapshot: DashboardSnapshot) => boolean,
    ): Promise<DashboardSnapshot> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const matchingIndex = snapshots.findIndex(matches);
        if (matchingIndex >= 0) {
          return snapshots.splice(matchingIndex, 1)[0]!;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("Dashboard event stream closed before the expected state");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        parseEvents();
      }
      throw new Error("Dashboard event stream did not publish the expected state");
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

function createGate(): {
  entered: Promise<void>;
  release(): void;
  wait(): Promise<void>;
} {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await waiting;
    },
  };
}

describe("end-to-end operations dashboard workflow", () => {
  it("reopens review and reports resulting coverage after an episodic batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-episodic-workflow-"));
    temporaryDirectories.push(root);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
    });
    openAccess.push(access);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"d".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      volumeLabel: "EPISODIC_WORKFLOW",
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [1, 3, 5].map((number) => ({
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
      archivePath: "/media/originals/Episodic Workflow.iso",
      fingerprint: contentId,
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Workflow Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Workflow Show Season 1",
      seasonNumber: 1,
    });
    const existingEpisode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Episode 1",
      episodeNumber: 1,
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: existingEpisode.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    const reviewRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    access.catalog.completeCatalogReview(archive.id, reviewRevision);
    const reviewedArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;

    const response = await createCatalogReviewRoute(
      createMutationRequest(`/api/catalog-reviews/${archive.id}`, {
        action: "create_episodic_mapping_proposal",
        catalogRevision: reviewedArchive.updatedAt.toISOString(),
        tvShow: { choice: "use_existing", mediaItemId: show.id },
        season: { choice: "use_existing", mediaItemId: season.id },
        episodes: [
          { titleNumber: 3, title: "Episode 2", episodeNumber: 2 },
          { titleNumber: 5, title: "Episode 3", episodeNumber: 3 },
        ],
      }),
      archive.id,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(201);
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.catalogReviewedAt).toBeNull();
    const refreshedResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as CatalogReviewDto;
    expect(refreshed.reviewStatus).toBe("needs_review");
    expect(refreshed.coverage).toMatchObject({
      discSelectionCount: 3,
      mediaItemsWithSelections: 3,
      mappedTitles: 3,
      partiallyMappedTitles: 0,
      unmappedTitles: 0,
    });
    expect(refreshed.mediaItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: show.id }),
      expect.objectContaining({ id: season.id }),
      expect.objectContaining({ title: "Episode 2", episodeNumber: 2 }),
      expect.objectContaining({ title: "Episode 3", episodeNumber: 3 }),
    ]));
    const html = renderCatalogReview(refreshed);
    expect(html).toContain("3 Media Items with Disc Selections");
    expect(html).toContain("3 mapped titles");
  });

  it("runs the public dashboard workflow through explicit verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-operations-workflow-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const mediaLibraryPath = join(root, "media");
    mkdirSync(originalsLibraryPath);
    mkdirSync(mediaLibraryPath);
    const inspectPath = vi.fn(async () => "file" as const);
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "rip-dvd.sqlite"),
      filesystemPathProbe: { inspect: inspectPath },
      mediaLibraryPath,
      originalsLibraryPath,
    });
    openAccess.push(access);

    const fingerprint =
      "sha256:e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const discoveredDrive = {
      devicePath: "/dev/sr0",
      displayName: "Workflow Optical Drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "WORKFLOW-001",
    };
    const scanData = {
      schemaVersion: 2 as const,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 5_711,
          chapters: 12,
          audioStreams: [{
            id: 128,
            language: "English",
            format: "AC3",
            channels: 6,
          }],
          subtitles: [{
            id: 32,
            language: "English",
            content: "Normal",
          }],
        },
        {
          number: 2,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 3,
          durationSeconds: 1_800,
          chapters: 6,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 4,
          durationSeconds: 300,
          chapters: 2,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 5,
          durationSeconds: 119,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const hardware: OpticalDriveHardware = {
      discover: vi.fn().mockResolvedValue([discoveredDrive]),
      bindOpticalDrive: vi.fn(async (drive, signal) => {
        signal.throwIfAborted();
        return { deviceInstanceToken: "workflow-device", drive };
      }),
      confirmOpticalDrive: vi.fn(async (_binding, signal) => {
        signal.throwIfAborted();
      }),
      observeMediaGeneration: vi.fn().mockResolvedValue("workflow-generation"),
      scanDvd: vi.fn().mockResolvedValue({
        fingerprint,
        scanData,
        sizeBytes: 9,
        volumeLabel: "WORKFLOW_DISC",
      }),
    };
    const signal = new AbortController().signal;

    await pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      hardware,
      log: vi.fn(),
      signal,
    });

    const discoveredDashboard = await readDashboard(access);
    expect(discoveredDashboard.html).toContain("Workflow Optical Drive");
    expect(discoveredDashboard.html).toContain("WORKFLOW_DISC");
    expect(discoveredDashboard.html).toContain("Request archive");
    const detectedDisc = access.catalog.listDetectedDiscs()[0]!;

    const approval = await createArchiveRequestsRoute(
      createMutationRequest("/api/archive-requests", {
        detectedDiscId: detectedDisc.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(approval.status).toBe(201);
    expect((await approval.json()).archiveRequest).toMatchObject({ status: "pending" });
    const queuedArchiveDashboard = await readDashboard(access);
    expect(queuedArchiveDashboard.snapshot.archiveJobs).toEqual({
      status: "loaded",
      items: [],
    });
    expect(queuedArchiveDashboard.html).toContain("Waiting for this disc");

    const archiveGate = createGate();
    const copyRunner: DvdCopyRunner = {
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
      async copy({ outputPath, onBytesCopied }) {
        onBytesCopied(4);
        await archiveGate.wait();
        writeFileSync(outputPath, "dvd-image", { flag: "wx" });
        onBytesCopied(9);
      },
    };
    const archivePoll = pollArchiveWorker({
      access,
      configuredDevicePath: "/dev/sr0",
      copyRunner,
      hardware,
      log: vi.fn(),
      originalsLibraryPath,
      signal,
      workerId: "workflow-archive-worker",
    });
    await archiveGate.entered;
    const runningArchiveDashboard = await readDashboard(access);
    expect(archiveJob(runningArchiveDashboard.snapshot)).toMatchObject({
      status: "running",
      progressPercent: 44,
    });
    expect(runningArchiveDashboard.html).toContain("Running");
    expect(runningArchiveDashboard.html).toContain("44%");
    archiveGate.release();
    await archivePoll;

    const completedArchiveDashboard = await readDashboard(access);
    expect(archiveJob(completedArchiveDashboard.snapshot)).toMatchObject({
      status: "completed",
      progressPercent: 100,
    });
    expect(completedArchiveDashboard.html).toContain("Completed");
    expect(completedArchiveDashboard.html).toContain("Review catalog");
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(existsSync(archive.archivePath)).toBe(true);
    const unrelatedMediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Unrelated Global Noise",
    });
    const existingShow = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Existing Workflow Show",
    });
    const existingSeason = access.catalog.createMediaItem({
      parentId: existingShow.id,
      kind: "season",
      title: "Season 1",
      seasonNumber: 1,
    });
    const existingEpisode = access.catalog.createMediaItem({
      parentId: existingSeason.id,
      kind: "episode",
      title: "Workflow Movie",
      episodeNumber: 1,
    });

    const catalogReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(catalogReviewResponse.status).toBe(200);
    const catalogReview = await catalogReviewResponse.json() as
      CatalogReviewDto;
    expect(catalogReview.mediaItems).toEqual([]);
    const catalogReviewHtml = renderCatalogReview(catalogReview);
    expect(catalogReviewHtml).toContain("Catalog Workflow Disc");
    expect(catalogReviewHtml).toContain("Original volume label");
    expect(catalogReviewHtml).toContain("WORKFLOW_DISC");
    expect(catalogReviewHtml).toContain("1h 35m 11s");
    expect(catalogReviewHtml).toContain("12 chapters");
    expect(catalogReviewHtml).toContain("Audio: English");
    expect(catalogReviewHtml).toContain("Subtitles: English");
    expect(catalogReviewHtml).toContain("Feature-length candidate");
    expect(catalogReviewHtml).toContain("Very short or menu candidate");
    expect(catalogReviewHtml).toContain("Longest title");
    expect(catalogReviewHtml).toContain("Technical stream details");
    expect(catalogReviewHtml).toContain("Audio stream 0x80");
    expect(catalogReviewHtml).toContain("Subtitle stream 0x20");
    expect(catalogReviewHtml).toContain("Map DVD main feature");
    expect(catalogReviewHtml).toContain("Map as movie");
    expect(catalogReviewHtml).toContain("Map as bonus feature");
    expect(catalogReviewHtml).toContain("Map as trailer");
    expect(catalogReviewHtml).toContain("Map chapters");
    expect(catalogReviewHtml).toContain("Map as other");
    expect(catalogReviewHtml).not.toContain("Unrelated Global Noise");
    expect(catalogReviewHtml).not.toContain("Existing Workflow Show");

    const mediaItemSearchResponse = await createMediaItemSearchRoute(
      new Request(
        `${trustedOrigin}/api/media-items?query=Workflow%20Movie&offset=0`,
      ),
      () => access,
    );
    expect(mediaItemSearchResponse.status).toBe(200);
    expect(mediaItemSearchResponse.headers.get("Cache-Control")).toBe(
      "no-store",
    );
    await expect(mediaItemSearchResponse.json()).resolves.toEqual({
      results: [{
        mediaItem: expect.objectContaining({ id: existingEpisode.id }),
        ancestors: [
          expect.objectContaining({ id: existingShow.id }),
          expect.objectContaining({ id: existingSeason.id }),
        ],
        suggestion: "exact",
      }],
      page: {
        offset: 0,
        limit: 20,
        hasPrevious: false,
        hasNext: false,
      },
    });
    expect(catalogReviewHtml).toContain("Archive only");

    const catalogMutation = (body: unknown) =>
      createCatalogReviewRoute(
        createMutationRequest(`/api/catalog-reviews/${archive.id}`, body),
        archive.id,
        () => access,
        () => trustedOrigin,
      );
    const archiveOnlyCompletion = await catalogMutation({
      action: "complete_review",
      catalogRevision: catalogReview.catalogRevision,
      outcome: "archive_only",
    });
    expect(archiveOnlyCompletion.status).toBe(200);
    await expect(archiveOnlyCompletion.json()).resolves.toEqual({
      archive: {
        id: archive.id,
        catalogReviewedAt: expect.any(String),
        catalogReviewOutcome: "archive_only",
      },
    });
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toEqual([]);
    const archiveOnlyDashboard = await readDashboard(access);
    expect(archiveOnlyDashboard.snapshot.catalogReview).toEqual({
      status: "loaded",
      items: [],
    });
    const archiveOnlyReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const archiveOnlyReview = await archiveOnlyReviewResponse.json() as
      CatalogReviewDto;
    expect(archiveOnlyReview.reviewOutcome).toBe("archive_only");
    expect(renderCatalogReview(archiveOnlyReview)).toContain("Archive only");

    const failedProposal = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: archiveOnlyReview.catalogRevision,
      target: {
        choice: "create_new",
        mediaItem: { kind: "movie", title: "Orphaned Workflow Movie" },
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 99 },
      },
    });
    expect(failedProposal.status).toBe(409);
    expect(access.catalog.listMediaItems()).toHaveLength(4);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([]);

    const proposalResponse = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: archiveOnlyReview.catalogRevision,
      target: {
        choice: "create_new",
        mediaItem: { kind: "movie", title: "Workflow Movie", year: 2001 },
      },
      discSelection: {
        label: "Exact archived title",
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = await proposalResponse.json() as {
      mediaItem: { id: string };
      discSelection: { id: string };
    };
    const selection = proposal.discSelection;
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(proposal.mediaItem.id).not.toBe(existingEpisode.id);
    expect(access.catalog.listMediaItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: proposal.mediaItem.id,
        title: "Workflow Movie",
      }),
      expect.objectContaining({ id: existingEpisode.id }),
    ]));
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([
      expect.objectContaining({
        id: selection.id,
        mediaItemId: proposal.mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        label: "Exact archived title",
      }),
    ]);

    const refreshedReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const refreshedReview = await refreshedReviewResponse.json() as
      CatalogReviewDto;
    expect(refreshedReview.catalogRevision).not.toBe(
      archiveOnlyReview.catalogRevision,
    );
    expect(refreshedReview.reviewOutcome).toBe("needs_review");
    expect(refreshedReview.mediaItems).toEqual([
      expect.objectContaining({ id: proposal.mediaItem.id }),
    ]);
    expect(refreshedReview.discSelections).toEqual([
      expect.objectContaining({
        id: selection.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ]);

    const mainFeatureResponse = await catalogMutation({
      action: "create_disc_selection",
      selection: {
        label: "Main feature",
        mediaItemId: proposal.mediaItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    });
    expect(mainFeatureResponse.status).toBe(201);
    const titleSources = [
      {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 1,
        chapterEnd: 3,
      },
      {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 3,
        chapterEnd: 5,
      },
      {
        kind: "dvd_chapters",
        titleNumber: 3,
        chapterStart: 1,
        chapterEnd: 3,
      },
      {
        kind: "dvd_chapters",
        titleNumber: 3,
        chapterStart: 4,
        chapterEnd: 6,
      },
    ] as const;
    for (const sourceIdentity of titleSources) {
      const response = await catalogMutation({
        action: "create_disc_selection",
        selection: { mediaItemId: proposal.mediaItem.id, sourceIdentity },
      });
      expect(response.status).toBe(201);
    }

    const coveredReviewResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    expect(coveredReviewResponse.status).toBe(200);
    const coveredReview = await coveredReviewResponse.json() as
      CatalogReviewDto;
    expect(coveredReview.coverage).toEqual({
      discSelectionCount: 6,
      mediaItemsWithSelections: 1,
      mappedTitles: 2,
      partiallyMappedTitles: 1,
      unmappedTitles: 2,
      mainFeatureSelections: 1,
      titles: [
        {
          titleNumber: 1,
          status: "mapped",
          hasOverlap: false,
        },
        {
          titleNumber: 2,
          status: "partially_mapped",
          hasOverlap: true,
        },
        {
          titleNumber: 3,
          status: "mapped",
          hasOverlap: false,
        },
        {
          titleNumber: 4,
          status: "unmapped",
          hasOverlap: false,
        },
        {
          titleNumber: 5,
          status: "unmapped",
          hasOverlap: false,
        },
      ],
    });
    const coveredReviewHtml = renderCatalogReview(coveredReview);
    expect(coveredReviewHtml).toContain("1 Media Item with Disc Selections");
    expect(coveredReviewHtml).toContain("2 mapped titles");
    expect(coveredReviewHtml).toContain("1 partially mapped title");
    expect(coveredReviewHtml).toContain("2 unmapped titles");
    expect(coveredReviewHtml).toContain("1 main-feature selection");
    expect(coveredReviewHtml).toContain("Overlapping Disc Selections");
    expect(coveredReviewHtml).toContain("counted once and remain valid");
    expect(coveredReviewHtml).toContain("1 very-short unmapped title");
    expect(coveredReviewHtml).not.toContain('<details open=""');
    const completedReview = await catalogMutation({
      action: "complete_review",
      catalogRevision: coveredReview.catalogRevision,
      outcome: "reviewed_with_selections",
    });
    expect(completedReview.status).toBe(200);
    expect((await completedReview.json()).archive.catalogReviewedAt).toEqual(
      expect.any(String),
    );

    const reviewedRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt.toISOString();
    const additionalProposal = await catalogMutation({
      action: "create_mapping_proposal",
      catalogRevision: reviewedRevision,
      target: {
        choice: "use_existing",
        mediaItemId: existingEpisode.id,
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      },
    });
    expect(additionalProposal.status).toBe(201);
    await expect(additionalProposal.json()).resolves.toMatchObject({
      mediaItem: { id: existingEpisode.id },
      discSelection: { mediaItemId: existingEpisode.id },
    });
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.catalogReviewedAt).toBeNull();
    const refreshedCoverageResponse = await createCatalogReviewRoute(
      new Request(`${trustedOrigin}/api/catalog-reviews/${archive.id}`),
      archive.id,
      () => access,
      () => trustedOrigin,
    );
    const refreshedCoverage = await refreshedCoverageResponse.json() as
      CatalogReviewDto;
    expect(refreshedCoverage.discSelections).toHaveLength(7);
    expect(refreshedCoverage.coverage).toMatchObject({
      discSelectionCount: 7,
      mediaItemsWithSelections: 2,
      mappedTitles: 3,
      partiallyMappedTitles: 0,
      unmappedTitles: 2,
      mainFeatureSelections: 1,
    });
    expect(refreshedCoverage.coverage.titles).toContainEqual({
      titleNumber: 2,
      status: "mapped",
      hasOverlap: true,
    });
    const refreshedCoverageHtml = renderCatalogReview(refreshedCoverage);
    expect(refreshedCoverageHtml).toContain(
      "2 Media Items with Disc Selections",
    );
    expect(refreshedCoverageHtml).toContain("3 mapped titles");
    expect(refreshedCoverageHtml).toContain("0 partially mapped titles");
    expect(refreshedCoverageHtml).toContain("2 unmapped titles");
    expect(refreshedCoverage.mediaItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: proposal.mediaItem.id }),
      expect.objectContaining({ id: existingShow.id }),
      expect.objectContaining({ id: existingSeason.id }),
      expect.objectContaining({ id: existingEpisode.id }),
    ]));
    expect(refreshedCoverage.mediaItems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unrelatedMediaItem.id }),
    ]));
    expect((await catalogMutation({
      action: "complete_review",
      catalogRevision: refreshedCoverage.catalogRevision,
      outcome: "reviewed_with_selections",
    })).status).toBe(200);

    const profile = access.encodingProfiles.create({
      key: "workflow-dvd",
      displayName: "Workflow DVD",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const queueOptions = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`),
      () => access,
    );
    expect(await queueOptions.json()).toEqual(expect.objectContaining({
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: profile.id }),
      ]),
      selections: expect.arrayContaining([
        expect.objectContaining({ id: selection.id }),
      ]),
    }));

    const outputPath = join(mediaLibraryPath, "Workflow Movie (2001).mkv");
    const runtimeConfig = () => ({
      mediaLibraryPath,
      webTrustedOrigin: trustedOrigin,
    });
    const queueResponse = await createEncodeJobsRoute(
      createMutationRequest("/api/encode-jobs", {
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath,
      }),
      () => access,
      runtimeConfig,
    );
    expect(queueResponse.status).toBe(200);
    const queuedEncodeJob = (await queueResponse.json()).job as { id: string };

    const events = createDashboardEventReader(access);
    const queuedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "queued",
    );
    expect(encodeJob(queuedEncodeSnapshot)).toMatchObject({
      id: queuedEncodeJob.id,
      mediaTitle: "Workflow Movie",
      status: "queued",
    });
    expect(
      renderToStaticMarkup(<DashboardView state={queuedEncodeSnapshot} />),
    ).toContain("Cancel queued encode");

    const cancelResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "cancel",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "cancelled",
    });
    const cancelledEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "cancelled",
    );
    const cancelledHtml = renderToStaticMarkup(
      <DashboardView state={cancelledEncodeSnapshot} />,
    );
    expect(cancelledHtml).toContain("Cancelled");
    expect(cancelledHtml).toContain("Requeue encode");
    expect(cancelledHtml).not.toContain("Worker reported a failure");

    const cancelledRequeueResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "requeue",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(cancelledRequeueResponse.status).toBe(200);
    expect((await cancelledRequeueResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "queued",
    });
    await events.next((snapshot) => encodeJob(snapshot).status === "queued");

    const failedEncodeGate = createGate();
    const failingRunner: HandBrakeRunner = {
      async run({ onOutput, outputPath: partialPath }) {
        onOutput(
          "Encoding: task 1 of 1, 31.00 % (128.00 fps, avg 90.00 fps, ETA 0h12m03s)\r",
        );
        await failedEncodeGate.wait();
        writeFileSync(partialPath, "failed encode", { flag: "wx" });
        throw new Error("controlled HandBrake failure");
      },
    };
    const failedEncodePoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: failingRunner,
      signal,
      workerId: "workflow-encode-worker-failure",
    });
    await failedEncodeGate.entered;
    const runningEncodeSnapshot = await events.next(
      (snapshot) =>
        encodeJob(snapshot).status === "running" &&
        encodeJob(snapshot).progressPercent === 31,
    );
    expect(
      renderToStaticMarkup(<DashboardView state={runningEncodeSnapshot} />),
    ).toContain("Encoding · ETA 12m 3s");
    failedEncodeGate.release();
    await failedEncodePoll;
    const failedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "failed",
    );
    expect(
      renderToStaticMarkup(<DashboardView state={failedEncodeSnapshot} />),
    ).toContain("Retry encode");

    const retryResponse = await createEncodeJobsRoute(
      new Request(`${trustedOrigin}/api/encode-jobs`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: trustedOrigin,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          action: "requeue",
          encodeJobId: queuedEncodeJob.id,
        }),
      }),
      () => access,
      runtimeConfig,
    );
    expect(retryResponse.status).toBe(200);
    expect((await retryResponse.json()).job).toMatchObject({
      id: queuedEncodeJob.id,
      status: "queued",
      progressPercent: 0,
    });
    await events.next((snapshot) => encodeJob(snapshot).status === "queued");

    const successfulEncodeGate = createGate();
    const successfulRunner: HandBrakeRunner = {
      async run({ onOutput, outputPath: partialPath }) {
        onOutput(
          "Encoding: task 1 of 1, 64.00 % (128.00 fps, avg 90.00 fps, ETA 0h02m05s)\r",
        );
        await successfulEncodeGate.wait();
        writeFileSync(partialPath, "completed encode", { flag: "wx" });
      },
    };
    const successfulEncodePoll = pollEncodeWorker({
      access,
      concurrency: 1,
      log: vi.fn(),
      mediaLibraryPath,
      originalsLibraryPath,
      runner: successfulRunner,
      signal,
      workerId: "workflow-encode-worker-success",
    });
    await successfulEncodeGate.entered;
    const retryProgress = await events.next(
      (snapshot) =>
        encodeJob(snapshot).status === "running" &&
        encodeJob(snapshot).progressPercent === 64,
    );
    expect(encodeJob(retryProgress)).toMatchObject({
      progressPhase: "encoding",
      progressEtaSeconds: 125,
    });
    successfulEncodeGate.release();
    await successfulEncodePoll;
    const completedEncodeSnapshot = await events.next(
      (snapshot) => encodeJob(snapshot).status === "completed",
    );
    expect(encodeJob(completedEncodeSnapshot)).toMatchObject({
      id: queuedEncodeJob.id,
      progressPercent: 100,
    });
    expect(readFileSync(outputPath, "utf8")).toBe("completed encode");

    expect(inspectPath).not.toHaveBeenCalled();
    await readDashboard(access);
    expect(inspectPath).not.toHaveBeenCalled();

    const archiveVerification = await createFilesystemVerificationRoute(
      createMutationRequest("/api/filesystem-verification", {
        target: "original_disc_archive",
        id: archive.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    const outputVerification = await createFilesystemVerificationRoute(
      createMutationRequest("/api/filesystem-verification", {
        target: "encode_job_output",
        id: queuedEncodeJob.id,
      }),
      () => access,
      () => trustedOrigin,
    );
    expect(await archiveVerification.json()).toMatchObject({
      verification: { status: "accessible" },
    });
    expect(await outputVerification.json()).toMatchObject({
      verification: { status: "accessible" },
    });
    expect(inspectPath).toHaveBeenNthCalledWith(
      1,
      archive.archivePath,
      originalsLibraryPath,
    );
    expect(inspectPath).toHaveBeenNthCalledWith(
      2,
      outputPath,
      mediaLibraryPath,
    );
    const verifiedDashboard = await readDashboard(access);
    expect(verifiedDashboard.html).toContain("File is accessible.");
    const readInventory = (target: "encode_job_output" | "original_disc_archive") => {
      const response = createFilesystemVerificationInventoryRoute(
        new Request(
          `${trustedOrigin}/api/filesystem-verification?target=${target}`,
        ),
        () => access,
      );
      return response.json() as Promise<{
        inventory: Omit<
          Extract<
            FilesystemVerificationInventoryState,
            { status: "loaded" }
          >,
          "status"
        >;
      }>;
    };
    const [encodeInventory, archiveInventory] = await Promise.all([
      readInventory("encode_job_output"),
      readInventory("original_disc_archive"),
    ]);
    const inventoryHtml = renderToStaticMarkup(
      <FilesystemVerificationInventoryView
        encodeOutputs={{ status: "loaded", ...encodeInventory.inventory }}
        originalArchives={{ status: "loaded", ...archiveInventory.inventory }}
      />,
    );
    expect(inventoryHtml.match(/File is accessible\./g)).toHaveLength(2);
    expect(inspectPath).toHaveBeenCalledTimes(2);

    await events.close();
  }, 20_000);
});
