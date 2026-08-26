// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  DiscSelectionId,
  EncodeJobId,
  EncodingProfileId,
} from "@rip-dvd/data-access";

import {
  cancelEncodeJob,
  EncodeJobsManager,
  EncodeJobsView,
  queueEncodeJob,
  requestEncodeJobOptions,
  requestQueueLogicalJobResolutions,
  retryEncodeJob,
} from "./encode-jobs";
import type {
  EncodeProfileOption,
  EncodeSelectionOption,
  QueueEncodeJobInput,
} from "./encode-jobs";
import type { DashboardEncodeJob } from "../lib/dashboard";

describe("EncodeJobsView", () => {
  it("keeps Disc Selection, Encoding Profile, and Encode Job identifiers distinct", () => {
    expectTypeOf<EncodeSelectionOption["id"]>()
      .toEqualTypeOf<DiscSelectionId>();
    expectTypeOf<EncodeProfileOption["id"]>()
      .toEqualTypeOf<EncodingProfileId>();
    expectTypeOf<DashboardEncodeJob["id"]>().toEqualTypeOf<EncodeJobId>();

    if (false) {
      const selectionId = undefined as unknown as DiscSelectionId;
      const profileId = undefined as unknown as EncodingProfileId;
      const jobId = undefined as unknown as EncodeJobId;

      const input: QueueEncodeJobInput = {
        discSelectionId: selectionId,
        encodingProfileId: profileId,
        outputPath: "/media/movies/Queue Me (2001).mkv",
      };
      void queueEncodeJob(input);
      void cancelEncodeJob(jobId);
      void retryEncodeJob(jobId);

      // @ts-expect-error Encoding Profile IDs cannot identify Disc Selections.
      input.discSelectionId = profileId;
      // @ts-expect-error Disc Selection IDs cannot identify Encoding Profiles.
      input.encodingProfileId = selectionId;
      // @ts-expect-error Disc Selection IDs cannot identify Encode Jobs.
      void cancelEncodeJob(selectionId);
      // @ts-expect-error Disc Selection IDs cannot identify Encode Jobs.
      void retryEncodeJob(selectionId);
    }
  });

  it("renders a checked first-encode picker beside an empty worklist", () => {
    const selection: EncodeSelectionOption = {
      id: "selection-1" as DiscSelectionId,
      mediaItemId: "movie-1",
      mediaTitle: "Queue Me",
      mediaYear: 2001,
      sourceDescription: "DVD main feature",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: null,
      suggestedOutputPath:
        "/media/movies/Queue Me (2001)/Queue Me (2001).mkv",
    };
    const profileId = "profile-v2" as EncodingProfileId;
    const html = renderToStaticMarkup(
      <EncodeJobsView
        selectedProfileId={profileId}
        checkedSelections={[selection]}
        worklistRows={[]}
        queueSummary={null}
        profileUnavailable={false}
        state={{
          status: "loaded",
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 1, reEncode: 0 },
          selections: [selection],
          profiles: [{
            id: profileId,
            displayName: "DVD library",
            version: 2,
          }],
          page: {
            offset: 0,
            limit: 100,
            total: 1,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: true,
          },
        }}
        isSaving={false}
        requestError={null}
        onToggleSelection={() => undefined}
        onAddSelected={() => undefined}
        onWorklistPath={() => undefined}
        onRemoveWorklistRow={() => undefined}
        onClearWorklist={() => undefined}
        onQueueWorklist={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Queue Me (2001) · DVD main feature");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Add selected to worklist");
    expect(html).toContain("Encode worklist");
    expect(html).toContain("Queue 0 Encode Jobs");
    expect(html).toContain("Next active profiles");
    expect(html).toContain(
      '<button type="button">Next active profiles</button>',
    );
  });

  it("allows active profile jobs to join the worklist as unavailable rows", () => {
    const profileId = "profile-v2" as EncodingProfileId;
    const selection: EncodeSelectionOption = {
      id: "selection-active" as DiscSelectionId,
      mediaItemId: "movie-active",
      mediaTitle: "Already queued",
      mediaYear: 2002,
      sourceDescription: "DVD main feature",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: {
        id: "job-active" as EncodeJobId,
        encodingProfileId: profileId,
        outputPath: "/media/movies/Already queued (2002).mkv",
        status: "queued",
        queueAvailable: false,
      },
      suggestedOutputPath: "/media/movies/Already queued (2002).mkv",
    };
    const html = renderToStaticMarkup(
      <EncodeJobsView
        selectedProfileId={profileId}
        checkedSelections={[]}
        worklistRows={[]}
        queueSummary={null}
        profileUnavailable={false}
        state={{
          status: "loaded",
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 1, reEncode: 0 },
          selections: [selection],
          profiles: [{
            id: profileId,
            displayName: "DVD library",
            version: 2,
          }],
          page: {
            offset: 0,
            limit: 100,
            total: 1,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: false,
          },
        }}
        isSaving={false}
        requestError={null}
        onToggleSelection={() => undefined}
        onAddSelected={() => undefined}
        onWorklistPath={() => undefined}
        onRemoveWorklistRow={() => undefined}
        onClearWorklist={() => undefined}
        onQueueWorklist={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Select Already queued");
    expect(html).toContain("This Encode Job is already queued.");
    expect(html).toContain(
      "Reserved final output: /media/movies/Already queued (2002).mkv",
    );
    expect(html).toContain("Already queued</small>");
  });

  it("offers a failed-only retry while untouched rows remain ready", () => {
    const profileId = "profile-v2" as EncodingProfileId;
    const selection = (id: string, title: string): EncodeSelectionOption => ({
      id: id as DiscSelectionId,
      mediaItemId: `movie-${id}`,
      mediaTitle: title,
      mediaYear: 2003,
      sourceDescription: "DVD main feature",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: null,
      suggestedOutputPath: `/media/movies/${title} (2003).mkv`,
    });
    const failed = selection("failed", "Needs correction");
    const ready = selection("ready", "Not attempted");
    const html = renderToStaticMarkup(
      <EncodeJobsView
        selectedProfileId={profileId}
        checkedSelections={[]}
        worklistRows={[
          {
            selection: failed,
            outputPath: failed.suggestedOutputPath!,
            status: "failed",
            error: "Reserved output",
            attemptedProfile: {
              id: profileId,
              displayName: "DVD library",
              version: 2,
            },
          },
          {
            selection: ready,
            outputPath: ready.suggestedOutputPath!,
            status: "ready",
            error: null,
            attemptedProfile: null,
          },
        ]}
        queueSummary={null}
        profileUnavailable={false}
        state={{
          status: "loaded",
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 2, reEncode: 0 },
          selections: [failed, ready],
          profiles: [{
            id: profileId,
            displayName: "DVD library",
            version: 2,
          }],
          page: {
            offset: 0,
            limit: 100,
            total: 2,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: false,
          },
        }}
        isSaving={false}
        requestError={null}
        onToggleSelection={() => undefined}
        onAddSelected={() => undefined}
        onWorklistPath={() => undefined}
        onRemoveWorklistRow={() => undefined}
        onClearWorklist={() => undefined}
        onQueueWorklist={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Retry 1 failed Encode Job");
    expect(html).not.toContain("Queue 2 Encode Jobs");
  });

  it("renders mixed row actions and excludes active jobs from the queue count", () => {
    const profileId = "profile-v2" as EncodingProfileId;
    const profile = {
      id: profileId,
      displayName: "DVD library",
      version: 2,
    };
    const selection = (
      id: string,
      title: string,
      logicalJob: EncodeSelectionOption["logicalJob"],
      hasCompletedEncode = false,
    ): EncodeSelectionOption => ({
      id: id as DiscSelectionId,
      mediaItemId: `movie-${id}`,
      mediaTitle: title,
      mediaYear: 2003,
      sourceDescription: "DVD main feature",
      hasCompletedEncode,
      priorCompletedJob: hasCompletedEncode
        ? {
            id: "prior-completed" as EncodeJobId,
            status: "completed",
            profile,
          }
        : null,
      logicalJob,
      suggestedOutputPath: `/media/movies/${title} (2003).mkv`,
    });
    const newSelection = selection("new", "New row", null);
    const failedSelection = selection("failed", "Retry row", {
      id: "failed-job" as EncodeJobId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Retry row authoritative.mkv",
      status: "failed",
      queueAvailable: true,
    });
    const completedSelection = selection("completed", "Re-encode row", {
      id: "completed-job" as EncodeJobId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Re-encode row authoritative.mkv",
      status: "completed",
      queueAvailable: true,
    }, true);
    const runningSelection = selection("running", "Running row", {
      id: "running-job" as EncodeJobId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Running row authoritative.mkv",
      status: "running",
      queueAvailable: false,
    });
    const rows = [
      newSelection,
      failedSelection,
      completedSelection,
      runningSelection,
    ].map((candidate) => ({
      selection: candidate,
      outputPath: candidate.logicalJob?.outputPath ??
        candidate.suggestedOutputPath!,
      status: "ready" as const,
      error: null,
      attemptedProfile: null,
    }));

    const html = renderToStaticMarkup(
      <EncodeJobsView
        selectedProfileId={profileId}
        checkedSelections={[]}
        worklistRows={rows}
        queueSummary={null}
        profileUnavailable={false}
        state={{
          status: "loaded",
          historyGroup: "re_encode",
          query: "",
          counts: { notEncoded: 3, reEncode: 1 },
          selections: [completedSelection],
          profiles: [profile],
          page: {
            offset: 0,
            limit: 100,
            total: 1,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: false,
          },
        }}
        isSaving={false}
        requestError={null}
        onToggleSelection={() => undefined}
        onAddSelected={() => undefined}
        onWorklistPath={() => undefined}
        onRemoveWorklistRow={() => undefined}
        onClearWorklist={() => undefined}
        onQueueWorklist={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Queue 3 Encode Jobs");
    expect(html).toContain("New Encode Job");
    expect(html).toContain("Retry");
    expect(html).toContain("Re-encode");
    expect(html).toContain("Running");
    expect(html).toContain("DVD library, version 2 · Completed");
    expect(html).toContain(
      "The existing logical Encode Job retains this output reservation.",
    );
    expect(html).toContain(
      'aria-label="Final output path for Retry row" readOnly="" value="/media/movies/Retry row authoritative.mkv"',
    );
  });

  it("exposes editable worklist paths only with a visible shared profile", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const onWorklistPath = vi.fn();
    const onQueueWorklist = vi.fn();
    const profileId = "profile-v2" as EncodingProfileId;
    const selection: EncodeSelectionOption = {
      id: "selection-1" as DiscSelectionId,
      mediaItemId: "movie-1",
      mediaTitle: "Queue Me",
      mediaYear: 2001,
      sourceDescription: "DVD main feature",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: null,
      suggestedOutputPath:
        "/media/movies/Queue Me (2001)/Queue Me (2001).mkv",
    };
    const render = (profileVisible: boolean) => (
      <EncodeJobsView
        selectedProfileId={profileId}
        checkedSelections={[]}
        worklistRows={[{
          selection,
          outputPath: selection.suggestedOutputPath!,
          status: "ready",
          error: null,
          attemptedProfile: null,
        }]}
        queueSummary={null}
        profileUnavailable={false}
        state={{
          status: "loaded",
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 1, reEncode: 0 },
          selections: [selection],
          profiles: [{
            id: (profileVisible ? profileId : "profile-page-2") as EncodingProfileId,
            displayName: "DVD library",
            version: 2,
          }],
          page: {
            offset: 0,
            limit: 100,
            total: 1,
            hasPrevious: false,
            hasNext: false,
          },
          profilePage: {
            offset: profileVisible ? 0 : 100,
            limit: 100,
            hasPrevious: !profileVisible,
            hasNext: false,
          },
        }}
        isSaving={false}
        requestError={null}
        onToggleSelection={() => undefined}
        onAddSelected={() => undefined}
        onWorklistPath={onWorklistPath}
        onRemoveWorklistRow={() => undefined}
        onClearWorklist={() => undefined}
        onQueueWorklist={onQueueWorklist}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />
    );

    await act(async () => root.render(render(true)));
    const outputPath = container.querySelector<HTMLInputElement>(
      'input[aria-label="Final output path for Queue Me"]',
    );
    const queueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Queue 1 Encode Job",
    );
    if (!outputPath || !queueButton) {
      throw new Error("Expected worklist path and queue action");
    }
    expect(outputPath.readOnly).toBe(false);
    expect(queueButton.disabled).toBe(false);

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!valueSetter) {
        throw new Error("Expected native input value setter");
      }
      valueSetter.call(outputPath, "/media/movies/Operator choice.mkv");
      outputPath.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onWorklistPath).toHaveBeenCalledWith(
      selection.id,
      "/media/movies/Operator choice.mkv",
    );

    await act(async () => root.render(render(false)));
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Queue 1 Encode Job",
      )?.disabled,
    ).toBe(true);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("loads options and submits a same-origin JSON queue request", async () => {
    const selectionId = "selection-1" as DiscSelectionId;
    const profileId = "profile-v2" as EncodingProfileId;
    const jobId = "job-1" as EncodeJobId;
    const canonicalOutputPath = "/media/movies/Queue Me (2001).mkv";
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("selectionOffset")
        ? Response.json({ selections: [], profiles: [], page: {} })
        : Response.json({
            job: {
              id: "job-1",
              encodingProfileId: profileId,
              status: "queued",
              outputPath: canonicalOutputPath,
            },
          }));

    await requestEncodeJobOptions({
      selectionOffset: 100,
      profileOffset: 200,
      historyGroup: "re_encode",
      query: "queue me",
      encodingProfileId: profileId,
    }, fetcher);
    const queuedJob = await queueEncodeJob({
      discSelectionId: selectionId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Queue Me (2001).mkv",
    }, fetcher);
    await cancelEncodeJob(jobId, fetcher);
    await retryEncodeJob(jobId, fetcher);

    expect(queuedJob).toEqual({
      id: "job-1",
      encodingProfileId: profileId,
      status: "queued",
      outputPath: canonicalOutputPath,
      queueAvailable: false,
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/encode-jobs?historyGroup=re_encode&selectionOffset=100&profileOffset=200&query=queue+me&encodingProfileId=profile-v2",
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/encode-jobs", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        discSelectionId: "selection-1",
        encodingProfileId: "profile-v2",
        outputPath: "/media/movies/Queue Me (2001).mkv",
      }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/encode-jobs", {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "cancel", encodeJobId: "job-1" }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(4, "/api/encode-jobs", {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "requeue", encodeJobId: "job-1" }),
    });
  });

  it("resolves selected-profile jobs for bounded replacement recovery", async () => {
    const profileId = "profile-v2" as EncodingProfileId;
    const firstId = "selection-1" as DiscSelectionId;
    const secondId = "selection-2" as DiscSelectionId;
    const logicalJob = {
      id: "job-2" as EncodeJobId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Selection 2.mkv",
      status: "failed" as const,
      queueAvailable: true,
    };
    const fetcher = vi.fn(async () => Response.json({
      resolvedDiscSelections: [
        { discSelectionId: firstId, logicalJob: null },
        { discSelectionId: secondId, logicalJob },
      ],
    }));

    await expect(
      requestQueueLogicalJobResolutions(
        [firstId, secondId],
        profileId,
        fetcher,
      ),
    ).resolves.toEqual([
      { discSelectionId: firstId, logicalJob: null },
      { discSelectionId: secondId, logicalJob },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/encode-jobs?encodingProfileId=profile-v2&resolveDiscSelectionId=selection-1&resolveDiscSelectionId=selection-2",
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
  });

  it("recovers when the selected Encoding Profile becomes inactive", async () => {
    const profileId = "profile-retired" as EncodingProfileId;
    let unprofiledRequests = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("encodingProfileId=")) {
        return Response.json({ error: "Encoding Profile is inactive" }, {
          status: 404,
        });
      }
      unprofiledRequests += 1;
      return Response.json({
        historyGroup: "not_encoded",
        query: "",
        counts: { notEncoded: 0, reEncode: 0 },
        selections: [],
        profiles: unprofiledRequests === 1
          ? [{
              id: profileId,
              displayName: "Profile being retired",
              version: 1,
            }]
          : [],
        page: {
          offset: 0,
          limit: 100,
          total: 0,
          hasPrevious: false,
          hasNext: false,
        },
        profilePage: {
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        },
      });
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<EncodeJobsManager onChanged={() => undefined} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const profile = container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      );
      if (!profile) {
        throw new Error("Expected loaded Encoding Profile picker");
      }

      await act(async () => {
        profile.value = profileId;
        profile.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
        `/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0&encodingProfileId=${profileId}`,
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
      ]);
      expect(container.textContent).not.toContain(
        "Encoding options are unavailable",
      );
      expect(container.textContent).toContain(
        "No active DVD video Encoding Profiles are available.",
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("re-resolves preserved rows when the shared profile changes", async () => {
    const retiredProfileId = "profile-retired" as EncodingProfileId;
    const replacementProfileId = "profile-replacement" as EncodingProfileId;
    const selection: EncodeSelectionOption = {
      id: "selection-preserved" as DiscSelectionId,
      mediaItemId: "movie-preserved",
      mediaTitle: "Preserved worklist row",
      mediaYear: 2004,
      sourceDescription: "DVD main feature",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: null,
      suggestedOutputPath: "/media/movies/Preserved worklist row (2004).mkv",
    };
    let retired = false;
    const loaded = (profileId: EncodingProfileId) => ({
      historyGroup: "not_encoded",
      query: "",
      counts: { notEncoded: 1, reEncode: 0 },
      selections: [selection],
      profiles: [{
        id: profileId,
        displayName: profileId === retiredProfileId
          ? "Retiring profile"
          : "Replacement profile",
        version: 1,
      }],
      page: {
        offset: 0,
        limit: 100,
        total: 1,
        hasPrevious: false,
        hasNext: false,
      },
      profilePage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.searchParams.has("resolveDiscSelectionId")) {
        return Response.json({
          resolvedDiscSelections: [{
            discSelectionId: selection.id,
            logicalJob: {
              id: "replacement-job" as EncodeJobId,
              encodingProfileId: replacementProfileId,
              outputPath: "/media/movies/Replacement authoritative.mkv",
              status: "failed",
              queueAvailable: true,
            },
          }],
        });
      }
      if (
        retired &&
        url.searchParams.get("encodingProfileId") === retiredProfileId
      ) {
        return Response.json({ error: "Encoding Profile is inactive" }, {
          status: 404,
        });
      }
      return Response.json(
        loaded(retired ? replacementProfileId : retiredProfileId),
      );
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    try {
      await act(async () => {
        root.render(<EncodeJobsManager revision={0} onChanged={() => undefined} />);
        await settle();
      });
      const profile = container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      );
      if (!profile) {
        throw new Error("Expected Encoding Profile picker");
      }
      await act(async () => {
        profile.value = retiredProfileId;
        profile.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      });
      const checkbox = container.querySelector<HTMLInputElement>(
        `input[aria-label^="Select Preserved worklist row"]`,
      );
      if (!checkbox) {
        throw new Error("Expected first-encode checkbox");
      }
      await act(async () => {
        checkbox.click();
      });
      const add = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Add selected to worklist"),
      );
      if (!add) {
        throw new Error("Expected add-to-worklist action");
      }
      await act(async () => {
        add.click();
      });

      retired = true;
      await act(async () => {
        root.render(<EncodeJobsManager revision={1} onChanged={() => undefined} />);
        await settle();
      });
      await act(async () => {
        await settle();
      });
      const replacement = container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      );
      if (!replacement) {
        throw new Error("Expected replacement profile picker");
      }
      await act(async () => {
        replacement.value = replacementProfileId;
        replacement.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      });

      expect(replacement.value).toBe(replacementProfileId);
      expect(container.textContent).toContain("Preserved worklist row");
      expect(container.textContent).toContain("Retry");
      const outputPath = container.querySelector<HTMLInputElement>(
        'input[aria-label="Final output path for Preserved worklist row"]',
      );
      expect(outputPath?.value).toBe(
        "/media/movies/Replacement authoritative.mkv",
      );
      expect(outputPath?.readOnly).toBe(true);
      expect(fetcher.mock.calls.some(([input]) =>
        String(input).includes(
          `encodingProfileId=${replacementProfileId}&resolveDiscSelectionId=${selection.id}`,
        )
      )).toBe(true);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("announces a profiled options server failure without clearing the profile", async () => {
    const profileId = "profile-server-error" as EncodingProfileId;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("encodingProfileId=")) {
        return Response.json({ error: "Encode options failed" }, {
          status: 503,
        });
      }
      return Response.json({
        historyGroup: "not_encoded",
        query: "",
        counts: { notEncoded: 0, reEncode: 0 },
        selections: [],
        profiles: [{
          id: profileId,
          displayName: "Profile with server error",
          version: 1,
        }],
        page: {
          offset: 0,
          limit: 100,
          total: 0,
          hasPrevious: false,
          hasNext: false,
        },
        profilePage: {
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        },
      });
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<EncodeJobsManager onChanged={() => undefined} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const profile = container.querySelector<HTMLSelectElement>(
        'select[name="encodingProfileId"]',
      );
      if (!profile) {
        throw new Error("Expected loaded Encoding Profile picker");
      }

      await act(async () => {
        profile.value = profileId;
        profile.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain(
        "Encoding options are unavailable. Try again",
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps search controls available when a query has no searchable terms", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({
      historyGroup: "not_encoded",
      query: "",
      counts: { notEncoded: 0, reEncode: 0 },
      selections: [],
      profiles: [],
      page: {
        offset: 0,
        limit: 100,
        total: 0,
        hasPrevious: false,
        hasNext: false,
      },
      profilePage: {
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      },
    }));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<EncodeJobsManager onChanged={() => undefined} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const input = container.querySelector<HTMLInputElement>(
        'input[name="selectionQuery"]',
      );
      const form = input?.closest("form");
      if (!input || !form) {
        throw new Error("Expected Disc Selection search form");
      }

      await act(async () => {
        input.value = "---";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(container.querySelector('input[name="selectionQuery"]')).not
        .toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Enter letters or numbers to search.",
      );

      await act(async () => {
        input.value = "Queue Me";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0&query=Queue+Me",
      ]);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("preserves each history group's query and page in memory", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost:3000");
      const historyGroup = url.searchParams.get("historyGroup") === "re_encode"
        ? "re_encode"
        : "not_encoded";
      const query = url.searchParams.get("query") ?? "";
      const offset = Number(url.searchParams.get("selectionOffset") ?? 0);
      return Response.json({
        historyGroup,
        query,
        counts: { notEncoded: 250, reEncode: 250 },
        selections: [],
        profiles: [],
        page: {
          offset,
          limit: 100,
          total: 250,
          hasPrevious: offset > 0,
          hasNext: offset < 100,
        },
        profilePage: {
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        },
      });
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const clickButton = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.includes(label),
      );
      if (!button) {
        throw new Error(`Expected ${label} button`);
      }
      await act(async () => {
        button.click();
        await settle();
      });
    };
    const search = async (query: string) => {
      const input = container.querySelector<HTMLInputElement>(
        'input[name="selectionQuery"]',
      );
      const form = input?.closest("form");
      if (!input || !form) {
        throw new Error("Expected Disc Selection search form");
      }
      await act(async () => {
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await settle();
      });
    };

    try {
      await act(async () => {
        root.render(<EncodeJobsManager onChanged={() => undefined} />);
        await settle();
      });
      await clickButton("Next reviewed selections");
      await search("alpha");
      await clickButton("Next reviewed selections");
      await clickButton("Re-encode");
      await search("beta");
      await clickButton("Next reviewed selections");
      await clickButton("Not encoded");

      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=100&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0&query=alpha",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=100&profileOffset=0&query=alpha",
        "/api/encode-jobs?historyGroup=re_encode&selectionOffset=0&profileOffset=0",
        "/api/encode-jobs?historyGroup=re_encode&selectionOffset=0&profileOffset=0&query=beta",
        "/api/encode-jobs?historyGroup=re_encode&selectionOffset=100&profileOffset=0&query=beta",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=100&profileOffset=0&query=alpha",
      ]);
      expect(container.querySelector<HTMLInputElement>(
        'input[name="selectionQuery"]',
      )?.value).toBe("alpha");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("returns to the first page when refresh makes the current page invalid", async () => {
    let total = 250;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost:3000");
      const offset = Number(url.searchParams.get("selectionOffset") ?? 0);
      const selections = offset < total
        ? [{
          id: "selection-survivor" as DiscSelectionId,
          mediaItemId: "movie-survivor",
          mediaTitle: "Still available",
          mediaYear: 2006,
          sourceDescription: "DVD main feature",
          hasCompletedEncode: false,
          priorCompletedJob: null,
          logicalJob: null,
          suggestedOutputPath: "/media/movies/Still available (2006).mkv",
        }]
        : [];
      return Response.json({
        historyGroup: "not_encoded",
        query: "",
        counts: { notEncoded: total, reEncode: 0 },
        selections,
        profiles: [],
        page: {
          offset,
          limit: 100,
          total,
          hasPrevious: offset > 0,
          hasNext: offset + 100 < total,
        },
        profilePage: {
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        },
      });
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    const root = createRoot(container);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    try {
      await act(async () => {
        root.render(
          <EncodeJobsManager revision={0} onChanged={() => undefined} />,
        );
        await settle();
      });
      const next = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Next reviewed selections",
      );
      if (!next) {
        throw new Error("Expected next Disc Selection page button");
      }
      await act(async () => {
        next.click();
        await settle();
      });

      total = 50;
      await act(async () => {
        root.render(
          <EncodeJobsManager revision={1} onChanged={() => undefined} />,
        );
        await settle();
      });
      await act(async () => {
        await settle();
      });

      expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=100&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=100&profileOffset=0",
        "/api/encode-jobs?historyGroup=not_encoded&selectionOffset=0&profileOffset=0",
      ]);
      expect(container.textContent).toContain("Still available (2006)");
      expect(container.textContent).not.toContain(
        "No not-encoded Disc Selections are available.",
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
