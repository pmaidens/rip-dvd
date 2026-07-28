import type { DashboardSnapshot } from "./dashboard";

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
  const activityIds = new Set(
    activity.detectedDiscs.items.map((disc) => disc.id),
  );
  return {
    ...activity,
    detectedDiscs: {
      status: "loaded",
      items: [
        ...detailed.detectedDiscs.items.filter(
          (disc) => !activityIds.has(disc.id),
        ),
        ...activity.detectedDiscs.items.map((disc) => ({
          ...disc,
          titles: detailedById.get(disc.id)?.titles ?? disc.titles,
        })),
      ],
    },
  };
}

function needsDetailRefresh(
  detailed: DashboardSnapshot,
  activity: DashboardSnapshot,
): boolean {
  if (activity.detectedDiscs.status !== "loaded") {
    return false;
  }
  if (detailed.detectedDiscs.status !== "loaded") {
    return true;
  }
  const detailedById = new Map(
    detailed.detectedDiscs.items.map((disc) => [disc.id, disc]),
  );
  return activity.detectedDiscs.items.some((disc) => {
    const cached = detailedById.get(disc.id);
    return cached === undefined || cached.detectedAt !== disc.detectedAt;
  });
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
  openEventSource = openDashboardEventSource,
  onSnapshot,
  onInitialLoadError,
  onStreamStatus = () => undefined,
}: WatchDashboardActivityOptions): () => void {
  let active = true;
  let eventSource: DashboardEventSource | undefined;
  let latestSnapshot: DashboardSnapshot | undefined;
  let detailRefresh: Promise<void> | undefined;

  void loadSnapshot()
    .then((snapshot) => {
      if (!active) {
        return;
      }
      latestSnapshot = snapshot;
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
            const refreshRequired = latestSnapshot
              ? needsDetailRefresh(latestSnapshot, activity)
              : false;
            latestSnapshot = latestSnapshot
              ? mergeActivitySnapshot(latestSnapshot, activity)
              : activity;
            onSnapshot(latestSnapshot);
            if (refreshRequired && detailRefresh === undefined) {
              detailRefresh = loadSnapshot()
                .then((snapshot) => {
                  if (!active) {
                    return;
                  }
                  latestSnapshot = snapshot;
                  onSnapshot(snapshot);
                })
                .catch(() => {
                  // Retain the last coherent snapshot and retry on later activity.
                })
                .finally(() => {
                  detailRefresh = undefined;
                });
            }
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
    eventSource?.close();
  };
}
