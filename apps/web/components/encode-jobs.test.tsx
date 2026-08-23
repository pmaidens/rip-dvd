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
        state={{
          status: "loaded",
          selections: [{
            id: selectionId,
            mediaItemId: "movie-1",
            mediaTitle: "Queue Me",
            mediaYear: 2001,
            sourceDescription: "DVD main feature",
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
        onSelectionPage={() => undefined}
        onProfilePage={() => undefined}
      />,
    );

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Queue Me (2001) · DVD main feature");
    expect(html).toContain("DVD library · Version 2");
    expect(html).toContain('name="discSelectionId"');
    expect(html).toContain('name="encodingProfileId"');
    expect(html).toContain('name="outputPath"');
    expect(html).toContain("Queue encode");
    expect(html).toContain("Next active profiles");
  });

  it("fills the final output path when a reviewed selection is chosen", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <EncodeJobsView
          state={{
            status: "loaded",
            selections: [{
              id: "selection-1" as DiscSelectionId,
              mediaItemId: "movie-1",
              mediaTitle: "Queue Me",
              mediaYear: 2001,
              sourceDescription: "DVD main feature",
              suggestedOutputPath:
                "/media/movies/Queue Me (2001)/Queue Me (2001).mkv",
            }],
            profiles: [{
              id: "profile-v2" as EncodingProfileId,
              displayName: "DVD library",
              version: 2,
            }],
            page: {
              offset: 0,
              limit: 100,
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

    await requestEncodeJobOptions(100, 200, fetcher);
    await queueEncodeJob({
      discSelectionId: selectionId,
      encodingProfileId: profileId,
      outputPath: "/media/movies/Queue Me (2001).mkv",
    }, fetcher);
    await cancelEncodeJob(jobId, fetcher);
    await retryEncodeJob(jobId, fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/encode-jobs?selectionOffset=100&profileOffset=200",
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
});
