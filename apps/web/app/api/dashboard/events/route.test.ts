import type { DataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../../test/data-access-fixture";
import {
  createDashboardEventResponse,
  createDashboardEventRoute,
} from "./route";

const dataAccessFixture = useDataAccessFixture();

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/dashboard/events", () => {
  it("bounds activity events to recent disc summaries without title maps", async () => {
    vi.useFakeTimers();
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    for (let index = 1; index < 32; index += 1) {
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/sr${index}`,
        displayName: `Attached drive ${index}`,
        isEnabled: index % 2 === 0,
        isPresent: true,
      });
    }
    for (let index = 32; index < 92; index += 1) {
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/sr${index}`,
        displayName: `Missing configured drive ${index}`,
        isEnabled: true,
        isPresent: false,
      });
    }
    const profile = access.encodingProfiles.create({
      key: "activity-profile",
      displayName: "Activity profile",
      mediaDomain: "dvd_video",
      settings: {},
    });
    for (let index = 0; index < 25; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 26, 18, 0, index)));
      const contentId = `sha256:${index.toString(16).padStart(64, "0")}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: contentId,
        volumeLabel: `DISC_${index.toString().padStart(2, "0")}`,
        scanData: {
          schemaVersion: 2,
          contentId,
          titles: Array.from({ length: 64 }, (_, titleIndex) => ({
            number: titleIndex + 1,
            durationSeconds: 60,
            chapters: 1,
            audioStreams: [
              {
                id: 128,
                language: "English",
                format: "ac3",
                channels: 6,
              },
            ],
            subtitles: [{ id: 32, language: "English", content: "Normal" }],
          })),
        },
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      access.archiveJobs.enqueue({ detectedDiscId: disc.id });

      const encodeFingerprint =
        `sha256:${(index + 100).toString(16).padStart(64, "0")}`;
      const encodeDisc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: encodeFingerprint,
        volumeLabel: `ENCODE_DISC_${index}`,
      });
      access.catalog.updateDetectedDiscStatus(encodeDisc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(encodeDisc.id, "approved");
      const encodeArchive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: encodeDisc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/encode-${index}.iso`,
        fingerprint: encodeFingerprint,
      });
      const mediaItem = access.catalog.createMediaItem({
        kind: "movie",
        title: `Encode Movie ${index}`,
      });
      const selection = access.catalog.createDiscSelection({
        originalDiscArchiveId: encodeArchive.id,
        mediaItemId: mediaItem.id,
        sourceKey: "main-feature",
        kind: "main_feature",
      });
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/encode-${index}.mkv`,
      });

      const reviewFingerprint =
        `sha256:${(index + 200).toString(16).padStart(64, "0")}`;
      const reviewDisc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: reviewFingerprint,
        volumeLabel: `REVIEW_DISC_${index}`,
      });
      access.catalog.updateDetectedDiscStatus(reviewDisc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(reviewDisc.id, "approved");
      access.catalog.createOriginalDiscArchive({
        detectedDiscId: reviewDisc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/review-${index}.iso`,
        fingerprint: reviewFingerprint,
      });
    }
    const abortController = new AbortController();
    const response = createDashboardEventResponse(access, {
      signal: abortController.signal,
      pollIntervalMs: 60_000,
    });

    const event = new TextDecoder().decode(
      (await response.body!.getReader().read()).value,
    );
    abortController.abort();
    const dataLine = event
      .split("\n")
      .find((line) => line.startsWith("data: "))!;
    const snapshot = JSON.parse(dataLine.slice("data: ".length)) as {
      opticalDrives: { status: string; items: unknown[] };
      detectedDiscs: {
        status: string;
        items: { volumeLabel: string; titles: unknown[] }[];
      };
      archiveJobs: {
        status: string;
        items: { discLabel: string }[];
      };
      encodeJobs: {
        status: string;
        items: { mediaTitle: string; encodingProfileName: string }[];
      };
      catalogReview: {
        status: string;
        items: { discLabel: string }[];
      };
    };

    expect(snapshot.detectedDiscs.status).toBe("loaded");
    expect(snapshot.opticalDrives.items).toHaveLength(92);
    expect(snapshot.detectedDiscs.items).toHaveLength(45);
    expect(
      snapshot.detectedDiscs.items.some(
        (disc) => disc.volumeLabel === "DISC_00",
      ),
    ).toBe(true);
    expect(
      snapshot.detectedDiscs.items.some((disc) => disc.volumeLabel.endsWith("24")),
    ).toBe(true);
    expect(
      snapshot.detectedDiscs.items.every((disc) => disc.titles.length === 0),
    ).toBe(true);
    expect(snapshot.archiveJobs.items).toHaveLength(25);
    expect(
      snapshot.archiveJobs.items.every(
        (job) => job.discLabel !== "Unlabeled disc",
      ),
    ).toBe(true);
    expect(snapshot.encodeJobs.items).toHaveLength(25);
    expect(
      snapshot.encodeJobs.items.every(
        (job) =>
          job.mediaTitle !== "Unknown Media Item" &&
          job.encodingProfileName === "Activity profile",
      ),
    ).toBe(true);
    expect(snapshot.catalogReview.items).toHaveLength(20);
    expect(
      snapshot.catalogReview.items.every(
        (item) => item.discLabel !== "Unlabeled disc",
      ),
    ).toBe(true);
    expect(Buffer.byteLength(event)).toBeLessThan(50_000);
  });

  it("frames the current database snapshot as a reconnectable dashboard event", async () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const abortController = new AbortController();

    const response = createDashboardEventResponse(access, {
      signal: abortController.signal,
      pollIntervalMs: 60_000,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    abortController.abort();

    const event = new TextDecoder().decode(firstChunk.value);
    expect(event).toMatch(/^retry: 3000\n/);
    expect(event).toContain("event: dashboard\n");
    expect(event).toMatch(/id: \d{4}-\d{2}-\d{2}T/);
    expect(event).toContain('"displayName":"Archive drive"');
    expect(event.endsWith("\n\n")).toBe(true);
    expect(event).not.toContain("/dev/sr0");
  });

  it("reads Archive Job and Encode Job progress from SQLite on each event", async () => {
    vi.useFakeTimers();
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });
    const archiveDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "streamed-archive-disc",
      volumeLabel: "ARCHIVE_DISC",
    });
    access.catalog.updateDetectedDiscStatus(archiveDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(archiveDisc.id, "approved");
    access.archiveJobs.enqueue({ detectedDiscId: archiveDisc.id });
    const archiveClaim = access.archiveJobs.claimNext("archive-worker-test")!;

    const encodeDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "streamed-encode-disc",
      volumeLabel: "ENCODE_DISC",
    });
    access.catalog.updateDetectedDiscStatus(encodeDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(encodeDisc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: encodeDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Encode Disc.iso",
      fingerprint: "streamed-encode-disc",
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Streamed Movie",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceKey: "main-feature",
      kind: "main_feature",
    });
    const profile = access.encodingProfiles.create({
      key: "streamed-profile",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: {},
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Streamed Movie.mkv",
    });
    const encodeClaim = access.encodeJobs.claimNext("encode-worker-test")!;
    const abortController = new AbortController();
    const response = createDashboardEventResponse(access, {
      signal: abortController.signal,
      pollIntervalMs: 1_000,
    });
    const reader = response.body!.getReader();
    await reader.read();

    access.archiveJobs.updateProgress(archiveClaim, 42);
    access.encodeJobs.updateProgress(encodeClaim, 18);
    await vi.advanceTimersByTimeAsync(1_000);
    const nextChunk = await reader.read();
    abortController.abort();

    const event = new TextDecoder().decode(nextChunk.value);
    expect(event).toContain('"discLabel":"ARCHIVE_DISC"');
    expect(event).toContain('"mediaTitle":"Streamed Movie"');
    expect(event).toContain('"progressPercent":42');
    expect(event).toContain('"progressPercent":18');
    expect(event).not.toContain("/media/");
  });

  it("streams Archive Job progress, failure, completion, and catalog review from SQLite", async () => {
    vi.useFakeTimers();
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
      fingerprint: "streamed-archive-lifecycle",
      volumeLabel: "LIFECYCLE_DISC",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const job = access.archiveJobs.approve({ detectedDiscId: disc.id });
    const firstClaim = access.archiveJobs.claimNext("archive-worker-first")!;
    access.archiveJobs.updateProgress(firstClaim, 37);

    const abortController = new AbortController();
    const response = createDashboardEventResponse(access, {
      signal: abortController.signal,
      pollIntervalMs: 1_000,
    });
    const reader = response.body!.getReader();
    const parseSnapshot = async () => {
      const event = new TextDecoder().decode((await reader.read()).value);
      const dataLine = event
        .split("\n")
        .find((line) => line.startsWith("data: "))!;
      return JSON.parse(dataLine.slice("data: ".length)) as {
        archiveJobs: {
          status: string;
          items: { id: string; status: string; progressPercent: number }[];
        };
        catalogReview: {
          status: string;
          items: { discLabel: string }[];
        };
      };
    };

    const running = await parseSnapshot();
    expect(running.archiveJobs).toMatchObject({
      status: "loaded",
      items: [
        { id: job.id, status: "running", progressPercent: 37 },
      ],
    });
    expect(running.catalogReview.items).toEqual([]);

    access.archiveJobs.fail(firstClaim, "DVD read failed");
    await vi.advanceTimersByTimeAsync(1_000);
    const failed = await parseSnapshot();
    expect(failed.archiveJobs).toMatchObject({
      status: "loaded",
      items: [{ id: job.id, status: "failed", progressPercent: 37 }],
    });
    expect(failed.catalogReview.items).toEqual([]);

    access.archiveJobs.approve({ detectedDiscId: disc.id });
    const retryClaim = access.archiveJobs.claimNext("archive-worker-retry")!;
    access.archiveJobs.publish(retryClaim, {
      archivePath: "/media/originals/lifecycle.iso",
      sizeBytes: 9,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const completed = await parseSnapshot();
    abortController.abort();

    expect(completed.archiveJobs).toMatchObject({
      status: "loaded",
      items: [{ id: job.id, status: "completed", progressPercent: 100 }],
    });
    expect(completed.catalogReview).toMatchObject({
      status: "loaded",
      items: [{ discLabel: "LIFECYCLE_DISC" }],
    });
  });

  it("coalesces updates while a slow client has not consumed its queued event", async () => {
    vi.useFakeTimers();
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Initial drive name",
      isEnabled: true,
      isPresent: true,
    });
    const abortController = new AbortController();
    const response = createDashboardEventResponse(access, {
      signal: abortController.signal,
      pollIntervalMs: 1,
    });
    const reader = response.body!.getReader();

    await vi.advanceTimersByTimeAsync(20);
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Latest drive name",
      isEnabled: true,
      isPresent: true,
    });

    const firstEvent = new TextDecoder().decode((await reader.read()).value);
    const nextEventPromise = reader.read();
    await vi.advanceTimersByTimeAsync(1);
    const nextEvent = new TextDecoder().decode((await nextEventPromise).value);
    abortController.abort();

    expect(firstEvent).toContain('"displayName":"Initial drive name"');
    expect(nextEvent).toContain('"displayName":"Latest drive name"');
  });

  it("errors and cleans up the stream when a later database snapshot fails", async () => {
    vi.useFakeTimers();
    const access = dataAccessFixture.create();
    const failure = new Error("database unavailable");
    let snapshotReads = 0;
    const failingAccess: DataAccess = {
      ...access,
      readConsistentSnapshot(read) {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          throw failure;
        }
        return access.readConsistentSnapshot(read);
      },
    };
    const abortController = new AbortController();
    const response = createDashboardEventResponse(failingAccess, {
      signal: abortController.signal,
      pollIntervalMs: 1_000,
    });
    const reader = response.body!.getReader();
    await reader.read();
    const failedRead = reader.read().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await failedRead).toBe(failure);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshotReads).toBe(2);
    expect(() => abortController.abort()).not.toThrow();
  });

  it("stops reading database snapshots after the browser cancels", async () => {
    vi.useFakeTimers();
    const access = dataAccessFixture.create();
    let snapshotReads = 0;
    const observedAccess: DataAccess = {
      ...access,
      readConsistentSnapshot(read) {
        snapshotReads += 1;
        return access.readConsistentSnapshot(read);
      },
    };
    const abortController = new AbortController();
    const response = createDashboardEventResponse(observedAccess, {
      signal: abortController.signal,
      pollIntervalMs: 1_000,
    });
    const reader = response.body!.getReader();
    await reader.read();

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(snapshotReads).toBe(1);
    expect(() => abortController.abort()).not.toThrow();
  });

  it("returns a safe service-unavailable response when data access cannot open", () => {
    const response = createDashboardEventRoute(
      new Request("http://localhost/api/dashboard/events"),
      () => {
        throw new Error("sensitive database detail");
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
