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

  it("lets a user select a reviewed Disc Selection and active profile version", () => {
    const selectionId = "selection-1" as DiscSelectionId;
    const profileId = "profile-v2" as EncodingProfileId;
    const html = renderToStaticMarkup(
      <EncodeJobsView
        selectedProfileId={profileId}
        state={{
          status: "loaded",
          historyGroup: "not_encoded",
          query: "",
          counts: { notEncoded: 1, reEncode: 0 },
          selections: [{
            id: selectionId,
            mediaItemId: "movie-1",
            mediaTitle: "Queue Me",
            mediaYear: 2001,
            sourceDescription: "DVD main feature",
            hasCompletedEncode: false,
            priorCompletedJob: null,
            logicalJob: null,
            suggestedOutputPath:
              "/media/movies/Queue Me (2001)/Queue Me (2001).mkv",
          }],
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
        onQueue={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Queue Me (2001) · DVD main feature · Not encoded");
    expect(html).toContain("DVD library · Version 2");
    expect(html).toContain('name="discSelectionId"');
    expect(html).toContain('name="encodingProfileId"');
    expect(html).toContain('name="outputPath"');
    expect(html).toContain("Queue new Encode Job");
    expect(html).toContain("Next active profiles");
  });

  it("fills an editable final output path for each reviewed selection", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <EncodeJobsView
          selectedProfileId={"profile-v2" as EncodingProfileId}
          state={{
            status: "loaded",
            historyGroup: "not_encoded",
            query: "",
            counts: { notEncoded: 2, reEncode: 0 },
            selections: [{
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
            }, {
              id: "selection-2" as DiscSelectionId,
              mediaItemId: "movie-2",
              mediaTitle: "Queue Next",
              mediaYear: 2002,
              sourceDescription: "DVD title 2",
              hasCompletedEncode: false,
              priorCompletedJob: null,
              logicalJob: null,
              suggestedOutputPath:
                "/media/movies/Queue Next (2002)/Queue Next (2002).mkv",
            }],
            profiles: [{
              id: "profile-v2" as EncodingProfileId,
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
          onQueue={() => undefined}
          onRetry={() => undefined}
          onHistoryGroup={() => undefined}
          onSearch={() => undefined}
          onProfileChange={() => undefined}
          onSelectionPage={() => undefined}
          onProfilePage={() => undefined}
        />,
      );
    });

    const selection = container.querySelector<HTMLSelectElement>(
      'select[name="discSelectionId"]',
    );
    const outputPath = container.querySelector<HTMLInputElement>(
      'input[name="outputPath"]',
    );
    if (!selection || !outputPath) {
      throw new Error("Expected Encode Job form fields");
    }

    await act(async () => {
      selection.value = "selection-1";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(outputPath.value).toBe(
      "/media/movies/Queue Me (2001)/Queue Me (2001).mkv",
    );

    await act(async () => {
      outputPath.value = "/media/movies/Operator choice.mkv";
      outputPath.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(outputPath.value).toBe("/media/movies/Operator choice.mkv");

    await act(async () => {
      selection.value = "selection-2";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(outputPath.value).toBe(
      "/media/movies/Queue Next (2002)/Queue Next (2002).mkv",
    );
    await act(async () => root.unmount());
  });

  it("preserves a custom queue choice only while its group and revision stay current", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const selection = {
      id: "selection-pinned" as DiscSelectionId,
      mediaItemId: "movie-pinned",
      mediaTitle: "Pinned choice",
      mediaYear: 2005,
      sourceDescription: "DVD title 2",
      hasCompletedEncode: false,
      priorCompletedJob: null,
      logicalJob: null,
      suggestedOutputPath: "/media/movies/Pinned choice (2005).mkv",
    };
    const render = (
      query: string | null,
      selections: EncodeSelectionOption[],
      historyGroup: "not_encoded" | "re_encode" = "not_encoded",
      successfulQueueRevision = 0,
    ) => (
      <EncodeJobsView
        selectedProfileId={"profile-pinned" as EncodingProfileId}
        successfulQueueRevision={successfulQueueRevision}
        state={query === null
          ? { status: "loading" }
          : {
            status: "loaded",
            historyGroup,
            query,
            counts: { notEncoded: 2, reEncode: 0 },
            selections,
            profiles: [{
              id: "profile-pinned" as EncodingProfileId,
              displayName: "Pinned profile",
              version: 1,
            }],
            page: {
              offset: 0,
              limit: 100,
              total: selections.length,
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
        onQueue={() => undefined}
        onRetry={() => undefined}
        onHistoryGroup={() => undefined}
        onSearch={() => undefined}
        onProfileChange={() => undefined}
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />
    );

    try {
      await act(async () => root.render(render("", [selection])));
      const picker = container.querySelector<HTMLSelectElement>(
        'select[name="discSelectionId"]',
      );
      if (!picker) {
        throw new Error("Expected Disc Selection picker");
      }
      await act(async () => {
        picker.value = selection.id;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const outputPath = container.querySelector<HTMLInputElement>(
        'input[name="outputPath"]',
      );
      if (!outputPath) {
        throw new Error("Expected output path");
      }
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
      expect(outputPath.value).toBe("/media/movies/Operator choice.mkv");
      await act(async () => root.render(render(null, [])));
      await act(async () => root.render(render("another title", [])));
      const visiblePicker = container.querySelector<HTMLSelectElement>(
        'select[name="discSelectionId"]',
      );
      const visibleOutputPath = container.querySelector<HTMLInputElement>(
        'input[name="outputPath"]',
      );
      if (!visiblePicker || !visibleOutputPath) {
        throw new Error("Expected restored Encode Job form");
      }

      expect(container.textContent).toContain(
        "Pinned choice (2005) · DVD title 2",
      );
      expect(container.textContent).toContain(
        'No Disc Selections match "another title" in Not encoded.',
      );
      expect(visiblePicker.value).toBe(selection.id);
      expect(visibleOutputPath.value).toBe(
        "/media/movies/Operator choice.mkv",
      );

      await act(async () => root.render(render("", [], "re_encode")));
      expect(container.textContent).not.toContain("Pinned choice (2005)");
      expect(visiblePicker.value).toBe("");
      expect(
        container.querySelector<HTMLInputElement>('input[name="outputPath"]')
          ?.value,
      ).toBe("");

      await act(async () =>
        root.render(render("", [selection], "not_encoded"))
      );
      const returnedPicker = container.querySelector<HTMLSelectElement>(
        'select[name="discSelectionId"]',
      );
      if (!returnedPicker) {
        throw new Error("Expected returned Disc Selection picker");
      }
      await act(async () => {
        returnedPicker.value = selection.id;
        returnedPicker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () =>
        root.render(render("another title", [], "not_encoded", 1))
      );
      expect(container.textContent).not.toContain("Pinned choice (2005)");
      expect(returnedPicker.value).toBe("");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("cannot submit a profile that is absent from the visible page", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onQueue = vi.fn();

    await act(async () => {
      root.render(
        <EncodeJobsView
          selectedProfileId={"profile-page-1" as EncodingProfileId}
          state={{
            status: "loaded",
            historyGroup: "not_encoded",
            query: "",
            counts: { notEncoded: 1, reEncode: 0 },
            selections: [{
              id: "selection-page-2" as DiscSelectionId,
              mediaItemId: "movie-page-2",
              mediaTitle: "Paged profile movie",
              mediaYear: 2004,
              sourceDescription: "DVD main feature",
              hasCompletedEncode: false,
              priorCompletedJob: null,
              logicalJob: null,
              suggestedOutputPath:
                "/media/movies/Paged profile movie (2004).mkv",
            }],
            profiles: [{
              id: "profile-page-2" as EncodingProfileId,
              displayName: "Profile page two",
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
              offset: 100,
              limit: 100,
              hasPrevious: true,
              hasNext: false,
            },
          }}
          isSaving={false}
          requestError={null}
          onQueue={onQueue}
          onRetry={() => undefined}
          onHistoryGroup={() => undefined}
          onSearch={() => undefined}
          onProfileChange={() => undefined}
          onSelectionPage={() => undefined}
          onProfilePage={() => undefined}
        />,
      );
    });

    const profile = container.querySelector<HTMLSelectElement>(
      'select[name="encodingProfileId"]',
    );
    const selection = container.querySelector<HTMLSelectElement>(
      'select[name="discSelectionId"]',
    );
    const form = selection?.closest("form");
    const submit = form?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!profile || !selection || !form || !submit) {
      throw new Error("Expected paged Encode Job form");
    }

    await act(async () => {
      selection.value = "selection-page-2";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(profile.value).toBe("");
    expect(submit.disabled).toBe(true);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onQueue).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("loads options and submits a same-origin JSON queue request", async () => {
    const selectionId = "selection-1" as DiscSelectionId;
    const profileId = "profile-v2" as EncodingProfileId;
    const jobId = "job-1" as EncodeJobId;
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("selectionOffset")
        ? Response.json({ selections: [], profiles: [], page: {} })
        : Response.json({ job: { id: "job-1" } }));

    await requestEncodeJobOptions({
      selectionOffset: 100,
      profileOffset: 200,
      historyGroup: "re_encode",
      query: "queue me",
      encodingProfileId: profileId,
    }, fetcher);
    await queueEncodeJob({
      discSelectionId: selectionId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Queue Me (2001).mkv",
    }, fetcher);
    await cancelEncodeJob(jobId, fetcher);
    await retryEncodeJob(jobId, fetcher);

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
