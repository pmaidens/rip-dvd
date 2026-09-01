// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DiscSelectionId,
  EncodeJobId,
  EncodeJobStatus,
  EncodingProfileId,
} from "@rip-dvd/data-access";

import { watchDashboardActivity } from "../lib/dashboard-activity";
import type {
  DashboardEncodeJob,
  DashboardSnapshot,
} from "../lib/dashboard";
import {
  filterEncodeJobs,
  OperationsDashboard,
} from "./operations-dashboard";

vi.mock("../lib/dashboard-activity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/dashboard-activity")>();
  return { ...actual, watchDashboardActivity: vi.fn() };
});

const encodeStatuses: EncodeJobStatus[] = [
  "queued",
  "running",
  "cancellation_requested",
  "completed",
  "failed",
  "cancelled",
];

function encodeJob(status: EncodeJobStatus): DashboardEncodeJob {
  return {
    id: `${status}-job` as EncodeJobId,
    mediaTitle: `${status} title`,
    mediaYear: null,
    encodingProfileName: "DVD library · Version 1",
    status,
    progressPhase: null,
    progressPercent: status === "completed" ? 100 : 0,
    progressEtaSeconds: null,
  };
}

afterEach(() => {
  vi.mocked(watchDashboardActivity).mockReset();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("encoding page tabs", () => {
  it("puts only completed jobs in Completed", () => {
    const state = {
      status: "loaded" as const,
      items: encodeStatuses.map(encodeJob),
    };

    const inProgress = filterEncodeJobs(state, "in_progress");
    const completed = filterEncodeJobs(state, "completed");

    expect(inProgress.status).toBe("loaded");
    expect(completed.status).toBe("loaded");
    if (inProgress.status !== "loaded" || completed.status !== "loaded") {
      throw new Error("Expected loaded Encode Job filters");
    }
    expect(inProgress.items.map((job) => job.status)).toEqual([
      "queued",
      "running",
      "cancellation_requested",
      "failed",
      "cancelled",
    ]);
    expect(completed.items.map((job) => job.status)).toEqual(["completed"]);
  });

  it("keeps the in-memory worklist when moving between accessible tabs", async () => {
    const selectionId = "selection-1" as DiscSelectionId;
    const profileId = "profile-1" as EncodingProfileId;
    const snapshot: DashboardSnapshot = {
      generatedAt: "2026-08-28T12:00:00.000Z",
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: { status: "loaded", items: [] },
      workerIncidents: { status: "loaded", items: [] },
      encodeJobs: {
        status: "loaded",
        items: encodeStatuses.map(encodeJob),
      },
      catalogReview: { status: "loaded", items: [] },
    };
    vi.mocked(watchDashboardActivity).mockImplementation(
      ({ onSnapshot, onStreamStatus }) => {
        onSnapshot(snapshot);
        onStreamStatus?.("live");
        return () => undefined;
      },
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/encoding-profiles") {
        return Response.json({ profiles: [] });
      }
      if (path.startsWith("/api/encode-jobs?")) {
        return Response.json({
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 1, reEncode: 0 },
          selections: [{
            id: selectionId,
            mediaItemId: "movie-1",
            mediaTitle: "Keep this worklist row",
            mediaYear: 2001,
            sourceDescription: "DVD main feature",
            hasCompletedEncode: false,
            priorCompletedJob: null,
            logicalJob: null,
            suggestedOutputPath:
              "/media/movies/Keep this worklist row (2001).mkv",
          }],
          profiles: [{
            id: profileId,
            displayName: "DVD library",
            version: 1,
          }],
          page: {
            offset: 0,
            limit: 20,
            total: 1,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    try {
      await act(async () => {
        root.render(<OperationsDashboard page="encoding" />);
        await settle();
      });
      await act(async () => {
        await settle();
      });

      const tabs = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      ];
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "Current jobs",
        "Queue new jobs",
        "Settings",
      ]);
      expect(tabs.map((tab) => tab.getAttribute("aria-controls"))).toEqual([
        "encoding-panel-current",
        "encoding-panel-queue",
        "encoding-panel-settings",
      ]);
      expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
      expect(container.textContent).toContain("queued title");
      expect(container.querySelector("#encoding-panel-current")?.textContent)
        .not.toContain("completed title");

      const completedFilter = [...container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Current job status filters"] button',
      )].find((button) => button.textContent?.includes("Completed"));
      if (!completedFilter) {
        throw new Error("Expected Completed filter");
      }
      await act(async () => completedFilter.click());
      expect(container.querySelector("#encoding-panel-current")?.textContent)
        .toContain("completed title");
      expect(container.querySelector("#encoding-panel-current")?.textContent)
        .not.toContain("failed title");

      await act(async () => {
        tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }));
      });
      expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs[1]);

      const profile = container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      );
      const checkbox = container.querySelector<HTMLInputElement>(
        'input[aria-label^="Select Keep this worklist row"]',
      );
      if (!profile || !checkbox) {
        throw new Error("Expected loaded queue options");
      }
      await act(async () => {
        profile.value = profileId;
        profile.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      });
      await act(async () => checkbox.click());
      const addToWorklist = [...container.querySelectorAll<HTMLButtonElement>(
        "button",
      )].find((button) =>
        button.textContent?.includes("Add selected to worklist")
      );
      if (!addToWorklist) {
        throw new Error("Expected Add selected to worklist button");
      }
      await act(async () => addToWorklist.click());
      expect(container.querySelector(".encode-worklist-table")?.textContent)
        .toContain("Keep this worklist row");

      await act(async () => tabs[2]?.click());
      expect(container.querySelector("#encoding-panel-queue")?.hasAttribute(
        "hidden",
      )).toBe(true);
      await act(async () => tabs[0]?.click());
      await act(async () => tabs[1]?.click());

      expect(container.querySelector(".encode-worklist-table")?.textContent)
        .toContain("Keep this worklist row");
      expect(container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      )?.value).toBe(profileId);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
