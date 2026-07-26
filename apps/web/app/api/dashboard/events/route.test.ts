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
    const profile = access.catalog.createEncodingProfile({
      key: "streamed-profile",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      version: 1,
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
