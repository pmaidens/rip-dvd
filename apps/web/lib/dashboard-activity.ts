import type {
  ArchiveRequestStatus,
  CatalogReviewArchiveView,
  CompletedCatalogReviewOutcome,
  DetectedDiscStatus,
} from "@rip-dvd/data-access";

import type {
  DashboardDetectedDiscDetails,
  DashboardSnapshot,
} from "./dashboard";
import { DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT } from "./dashboard-bounds";

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
  catalogReviewCursor?: string | null;
  catalogReviewView?: CatalogReviewArchiveView;
  catalogReviewQuery?: string;
  catalogReviewOutcome?: CompletedCatalogReviewOutcome;
  loadSnapshot?: (
    catalogReviewCursor: string | null,
  ) => Promise<DashboardSnapshot>;
  loadDiscDetails?: (
    id: string,
    detectedAt: string,
    signal: AbortSignal,
  ) => Promise<DashboardDetectedDiscDetails>;
  openEventSource?: (catalogReviewCursor: string | null) => DashboardEventSource;
  onSnapshot(snapshot: DashboardSnapshot): void;
  onInitialLoadError(): void;
  onStreamStatus?(status: DashboardStreamStatus): void;
}

export type DashboardStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable";

const DETAIL_REQUEST_TIMEOUT_MS = 10_000;

interface InsertionOrderedEntries<Key> {
  readonly size: number;
  delete(key: Key): boolean;
  keys(): IterableIterator<Key>;
}

function rememberBoundedEntry<Key>(
  entries: InsertionOrderedEntries<Key>,
  key: Key,
  maximumEntries: number,
  insert: () => void,
): void {
  entries.delete(key);
  insert();
  while (entries.size > maximumEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      break;
    }
    entries.delete(oldest.value);
  }
}

interface ArchiveJobInvestigationContext {
  requestStatus: ArchiveRequestStatus | null;
  discStatus: DetectedDiscStatus | null;
  latestJobId: string | null;
}

function archiveJobInvestigationContexts(
  snapshot: DashboardSnapshot,
): Map<string, ArchiveJobInvestigationContext> | undefined {
  if (
    snapshot.archiveJobs.status !== "loaded" ||
    snapshot.detectedDiscs.status !== "loaded"
  ) {
    return undefined;
  }
  const discsById = new Map(
    snapshot.detectedDiscs.items.map((disc) => [disc.id, disc]),
  );
  const latestJobByRequestId = new Map<string, { id: string; attempt: number }>();
  for (const job of snapshot.archiveJobs.items) {
    const latest = latestJobByRequestId.get(job.archiveRequestId);
    if (latest === undefined || job.attemptOrdinal > latest.attempt) {
      latestJobByRequestId.set(job.archiveRequestId, {
        id: job.id,
        attempt: job.attemptOrdinal,
      });
    }
  }
  return new Map(snapshot.archiveJobs.items.map((job) => {
    const disc = discsById.get(job.detectedDiscId);
    const request = disc?.archiveRequest?.id === job.archiveRequestId
      ? disc.archiveRequest
      : undefined;
    return [job.id, {
      requestStatus: request?.status ?? null,
      discStatus: disc?.status ?? null,
      latestJobId: latestJobByRequestId.get(job.archiveRequestId)?.id ?? null,
    }];
  }));
}

function investigationContextMatches(
  left: ArchiveJobInvestigationContext | undefined,
  right: ArchiveJobInvestigationContext | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    left.requestStatus === right.requestStatus &&
    left.discStatus === right.discStatus &&
    left.latestJobId === right.latestJobId;
}

function mergeActivitySnapshot(
  detailed: DashboardSnapshot,
  activity: DashboardSnapshot,
): DashboardSnapshot {
  const mergedOpticalDrives =
    detailed.opticalDrives.status === "loaded" &&
      activity.opticalDrives.status === "loaded"
      ? (() => {
          const detailedById = new Map(
            detailed.opticalDrives.items.map((drive) => [drive.id, drive]),
          );
          return {
            status: "loaded" as const,
            items: activity.opticalDrives.items.map((drive) => {
              const inspection = drive.currentInspection;
              const previous = detailedById.get(drive.id)?.currentInspection;
              if (inspection === null || inspection === undefined) {
                return drive;
              }
              const investigation = inspection.investigation ??
                (previous?.id === inspection.id &&
                    previous.status === inspection.status &&
                    previous.activityRevision === inspection.activityRevision
                  ? previous.investigation
                  : undefined);
              return {
                ...drive,
                currentInspection: {
                  ...inspection,
                  ...(investigation === undefined ? {} : { investigation }),
                },
              };
            }),
          };
        })()
      : activity.opticalDrives;
  const mergedDetectedDiscs =
    detailed.detectedDiscs.status === "loaded" &&
      activity.detectedDiscs.status === "loaded"
      ? (() => {
          const detailedById = new Map(
            detailed.detectedDiscs.items.map((disc) => [disc.id, disc]),
          );
          return {
            status: "loaded" as const,
            items: activity.detectedDiscs.items.map((disc) => ({
              ...disc,
              titles:
                detailedById.get(disc.id)?.detectedAt === disc.detectedAt
                  ? (detailedById.get(disc.id)?.titles ?? disc.titles)
                  : disc.titles,
            })),
          };
        })()
      : activity.detectedDiscs;
  const mergedArchiveJobs =
    detailed.archiveJobs.status === "loaded" &&
      activity.archiveJobs.status === "loaded"
      ? (() => {
          const detailedContexts = archiveJobInvestigationContexts(detailed);
          const activityContexts = archiveJobInvestigationContexts(activity);
          const detailedById = new Map(
            detailed.archiveJobs.items.map((job) => [job.id, job]),
          );
          return {
            status: "loaded" as const,
            items: activity.archiveJobs.items.map((job) => {
              const previous = detailedById.get(job.id);
              const investigation = job.investigation ??
                (previous?.status === job.status &&
                    previous.activityRevision === job.activityRevision &&
                    investigationContextMatches(
                      detailedContexts?.get(job.id),
                      activityContexts?.get(job.id),
                    )
                  ? previous.investigation
                  : undefined);
              return {
                ...job,
                ...(investigation === undefined ? {} : { investigation }),
              };
            }),
          };
        })()
      : activity.archiveJobs;
  return {
    ...activity,
    opticalDrives: mergedOpticalDrives,
    detectedDiscs: mergedDetectedDiscs,
    archiveJobs: mergedArchiveJobs,
  };
}

function hasMissingInvestigation(
  snapshot: DashboardSnapshot,
): boolean {
  const missingDiscInspection = snapshot.opticalDrives.status === "loaded" &&
    snapshot.opticalDrives.items.some(
      (drive) =>
        drive.currentInspection?.status === "failed" &&
        drive.currentInspection.investigation === undefined,
    );
  const missingArchiveJob = snapshot.archiveJobs.status === "loaded" &&
    snapshot.archiveJobs.items.some(
      (job) => job.status === "failed" && job.investigation === undefined,
    );
  return missingDiscInspection || missingArchiveJob;
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

function dashboardActivityUrl(
  path: "/api/dashboard" | "/api/dashboard/events",
  catalogReviewCursor: string | null,
  catalogReviewView: CatalogReviewArchiveView,
  catalogReviewQuery?: string,
  catalogReviewOutcome?: CompletedCatalogReviewOutcome,
): string {
  const parameters = new URLSearchParams();
  if (catalogReviewCursor) {
    parameters.set("catalogReviewCursor", catalogReviewCursor);
  }
  if (catalogReviewView !== "needs_review") {
    parameters.set("catalogReviewView", catalogReviewView);
  }
  if (catalogReviewQuery) {
    parameters.set("catalogReviewQuery", catalogReviewQuery);
  }
  if (catalogReviewOutcome) {
    parameters.set("catalogReviewOutcome", catalogReviewOutcome);
  }
  const query = parameters.toString();
  return query === "" ? path : `${path}?${query}`;
}

async function loadDashboardSnapshot(
  catalogReviewCursor: string | null,
  catalogReviewView: CatalogReviewArchiveView,
  catalogReviewQuery?: string,
  catalogReviewOutcome?: CompletedCatalogReviewOutcome,
): Promise<DashboardSnapshot> {
  const response = await fetch(
    dashboardActivityUrl(
      "/api/dashboard",
      catalogReviewCursor,
      catalogReviewView,
      catalogReviewQuery,
      catalogReviewOutcome,
    ),
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
  );
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

function openDashboardEventSource(
  catalogReviewCursor: string | null,
  catalogReviewView: CatalogReviewArchiveView,
  catalogReviewQuery?: string,
  catalogReviewOutcome?: CompletedCatalogReviewOutcome,
): DashboardEventSource {
  const source = new EventSource(
    dashboardActivityUrl(
      "/api/dashboard/events",
      catalogReviewCursor,
      catalogReviewView,
      catalogReviewQuery,
      catalogReviewOutcome,
    ),
  );
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
  catalogReviewCursor = null,
  catalogReviewView = "needs_review",
  catalogReviewQuery,
  catalogReviewOutcome,
  loadSnapshot,
  loadDiscDetails = loadDashboardDiscDetails,
  openEventSource,
  onSnapshot,
  onInitialLoadError,
  onStreamStatus = () => undefined,
}: WatchDashboardActivityOptions): () => void {
  const snapshotLoader = loadSnapshot ?? ((cursor) =>
    loadDashboardSnapshot(
      cursor,
      catalogReviewView,
      catalogReviewQuery,
      catalogReviewOutcome,
    ));
  const eventSourceFactory = openEventSource ?? ((cursor) =>
    openDashboardEventSource(
      cursor,
      catalogReviewView,
      catalogReviewQuery,
      catalogReviewOutcome,
    ));
  let active = true;
  let eventSource: DashboardEventSource | undefined;
  let latestSnapshot: DashboardSnapshot | undefined;
  let activeDetailAbortController: AbortController | undefined;
  let investigationRefresh: Promise<void> | undefined;
  const detailQueue: Array<{ id: string; detectedAt: string; key: string }> = [];
  const attemptedDetailVersions = new Set<string>();
  const failedDetailVersions = new Map<string, number>();
  let detailRefresh: Promise<void> | undefined;
  const maximumQueuedDetails = 20;
  const maximumRememberedVersions = DASHBOARD_ACTIVITY_DETECTED_DISC_LIMIT;
  const detailRetryDelayMs = 1_000;

  const publishLatestSnapshot = () => {
    if (latestSnapshot === undefined) {
      return;
    }
    if (hasMissingInvestigation(latestSnapshot)) {
      startInvestigationRefresh();
      return;
    }
    onSnapshot(latestSnapshot);
  };

  function startInvestigationRefresh() {
    if (!active || investigationRefresh !== undefined) {
      return;
    }
    let successfulRefreshStillMissingInvestigation = false;
    investigationRefresh = snapshotLoader(catalogReviewCursor)
      .then((detailed) => {
        if (!active) {
          return;
        }
        latestSnapshot = latestSnapshot === undefined
          ? detailed
          : mergeActivitySnapshot(detailed, latestSnapshot);
        successfulRefreshStillMissingInvestigation =
          hasMissingInvestigation(latestSnapshot);
        publishLatestSnapshot();
      })
      .catch(() => {
        // Retain the last complete dashboard snapshot and retry on new activity.
      })
      .finally(() => {
        investigationRefresh = undefined;
        if (successfulRefreshStillMissingInvestigation) {
          startInvestigationRefresh();
        }
      });
  }

  const rememberAttempt = (key: string) => {
    rememberBoundedEntry(
      attemptedDetailVersions,
      key,
      maximumRememberedVersions,
      () => attemptedDetailVersions.add(key),
    );
  };

  const rememberFailure = (key: string) => {
    rememberBoundedEntry(
      failedDetailVersions,
      key,
      maximumRememberedVersions,
      () => failedDetailVersions.set(key, Date.now() + detailRetryDelayMs),
    );
  };

  const startNextDetailRefresh = () => {
    if (!active || detailRefresh !== undefined) {
      return;
    }
    const next = detailQueue.shift();
    if (!next) {
      return;
    }
    const requestAbortController = new AbortController();
    activeDetailAbortController = requestAbortController;
    let detailTimeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(requestAbortController.signal.reason);
      requestAbortController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      removeAbortListener = () =>
        requestAbortController.signal.removeEventListener("abort", onAbort);
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      detailTimeout = setTimeout(() => {
        const error = new Error("Detected Disc detail request timed out");
        requestAbortController.abort(error);
        reject(error);
      }, DETAIL_REQUEST_TIMEOUT_MS);
    });
    detailRefresh = Promise.race([
      loadDiscDetails(
        next.id,
        next.detectedAt,
        requestAbortController.signal,
      ),
      aborted,
      timedOut,
    ])
      .then((details) => {
        failedDetailVersions.delete(next.key);
        if (!active || latestSnapshot === undefined) {
          return;
        }
        latestSnapshot = mergeDiscDetails(latestSnapshot, details);
        publishLatestSnapshot();
      })
      .catch(() => {
        attemptedDetailVersions.delete(next.key);
        if (active) {
          rememberFailure(next.key);
        }
      })
      .finally(() => {
        clearTimeout(detailTimeout);
        removeAbortListener();
        if (activeDetailAbortController === requestAbortController) {
          activeDetailAbortController = undefined;
        }
        detailRefresh = undefined;
        startNextDetailRefresh();
      });
  };

  const queueMissingDetails = (snapshot: DashboardSnapshot) => {
    if (snapshot.detectedDiscs.status !== "loaded") {
      return;
    }
    const currentVersions = new Set(
      snapshot.detectedDiscs.items.map(
        (disc) => `${disc.id}\0${disc.detectedAt}`,
      ),
    );
    for (const key of attemptedDetailVersions) {
      if (!currentVersions.has(key)) {
        attemptedDetailVersions.delete(key);
      }
    }
    for (const key of failedDetailVersions.keys()) {
      if (!currentVersions.has(key)) {
        failedDetailVersions.delete(key);
      }
    }
    for (let index = detailQueue.length - 1; index >= 0; index -= 1) {
      if (!currentVersions.has(detailQueue[index]!.key)) {
        detailQueue.splice(index, 1);
      }
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

  void snapshotLoader(catalogReviewCursor)
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
        eventSource = eventSourceFactory(catalogReviewCursor);
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
            publishLatestSnapshot();
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
    activeDetailAbortController?.abort();
    eventSource?.close();
  };
}
