import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  EncodeJobsView,
  queueEncodeJob,
  requestEncodeJobOptions,
  retryEncodeJob,
} from "./encode-jobs";

describe("EncodeJobsView", () => {
  it("lets a user select a reviewed Disc Selection and active profile version", () => {
    const html = renderToStaticMarkup(
      <EncodeJobsView
        state={{
          status: "loaded",
          selections: [{
            id: "selection-1",
            mediaItemId: "movie-1",
            mediaTitle: "Queue Me",
            mediaYear: 2001,
            sourceDescription: "DVD main feature",
          }],
          profiles: [{
            id: "profile-v2",
            displayName: "DVD library",
            version: 2,
          }],
          page: {
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
      />,
    );

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Queue Me (2001) · DVD main feature");
    expect(html).toContain("DVD library · Version 2");
    expect(html).toContain('name="discSelectionId"');
    expect(html).toContain('name="encodingProfileId"');
    expect(html).toContain('name="outputPath"');
    expect(html).toContain("Queue encode");
  });

  it("loads options and submits a same-origin JSON queue request", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("selectionOffset")
        ? Response.json({ selections: [], profiles: [], page: {} })
        : Response.json({ job: { id: "job-1" } }));

    await requestEncodeJobOptions(100, fetcher);
    await queueEncodeJob({
      discSelectionId: "selection-1",
      encodingProfileId: "profile-v2",
      outputPath: "/media/movies/Queue Me (2001).mkv",
    }, fetcher);
    await retryEncodeJob("job-1", fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/encode-jobs?selectionOffset=100",
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
      body: JSON.stringify({ encodeJobId: "job-1" }),
    });
  });
});
