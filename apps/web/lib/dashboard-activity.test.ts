import { afterEach, describe, expect, it, vi } from "vitest";

import type { EncodeJobId } from "@rip-dvd/data-access";

import type {
  DashboardDetectedDiscDetails,
  DashboardSnapshot,
} from "./dashboard";
import { watchDashboardActivity } from "./dashboard-activity";
import { DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT } from "./dashboard-bounds";

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

function detectedDiscSummary(index: number) {
  return {
    id: `disc-${index}`,
    volumeLabel: `DISC_${index}`,
    discKind: "dvd" as const,
    status: "scanned" as const,
    opticalDriveName: "Upper drive",
    fingerprint: `sha256:disc-${index}`,
    titles: [],
    detectedAt: new Date(Date.UTC(2026, 6, 26, 15, 0, index)).toISOString(),
  };
}

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchDashboardActivity", () => {
  it("keeps HTTP and live activity on the requested catalog review page", async () => {
    const snapshot = emptySnapshot("2026-08-03T19:30:00.000Z");
    const cursor = "v1.older.1785804600000.00000000-0000-4000-8000-000000000001";
    const loadSnapshot = vi.fn(async (_cursor: string | null) => snapshot);
    const eventSource = {
      onerror: null,
      onopen: null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    const openEventSource = vi.fn((_cursor: string | null) => eventSource);

    const stop = watchDashboardActivity({
      catalogReviewCursor: cursor,
      loadSnapshot,
      openEventSource,
      onSnapshot: vi.fn(),
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSnapshot).toHaveBeenCalledWith(cursor);
    expect(openEventSource).toHaveBeenCalledWith(cursor);
    stop();
  });

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

  it("hydrates a newly failed Archive Job before publishing its compact activity update", async () => {
    const initial = emptySnapshot("2026-08-31T06:00:00.000Z");
    initial.archiveJobs = {
      status: "loaded",
      items: [{
        id: "archive-1",
        activityRevision: "2026-08-31T06:00:00.000Z",
        detectedDiscId: "disc-1",
        archiveRequestId: "request-1",
        attemptOrdinal: 1,
        discLabel: "LIVE_FAILURE",
        opticalDriveName: "Upper drive",
        status: "running",
        progressPhase: "copying",
        progressPercent: 50,
        progressBytes: 4_096,
        lastProgressAt: "2026-08-31T06:00:00.000Z",
      }],
    };
    const compactFailure = structuredClone(initial);
    compactFailure.generatedAt = "2026-08-31T06:00:01.000Z";
    if (compactFailure.archiveJobs.status === "loaded") {
      Object.assign(compactFailure.archiveJobs.items[0]!, {
        activityRevision: "2026-08-31T06:00:01.000Z",
        status: "failed",
      });
    }
    const detailedFailure = structuredClone(compactFailure);
    if (detailedFailure.archiveJobs.status === "loaded") {
      detailedFailure.archiveJobs.items[0]!.investigation = {
        incidentId: "archive-job-failure:archive-1",
        worker: "Archive Worker",
        subjectType: "Archive Job",
        subjectId: "archive-1",
        attempt: 1,
        reasonCode: "archive_read.hardware_error",
        failedPhase: "Copying",
        occurredAt: "2026-08-31T06:00:01.000Z",
        retryability: "appropriate",
        retryabilityDetail:
          "The current Archive Request is waiting for a retry.",
        explanation: "The Optical Drive reported a hardware fault.",
        suggestedAction: "Retry the Archive Request once.",
        technicalEvidence: [{ label: "Sense key", value: "4" }],
      };
    }
    const loadSnapshot = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(detailedFailure);
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const onSnapshot = vi.fn();
    const stop = watchDashboardActivity({
      loadSnapshot,
      openEventSource: () => ({
        onerror: null,
        onopen: null,
        addEventListener(_type, listener) {
          dashboardListener = listener;
        },
        close: vi.fn(),
      }),
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    dashboardListener?.({
      data: JSON.stringify(compactFailure),
    } as MessageEvent<string>);
    await flushUntil(() => loadSnapshot.mock.calls.length === 2);
    await flushUntil(() => {
      const latest = onSnapshot.mock.calls.at(-1)?.[0] as
        | DashboardSnapshot
        | undefined;
      return latest?.archiveJobs.status === "loaded" &&
        latest.archiveJobs.items[0]?.investigation !== undefined;
    });

    expect(
      onSnapshot.mock.calls.some((call) => {
        const snapshot = call[0] as DashboardSnapshot;
        return snapshot.archiveJobs.status === "loaded" &&
          snapshot.archiveJobs.items.some(
            (job) => job.status === "failed" && job.investigation === undefined,
          );
      }),
    ).toBe(false);
    dashboardListener?.({
      data: JSON.stringify(compactFailure),
    } as MessageEvent<string>);
    await Promise.resolve();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    stop();
  });

  it("rehydrates a failed Archive Job when a retry changes its investigation context", async () => {
    const initial = emptySnapshot("2026-08-31T06:00:00.000Z");
    const retryableInvestigation = {
      incidentId: "archive-job-failure:archive-1",
      worker: "Archive Worker",
      subjectType: "Archive Job",
      subjectId: "archive-1",
      attempt: 1,
      reasonCode: "archive_read.hardware_error",
      failedPhase: "Copying",
      occurredAt: "2026-08-31T06:00:00.000Z",
      retryability: "appropriate" as const,
      retryabilityDetail: "The current Archive Request is waiting for a retry.",
      explanation: "The Optical Drive reported a hardware fault.",
      suggestedAction: "Retry the Archive Request once.",
      technicalEvidence: [],
    };
    initial.detectedDiscs = {
      status: "loaded",
      items: [{
        ...detectedDiscSummary(1),
        id: "disc-1",
        status: "approved",
        archiveRequest: {
          id: "request-1",
          status: "needs_attention",
          attemptCount: 1,
          latestFailureDetail: "The Optical Drive reported a hardware fault.",
          createdAt: "2026-08-31T05:58:00.000Z",
          updatedAt: "2026-08-31T06:00:00.000Z",
        },
      }],
    };
    initial.archiveJobs = {
      status: "loaded",
      items: [{
        id: "archive-1",
        activityRevision: "2026-08-31T06:00:00.000Z",
        detectedDiscId: "disc-1",
        archiveRequestId: "request-1",
        attemptOrdinal: 1,
        discLabel: "LIVE_RETRY",
        opticalDriveName: "Upper drive",
        status: "failed",
        progressPhase: "copying",
        progressPercent: 50,
        progressBytes: 4_096,
        lastProgressAt: "2026-08-31T06:00:00.000Z",
        investigation: retryableInvestigation,
      }],
    };
    const compactRetry = structuredClone(initial);
    compactRetry.generatedAt = "2026-08-31T06:00:01.000Z";
    if (compactRetry.detectedDiscs.status === "loaded") {
      Object.assign(compactRetry.detectedDiscs.items[0]!.archiveRequest!, {
        status: "running",
        attemptCount: 2,
        updatedAt: "2026-08-31T06:00:01.000Z",
      });
    }
    if (compactRetry.archiveJobs.status === "loaded") {
      delete compactRetry.archiveJobs.items[0]!.investigation;
      compactRetry.archiveJobs.items.push({
        id: "archive-2",
        activityRevision: "2026-08-31T06:00:01.000Z",
        detectedDiscId: "disc-1",
        archiveRequestId: "request-1",
        attemptOrdinal: 2,
        discLabel: "LIVE_RETRY",
        opticalDriveName: "Upper drive",
        status: "running",
        progressPhase: "preparing",
        progressPercent: 0,
        progressBytes: 0,
        lastProgressAt: "2026-08-31T06:00:01.000Z",
      });
    }
    const detailedRetry = structuredClone(compactRetry);
    detailedRetry.generatedAt = "2026-08-31T06:00:02.000Z";
    if (detailedRetry.archiveJobs.status === "loaded") {
      detailedRetry.archiveJobs.items[0]!.investigation = {
        ...retryableInvestigation,
        retryability: "not_appropriate",
        retryabilityDetail:
          "A newer Archive Job attempt exists for this Archive Request.",
        suggestedAction:
          "Investigate the latest Archive Job attempt. Retry belongs to the Archive Request, not this historical attempt.",
      };
    }
    const loadSnapshot = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(detailedRetry);
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const onSnapshot = vi.fn();
    const stop = watchDashboardActivity({
      loadSnapshot,
      openEventSource: () => ({
        onerror: null,
        onopen: null,
        addEventListener(_type, listener) {
          dashboardListener = listener;
        },
        close: vi.fn(),
      }),
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    dashboardListener?.({
      data: JSON.stringify(compactRetry),
    } as MessageEvent<string>);
    await flushUntil(() => loadSnapshot.mock.calls.length === 2);
    await flushUntil(() => {
      const latest = onSnapshot.mock.calls.at(-1)?.[0] as
        | DashboardSnapshot
        | undefined;
      return latest?.archiveJobs.status === "loaded" &&
        latest.archiveJobs.items[0]?.investigation?.retryability ===
          "not_appropriate";
    });

    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(
      (onSnapshot.mock.calls[1]![0] as DashboardSnapshot).archiveJobs,
    ).toEqual(expect.objectContaining({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "archive-1",
          investigation: expect.objectContaining({
            retryability: "not_appropriate",
            suggestedAction: expect.stringContaining("latest Archive Job"),
          }),
        }),
      ]),
    }));
    stop();
  });

  it("retains every detail version from a full bounded activity snapshot", async () => {
    const detailed = emptySnapshot("2026-07-26T16:00:00.000Z");
    detailed.detectedDiscs = {
      status: "loaded",
      items: Array.from({ length: 120 }, (_, index) => ({
        id: `disc-${index}`,
        volumeLabel: `DISC_${index}`,
        discKind: "dvd" as const,
        status: "scanned" as const,
        opticalDriveName: "Upper drive",
        fingerprint: `sha256:disc-${index}`,
        titles: [{
          number: 1,
          durationSeconds: 60,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        }],
        detectedAt: new Date(
          Date.UTC(2026, 6, 26, 15, 0, index),
        ).toISOString(),
      })),
    };
    const activity = structuredClone(detailed);
    activity.generatedAt = "2026-07-26T16:00:01.000Z";
    if (activity.detectedDiscs.status === "loaded") {
      for (const disc of activity.detectedDiscs.items) {
        disc.titles = [];
      }
    }
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const loadDiscDetails = vi.fn(
      async (id: string, detectedAt: string): Promise<DashboardDetectedDiscDetails> => ({
        id,
        detectedAt,
        titles: [],
      }),
    );
    const stop = watchDashboardActivity({
      loadSnapshot: async () => detailed,
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

    expect(loadDiscDetails).not.toHaveBeenCalled();

    const changed = structuredClone(activity);
    if (changed.detectedDiscs.status === "loaded") {
      changed.detectedDiscs.items.at(-1)!.detectedAt =
        "2026-07-26T16:00:02.000Z";
    }
    dashboardListener?.({ data: JSON.stringify(changed) } as MessageEvent<string>);
    await vi.waitFor(() => expect(loadDiscDetails).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(changed) } as MessageEvent<string>);

    expect(loadDiscDetails).toHaveBeenCalledOnce();
    stop();
  });

  it("evicts the oldest attempted detail version at the shared cache bound", async () => {
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    initial.detectedDiscs = {
      status: "loaded",
      items: Array.from(
        { length: DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT },
        (_, index) => detectedDiscSummary(index),
      ),
    };
    const overflow = structuredClone(initial);
    if (overflow.detectedDiscs.status === "loaded") {
      overflow.detectedDiscs.items.push(
        detectedDiscSummary(DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT),
      );
    }
    const loadDiscDetails = vi.fn(
      async (
        id: string,
        detectedAt: string,
      ): Promise<DashboardDetectedDiscDetails> => ({
        id,
        detectedAt,
        titles: [],
      }),
    );
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

    dashboardListener?.({ data: JSON.stringify(overflow) } as MessageEvent<string>);
    await flushUntil(() => loadDiscDetails.mock.calls.length === 1);
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(overflow) } as MessageEvent<string>);
    await flushUntil(() => loadDiscDetails.mock.calls.length > 1);

    expect(loadDiscDetails.mock.calls[0]?.[0]).toBe(
      `disc-${DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT}`,
    );
    expect(loadDiscDetails.mock.calls[1]?.[0]).toBe("disc-0");
    stop();
  });

  it("evicts the oldest failed detail version at the shared cache bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T16:00:00.000Z"));
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const overflow = emptySnapshot("2026-07-26T16:00:01.000Z");
    overflow.detectedDiscs = {
      status: "loaded",
      items: Array.from(
        { length: DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT + 1 },
        (_, index) => detectedDiscSummary(index),
      ),
    };
    const loadDiscDetails = vi.fn().mockRejectedValue(
      new Error("temporary detail failure"),
    );
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

    for (const expectedCalls of [20, 40, 60, 80, 100, 120, 121]) {
      dashboardListener?.({
        data: JSON.stringify(overflow),
      } as MessageEvent<string>);
      await flushUntil(() => loadDiscDetails.mock.calls.length === expectedCalls);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    dashboardListener?.({ data: JSON.stringify(overflow) } as MessageEvent<string>);
    await flushUntil(() => loadDiscDetails.mock.calls.length === 122);

    expect(loadDiscDetails.mock.calls.at(-1)?.[0]).toBe("disc-0");
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

  it("retries a transient detail failure after bounded backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T16:00:00.000Z"));
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const activity = emptySnapshot("2026-07-26T16:00:01.000Z");
    activity.detectedDiscs = {
      status: "loaded",
      items: [
        {
          id: "disc-retry",
          volumeLabel: "RETRY_DISC",
          discKind: "dvd",
          status: "scanned",
          opticalDriveName: "Upper drive",
          fingerprint: "sha256:retry-disc",
          titles: [],
          detectedAt: "2026-07-26T16:00:01.000Z",
        },
      ],
    };
    const details: DashboardDetectedDiscDetails = {
      id: "disc-retry",
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
    const loadDiscDetails = vi.fn()
      .mockRejectedValueOnce(new Error("temporary detail failure"))
      .mockResolvedValueOnce(details);
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const onSnapshot = vi.fn();
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
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);
    expect(loadDiscDetails).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadDiscDetails).toHaveBeenCalledTimes(2);
    expect(
      (onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot).detectedDiscs,
    ).toEqual({
      status: "loaded",
      items: [expect.objectContaining({ id: "disc-retry", titles: details.titles })],
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
        detectedDiscId: "disc-1",
        archiveRequestId: "request-1",
        attemptOrdinal: 1,
        discLabel: "DISC",
        opticalDriveName: "Drive",
        status: "running",
        progressPhase: "copying",
        progressPercent: 10,
        progressBytes: 10,
        progressEtaSeconds: null,
        lastProgressAt: "2026-07-26T16:00:01.000Z",
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

  it("times out a hung detail request and continues hydrating later discs", async () => {
    vi.useFakeTimers();
    const initial = emptySnapshot("2026-07-26T16:00:00.000Z");
    const activity = emptySnapshot("2026-07-26T16:00:01.000Z");
    activity.detectedDiscs = {
      status: "loaded",
      items: ["disc-hung", "disc-next"].map((id) => ({
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
    let hungSignal: AbortSignal | undefined;
    const loadDiscDetails = vi.fn(
      (id: string, detectedAt: string, signal: AbortSignal) => {
        if (id === "disc-hung") {
          hungSignal = signal;
          return new Promise<DashboardDetectedDiscDetails>(() => undefined);
        }
        return Promise.resolve({
          id,
          detectedAt,
          titles: [{
            number: 1,
            durationSeconds: 90,
            chapters: 2,
            audioStreams: [],
            subtitles: [],
          }],
        });
      },
    );
    let dashboardListener: ((event: MessageEvent<string>) => void) | undefined;
    const onSnapshot = vi.fn();
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
      onSnapshot,
      onInitialLoadError: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dashboardListener?.({ data: JSON.stringify(activity) } as MessageEvent<string>);

    expect(loadDiscDetails).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(hungSignal?.aborted).toBe(true);
    expect(loadDiscDetails).toHaveBeenCalledTimes(2);
    expect(
      (onSnapshot.mock.calls.at(-1)?.[0] as DashboardSnapshot).detectedDiscs,
    ).toEqual({
      status: "loaded",
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "disc-next",
          titles: [expect.objectContaining({ number: 1 })],
        }),
      ]),
    });
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
            detectedDiscId: "disc-1",
            archiveRequestId: "request-1",
            attemptOrdinal: 1,
            discLabel: "LIVE_DISC",
            opticalDriveName: "Upper drive",
            status: "running",
            progressPhase: "copying",
            progressPercent: 42,
            progressBytes: 42,
            progressEtaSeconds: 125,
            lastProgressAt: "2026-07-26T15:58:00.000Z",
          },
        ],
      },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-1" as EncodeJobId,
            mediaTitle: "Live Movie",
            mediaYear: 2001,
            encodingProfileName: "DVD library",
            status: "running",
            progressPhase: null,
            progressPercent: 18,
            progressEtaSeconds: null,
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
            integrity: "unknown",
            badSectorCount: null,
            badAreaCount: null,
            badSectorRanges: null,
            archivedAt: "2026-07-26T15:00:00.000Z",
            catalogReviewedAt: null,
            catalogReviewOutcome: "needs_review",
            mappedMediaItemCount: 0,
            mappedMediaItemTitles: [],
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
