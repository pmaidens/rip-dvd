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

  void loadSnapshot()
    .then((snapshot) => {
      if (!active) {
        return;
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
            onSnapshot(JSON.parse(event.data) as DashboardSnapshot);
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
