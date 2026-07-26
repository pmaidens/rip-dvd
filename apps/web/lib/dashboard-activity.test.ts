import { describe, expect, it, vi } from "vitest";

import type { DashboardSnapshot } from "./dashboard";
import { watchDashboardActivity } from "./dashboard-activity";

function emptySnapshot(generatedAt: string): DashboardSnapshot {
  return {
    generatedAt,
    opticalDrives: { status: "loaded", items: [] },
    detectedDiscs: { status: "loaded", items: [] },
    archiveJobs: { status: "loaded", items: [] },
    encodeJobs: { status: "loaded", items: [] },
    catalogReview: { status: "loaded", items: [] },
  };
}

describe("watchDashboardActivity", () => {
  it("keeps the normal HTTP snapshot when SSE is unavailable", async () => {
    const snapshot = emptySnapshot("2026-07-26T16:00:00.000Z");
    const onSnapshot = vi.fn();
    const onInitialLoadError = vi.fn();

    const stop = watchDashboardActivity({
      loadSnapshot: async () => snapshot,
      openEventSource() {
        throw new Error("EventSource unavailable");
      },
      onSnapshot,
      onInitialLoadError,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onInitialLoadError).not.toHaveBeenCalled();

    stop();
  });

  it("delivers streamed snapshots to the dashboard after the HTTP baseline", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const streamed: DashboardSnapshot = {
      generatedAt: "2026-07-26T16:00:01.000Z",
      opticalDrives: {
        status: "loaded",
        items: [
          {
            id: "drive-1",
            displayName: "Upper drive",
            hardwareName: "Pioneer BDR-XD08",
            state: "ready",
            lastSeenAt: "2026-07-26T16:00:01.000Z",
          },
        ],
      },
      detectedDiscs: {
        status: "loaded",
        items: [
          {
            id: "disc-1",
            volumeLabel: "LIVE_DISC",
            discKind: "dvd",
            status: "approved",
            opticalDriveName: "Upper drive",
            detectedAt: "2026-07-26T15:58:00.000Z",
          },
        ],
      },
      archiveJobs: {
        status: "loaded",
        items: [
          {
            id: "archive-1",
            discLabel: "LIVE_DISC",
            opticalDriveName: "Upper drive",
            status: "running",
            progressPercent: 42,
          },
        ],
      },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-1",
            mediaTitle: "Live Movie",
            mediaYear: 2001,
            encodingProfileName: "DVD library",
            status: "running",
            progressPercent: 18,
          },
        ],
      },
      catalogReview: {
        status: "loaded",
        items: [
          {
            id: "review-1",
            discLabel: "REVIEW_DISC",
            discKind: "dvd",
            archiveFormat: "iso",
            archivedAt: "2026-07-26T15:00:00.000Z",
          },
        ],
      },
    };
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const eventSource = {
      onerror: null as (() => void) | null,
      onopen: null as (() => void) | null,
      addEventListener(
        type: string,
        listener: (event: MessageEvent<string>) => void,
      ) {
        if (type === "dashboard") {
          dashboardListener = listener;
        }
      },
      close: vi.fn(),
    };
    const onSnapshot = vi.fn();

    const stop = watchDashboardActivity({
      loadSnapshot: async () => initial,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(streamed) } as MessageEvent<string>);

    expect(onSnapshot).toHaveBeenNthCalledWith(1, initial);
    expect(onSnapshot).toHaveBeenNthCalledWith(2, streamed);

    stop();
    expect(eventSource.close).toHaveBeenCalledOnce();
  });

  it("lets EventSource reconnect and accepts events after a connection error", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const reconnected = emptySnapshot("2026-07-26T16:00:02.000Z");
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const eventSource = {
      onerror: null as (() => void) | null,
      onopen: null as (() => void) | null,
      addEventListener(
        type: string,
        listener: (event: MessageEvent<string>) => void,
      ) {
        if (type === "dashboard") {
          dashboardListener = listener;
        }
      },
      close: vi.fn(),
    };
    const onSnapshot = vi.fn();
    const onStreamStatus = vi.fn();

    const stop = watchDashboardActivity({
      loadSnapshot: async () => initial,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
      onStreamStatus,
    });
    await Promise.resolve();
    await Promise.resolve();
    eventSource.onerror?.();

    expect(eventSource.close).not.toHaveBeenCalled();
    expect(onStreamStatus).toHaveBeenLastCalledWith("reconnecting");

    eventSource.onopen?.();
    dashboardListener?.({
      data: JSON.stringify(reconnected),
    } as MessageEvent<string>);

    expect(onStreamStatus).toHaveBeenLastCalledWith("live");
    expect(onSnapshot).toHaveBeenLastCalledWith(reconnected);

    stop();
  });
});
