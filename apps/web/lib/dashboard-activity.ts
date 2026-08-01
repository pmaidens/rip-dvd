import type {
  DashboardDetectedDiscDetails,
  DashboardSnapshot,
} from "./dashboard";

export interface DashboardEventSource {
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  addEventListener(
    type: "dashboard",
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}

interface WatchDashboardActivityOptions {
  loadSnapshot?: () => Promise<DashboardSnapshot>;
  loadDiscDetails?: (
    id: string,
    detectedAt: string,
    signal: AbortSignal,
  ) => Promise<DashboardDetectedDiscDetails>;
  openEventSource?: () => DashboardEventSource;
  onSnapshot(snapshot: DashboardSnapshot): void;
  onInitialLoadError(): void;
  onStreamStatus?(status: DashboardStreamStatus): void;
}

export type DashboardStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable";

function mergeActivitySnapshot(
  detailed: DashboardSnapshot,
  activity: DashboardSnapshot,
): DashboardSnapshot {
  if (
    detailed.detectedDiscs.status !== "loaded" ||
    activity.detectedDiscs.status !== "loaded"
  ) {
    return activity;
  }
  const detailedById = new Map(
    detailed.detectedDiscs.items.map((disc) => [disc.id, disc]),
  );
  return {
    ...activity,
    detectedDiscs: {
      status: "loaded",
      items: activity.detectedDiscs.items.map((disc) => ({
        ...disc,
        titles:
          detailedById.get(disc.id)?.detectedAt === disc.detectedAt
            ? (detailedById.get(disc.id)?.titles ?? disc.titles)
            : disc.titles,
      })),
    },
  };
}

function mergeDiscDetails(
  snapshot: DashboardSnapshot,
  details: DashboardDetectedDiscDetails,
): DashboardSnapshot {
  if (snapshot.detectedDiscs.status !== "loaded") {
    return snapshot;
  }
  return {
    ...snapshot,
    detectedDiscs: {
      status: "loaded",
      items: snapshot.detectedDiscs.items.map((disc) =>
        disc.id === details.id && disc.detectedAt === details.detectedAt
          ? { ...disc, titles: details.titles }
          : disc,
      ),
    },
  };
}

async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  const response = await fetch("/api/dashboard", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Dashboard request failed");
  }
  return (await response.json()) as DashboardSnapshot;
}

async function loadDashboardDiscDetails(
  id: string,
  detectedAt: string,
  signal: AbortSignal,
): Promise<DashboardDetectedDiscDetails> {
  const response = await fetch(
    `/api/dashboard/discs/${encodeURIComponent(id)}?detectedAt=${encodeURIComponent(detectedAt)}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error("Detected Disc detail request failed");
  }
  return (await response.json()) as DashboardDetectedDiscDetails;
}

function openDashboardEventSource(): DashboardEventSource {
  const source = new EventSource("/api/dashboard/events");
  const adapter: DashboardEventSource = {
    onerror: null,
    onopen: null,
    addEventListener(type, listener) {
      source.addEventListener(type, listener as EventListener);
    },
    close() {
      source.close();
    },
  };
  source.addEventListener("open", () => adapter.onopen?.());
  source.addEventListener("error", () => adapter.onerror?.());
  return adapter;
}

export function watchDashboardActivity({
  loadSnapshot = loadDashboardSnapshot,
  loadDiscDetails = loadDashboardDiscDetails,
  openEventSource = openDashboardEventSource,
  onSnapshot,
  onInitialLoadError,
  onStreamStatus = () => undefined,
}: WatchDashboardActivityOptions): () => void {
  let active = true;
  let eventSource: DashboardEventSource | undefined;
  let latestSnapshot: DashboardSnapshot | undefined;
  const detailAbortController = new AbortController();
  const detailQueue: Array<{ id: string; detectedAt: string; key: string }> = [];
  const attemptedDetailVersions = new Set<string>();
  const failedDetailVersions = new Map<string, number>();
  let detailRefresh: Promise<void> | undefined;
  const maximumQueuedDetails = 20;
  const maximumRememberedVersions = 100;
  const detailRetryDelayMs = 1_000;

  const rememberAttempt = (key: string) => {
    attemptedDetailVersions.delete(key);
    attemptedDetailVersions.add(key);
    while (attemptedDetailVersions.size > maximumRememberedVersions) {
      const oldest = attemptedDetailVersions.values().next().value;
      if (oldest === undefined) {
        break;
      }
      attemptedDetailVersions.delete(oldest);
    }
  };

  const rememberFailure = (key: string) => {
    failedDetailVersions.delete(key);
    failedDetailVersions.set(key, Date.now() + detailRetryDelayMs);
    while (failedDetailVersions.size > maximumRememberedVersions) {
      const oldest = failedDetailVersions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      failedDetailVersions.delete(oldest);
    }
  };

  const startNextDetailRefresh = () => {
    if (!active || detailRefresh !== undefined) {
      return;
    }
    const next = detailQueue.shift();
    if (!next) {
      return;
    }
    detailRefresh = loadDiscDetails(
      next.id,
      next.detectedAt,
      detailAbortController.signal,
    )
      .then((details) => {
        failedDetailVersions.delete(next.key);
        if (!active || latestSnapshot === undefined) {
          return;
        }
        latestSnapshot = mergeDiscDetails(latestSnapshot, details);
        onSnapshot(latestSnapshot);
      })
      .catch(() => {
        attemptedDetailVersions.delete(next.key);
        if (active) {
          rememberFailure(next.key);
        }
      })
      .finally(() => {
        detailRefresh = undefined;
        startNextDetailRefresh();
      });
  };

  const queueMissingDetails = (snapshot: DashboardSnapshot) => {
    if (snapshot.detectedDiscs.status !== "loaded") {
      return;
    }
    for (const disc of snapshot.detectedDiscs.items) {
      const key = `${disc.id}\0${disc.detectedAt}`;
      if (attemptedDetailVersions.has(key)) {
        continue;
      }
      const retryAfter = failedDetailVersions.get(key);
      if (retryAfter !== undefined) {
        if (retryAfter > Date.now()) {
          continue;
        }
        failedDetailVersions.delete(key);
      }
      if (detailQueue.length < maximumQueuedDetails) {
        rememberAttempt(key);
        detailQueue.push({ id: disc.id, detectedAt: disc.detectedAt, key });
      }
    }
    startNextDetailRefresh();
  };

  void loadSnapshot()
    .then((snapshot) => {
      if (!active) {
        return;
      }
      latestSnapshot = snapshot;
      if (snapshot.detectedDiscs.status === "loaded") {
        for (const disc of snapshot.detectedDiscs.items) {
          rememberAttempt(`${disc.id}\0${disc.detectedAt}`);
        }
      }
      onSnapshot(snapshot);
      try {
        onStreamStatus("connecting");
        eventSource = openEventSource();
        eventSource.onopen = () => {
          if (active) {
            onStreamStatus("live");
          }
        };
        eventSource.onerror = () => {
          if (active) {
            onStreamStatus("reconnecting");
          }
        };
        eventSource.addEventListener("dashboard", (event) => {
          if (!active) {
            return;
          }
          try {
            const activity = JSON.parse(event.data) as DashboardSnapshot;
            latestSnapshot = latestSnapshot
              ? mergeActivitySnapshot(latestSnapshot, activity)
              : activity;
            onSnapshot(latestSnapshot);
            queueMissingDetails(activity);
          } catch {
            // Ignore malformed events and retain the last database snapshot.
          }
        });
      } catch {
        // The HTTP snapshot remains the dashboard fallback.
        onStreamStatus("unavailable");
      }
    })
    .catch(() => {
      if (active) {
        onInitialLoadError();
      }
    });

  return () => {
    active = false;
    detailAbortController.abort();
    eventSource?.close();
  };
}
