import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";
import {
  readDashboardSnapshot,
  type DashboardSnapshot,
} from "../../../../lib/dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RECONNECT_DELAY_MS = 3_000;
const ACTIVITY_RECORD_LIMIT = 20;

interface DashboardEventResponseOptions {
  signal: AbortSignal;
  pollIntervalMs?: number;
}

function formatDashboardEvent(snapshot: DashboardSnapshot): string {
  return [
    `id: ${snapshot.generatedAt}`,
    "event: dashboard",
    `data: ${JSON.stringify(snapshot)}`,
    "",
    "",
  ].join("\n");
}

export function createDashboardEventResponse(
  access: DataAccess,
  {
    signal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  }: DashboardEventResponseOptions,
): Response {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const cleanup = () => {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    removeAbortListener?.();
    removeAbortListener = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.close();
      };
      const fail = (error: unknown) => {
        if (closed) {
          return;
        }
        closed = true;
        cleanup();
        controller.error(error);
      };
      const sendSnapshot = (prefix = "", force = false) => {
        if (
          closed ||
          (!force &&
            (controller.desiredSize === null || controller.desiredSize <= 0))
        ) {
          return;
        }
        const snapshot = readDashboardSnapshot(access, {
          activityLimit: ACTIVITY_RECORD_LIMIT,
          includeDetectedDiscDetails: false,
        });
        controller.enqueue(
          encoder.encode(`${prefix}${formatDashboardEvent(snapshot)}`),
        );
      };

      sendSnapshot(`retry: ${RECONNECT_DELAY_MS}\n`, true);

      if (signal.aborted) {
        close();
        return;
      }

      const onAbort = () => close();
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      interval = setInterval(() => {
        try {
          sendSnapshot();
        } catch (error) {
          fail(error);
        }
      }, pollIntervalMs);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

export function createDashboardEventRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Response {
  try {
    return createDashboardEventResponse(getAccess(), {
      signal: request.signal,
    });
  } catch {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 503,
    });
  }
}

export function GET(request: Request): Response {
  return createDashboardEventRoute(request);
}
