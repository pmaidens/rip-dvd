import { describe, expect, it, vi } from "vitest";

import type {
  DashboardDetectedDiscDetails,
  DashboardSnapshot,
} from "./dashboard";
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
  it("retains HTTP title details when activity events carry disc summaries", async () => {
    const detailed = emptySnapshot("2026-07-26T16:00:00.000Z");
    detailed.detectedDiscs = {
      status: "loaded",
      items: [
        {
          id: "disc-new",
          volumeLabel: "DETAILED_DISC",
          discKind: "dvd",
          status: "scanned",
          opticalDriveName: "Upper drive",
          fingerprint: "sha256:disc-1",
          titles: [
            {
              number: 1,
              durationSeconds: 60,
              chapters: 1,
              audioStreams: [
                { id: 128, language: "English", format: "ac3", channels: 6 },
              ],
              subtitles: [],
            },
          ],
          detectedAt: "2026-07-26T15:58:00.000Z",
        },
      ],
    };
    const activity: DashboardSnapshot = {
      ...detailed,
      generatedAt: "2026-07-26T16:00:01.000Z",
      detectedDiscs: {
        status: "loaded",
        items: [{ ...detailed.detectedDiscs.items[0]!, titles: [] }],
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
      loadSnapshot: async () => detailed,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({
      data: JSON.stringify(activity),
    } as MessageEvent<string>);

    expect(
      (onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot).detectedDiscs,
    ).toEqual(detailed.detectedDiscs);
    stop();
  });

  it("loads review details for a disc first observed through activity", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const activity = emptySnapshot("2026-07-26T16:00:01.000Z");
    activity.detectedDiscs = {
      status: "loaded",
      items: [
        {
          id: "disc-new",
          volumeLabel: "NEW_DISC",
          discKind: "dvd",
          status: "scanned",
          opticalDriveName: "Upper drive",
          fingerprint: "sha256:new-disc",
          titles: [],
          detectedAt: "2026-07-26T16:00:01.000Z",
        },
      ],
    };
    const details: DashboardDetectedDiscDetails = {
      id: "disc-new",
      detectedAt: "2026-07-26T16:00:01.000Z",
      titles: [
        {
          number: 1,
          durationSeconds: 90,
          chapters: 2,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const loadSnapshot = vi.fn().mockResolvedValue(initial);
    const loadDiscDetails = vi.fn().mockResolvedValue(details);
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
      loadSnapshot,
      loadDiscDetails,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({
      data: JSON.stringify(activity),
    } as MessageEvent<string>);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(loadDiscDetails).toHaveBeenCalledWith(
      "disc-new",
      "2026-07-26T16:00:01.000Z",
      expect.any(AbortSignal),
    );
    expect(
      (onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot).detectedDiscs,
    ).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          id: "disc-new",
          detectedAt: details.detectedAt,
          titles: details.titles,
        }),
      ],
    });
    stop();
  });

  it("reloads review details when a known disc is rescanned", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    initial.detectedDiscs = {
      status: "loaded",
      items: [
        {
          id: "disc-1",
          volumeLabel: "DISC",
          discKind: "dvd",
          status: "detected",
          opticalDriveName: "Upper drive",
          fingerprint: "sha256:disc",
          titles: [],
          detectedAt: "2026-07-26T15:59:00.000Z",
        },
      ],
    };
    const activity = structuredClone(initial);
    activity.generatedAt = "2026-07-26T16:00:01.000Z";
    if (activity.detectedDiscs.status === "loaded") {
      activity.detectedDiscs.items[0]!.status = "scanned";
      activity.detectedDiscs.items[0]!.detectedAt =
        "2026-07-26T16:00:01.000Z";
    }
    const details: DashboardDetectedDiscDetails = {
      id: "disc-1",
      detectedAt: "2026-07-26T16:00:01.000Z",
      titles: [
        {
          number: 1,
          durationSeconds: 120,
          chapters: 3,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const loadSnapshot = vi.fn().mockResolvedValue(initial);
    const loadDiscDetails = vi.fn().mockResolvedValue(details);
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
      loadSnapshot,
      loadDiscDetails,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({
      data: JSON.stringify(activity),
    } as MessageEvent<string>);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(loadDiscDetails).toHaveBeenCalledOnce();
    expect(
      (onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot).detectedDiscs,
    ).toEqual({
      status: "loaded",
      items: [
        expect.objectContaining({
          id: "disc-1",
          detectedAt: details.detectedAt,
          titles: details.titles,
        }),
      ],
    });
    stop();
  });

  it("merges a delayed detail response without rolling newer live state backward", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    let resolveDetails!: (details: DashboardDetectedDiscDetails) => void;
    const loadDiscDetails = vi.fn(
      () =>
        new Promise<DashboardDetectedDiscDetails>((resolve) => {
          resolveDetails = resolve;
        }),
    );
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const eventSource = {
      onerror: null as (() => void) | null,
      onopen: null as (() => void) | null,
      addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) {
        dashboardListener = listener;
      },
      close: vi.fn(),
    };
    const onSnapshot = vi.fn();
    const first = emptySnapshot("2026-07-26T16:00:01.000Z");
    first.detectedDiscs = {
      status: "loaded",
      items: [{
        id: "disc-1",
        volumeLabel: "DISC",
        discKind: "dvd",
        status: "scanned",
        opticalDriveName: "Drive",
        fingerprint: "sha256:disc",
        titles: [],
        detectedAt: "2026-07-26T16:00:01.000Z",
      }],
    };
    first.archiveJobs = {
      status: "loaded",
      items: [{
        id: "job-1",
        discLabel: "DISC",
        opticalDriveName: "Drive",
        status: "running",
        progressPercent: 10,
      }],
    };
    const newer = structuredClone(first);
    newer.generatedAt = "2026-07-26T16:00:02.000Z";
    if (newer.archiveJobs.status === "loaded") {
      newer.archiveJobs.items[0]!.progressPercent = 50;
    }

    const stop = watchDashboardActivity({
      loadSnapshot: async () => initial,
      loadDiscDetails,
      openEventSource: () => eventSource,
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(first) } as MessageEvent<string>);
    dashboardListener?.({ data: JSON.stringify(newer) } as MessageEvent<string>);
    resolveDetails({
      id: "disc-1",
      detectedAt: "2026-07-26T16:00:01.000Z",
      titles: [{
        number: 1,
        durationSeconds: 60,
        chapters: 1,
        audioStreams: [],
        subtitles: [],
      }],
    });
    await Promise.resolve();
    await Promise.resolve();

    const latest = onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot;
    expect(latest.archiveJobs).toEqual(newer.archiveJobs);
    expect(latest.generatedAt).toBe(newer.generatedAt);
    expect(loadDiscDetails).toHaveBeenCalledOnce();
    stop();
  });

  it("hydrates changed disc details sequentially and only once per version", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const loadDiscDetails = vi.fn(
      (id: string, detectedAt: string) =>
        new Promise<DashboardDetectedDiscDetails>((resolve) => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve({ id, detectedAt, titles: [] });
          });
        }),
    );
    const activity = emptySnapshot("2026-07-26T16:00:01.000Z");
    activity.detectedDiscs = {
      status: "loaded",
      items: ["disc-1", "disc-2"].map((id) => ({
        id,
        volumeLabel: id,
        discKind: "dvd" as const,
        status: "scanned" as const,
        opticalDriveName: "Drive",
        fingerprint: `sha256:${id}`,
        titles: [],
        detectedAt: "2026-07-26T16:00:01.000Z",
      })),
    };
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const stop = watchDashboardActivity({
      loadSnapshot: async () => initial,
      loadDiscDetails,
      openEventSource: () => ({
        onerror: null,
        onopen: null,
        addEventListener(_type, listener) {
          dashboardListener = listener;
        },
        close: vi.fn(),
      }),
      onSnapshot: vi.fn(),
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);
    expect(loadDiscDetails).toHaveBeenCalledOnce();
    pending.shift()?.();
    await vi.waitFor(() => {
      expect(loadDiscDetails).toHaveBeenCalledTimes(2);
    });
    pending.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);

    expect(maximumInFlight).toBe(1);
    expect(loadDiscDetails).toHaveBeenCalledTimes(2);
    stop();
  });

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
            fingerprint: "sha256:live-disc",
            titles: [],
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
