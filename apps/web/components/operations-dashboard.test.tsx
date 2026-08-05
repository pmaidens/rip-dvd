import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  DashboardConnectionStatus,
  DashboardView,
  OperationsDashboard,
  requestArchiveApproval,
  type DashboardLoadState,
} from "./operations-dashboard";

const sectionNames = [
  "Optical Drives",
  "Detected Discs",
  "Archive Jobs",
  "Encode Jobs",
  "Catalog Review",
];

function render(state: DashboardLoadState): string {
  return renderToStaticMarkup(<DashboardView state={state} />);
}

function expectEverySection(html: string): void {
  for (const sectionName of sectionNames) {
    expect(html).toContain(sectionName);
  }
}

function stateForEverySection(
  section: { status: "loading" } | { status: "error" },
): DashboardLoadState {
  return {
    opticalDrives: section,
    detectedDiscs: section,
    archiveJobs: section,
    encodeJobs: section,
    catalogReview: section,
  };
}

describe("DashboardView", () => {
  it("shows an explicit loading state in every operations section", () => {
    const html = render(stateForEverySection({ status: "loading" }));

    expectEverySection(html);
    expect(html.match(/data-state="loading"/g)).toHaveLength(5);
    expect(html).toContain("Loading current state");
  });

  it("shows an explicit error state in every operations section", () => {
    const html = render(stateForEverySection({ status: "error" }));

    expectEverySection(html);
    expect(html.match(/data-state="error"/g)).toHaveLength(5);
    expect(html).toContain("Current state is unavailable");
  });

  it("shows a specific empty state in every operations section", () => {
    const html = render({
      generatedAt: "2026-07-22T08:00:00.000Z",
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: { status: "loaded", items: [] },
      encodeJobs: { status: "loaded", items: [] },
      catalogReview: { status: "loaded", items: [] },
    });

    expectEverySection(html);
    expect(html.match(/data-state="empty"/g)).toHaveLength(5);
    expect(html).toContain("No Optical Drives have been discovered.");
    expect(html).toContain("No Detected Discs are currently known.");
    expect(html).toContain("No Archive Jobs are recorded.");
    expect(html).toContain("No Encode Jobs are recorded.");
    expect(html).toContain("No Original Disc Archives need catalog review.");
  });

  it("renders populated operations without paths or worker diagnostics", () => {
    const html = render({
      generatedAt: "2026-07-22T08:00:00.000Z",
      opticalDrives: {
        status: "loaded",
        items: [
          {
            id: "drive-1",
            displayName: "Upper drive",
            hardwareName: "Pioneer BDR-XD08",
            state: "ready",
            lastSeenAt: "2026-07-22T07:59:00.000Z",
          },
        ],
      },
      detectedDiscs: {
        status: "loaded",
        items: [
          {
            id: "disc-1",
            volumeLabel: "MY_MOVIE",
            discKind: "dvd",
            status: "scanned",
            opticalDriveName: "Upper drive",
            fingerprint: "sha256:reviewable-disc",
            titles: [
              {
                number: 1,
                durationSeconds: 5_711,
                chapters: 12,
                audioStreams: [
                  {
                    id: 128,
                    languageCode: "en",
                    language: "English",
                    format: "ac3",
                    channels: 6,
                  },
                  {
                    id: 137,
                    languageCode: "fr",
                    language: "Francais",
                    format: "dts",
                    channels: 2,
                  },
                ],
                subtitles: [
                  {
                    id: 32,
                    languageCode: "en",
                    language: "English",
                    content: "Normal",
                  },
                ],
              },
            ],
            detectedAt: "2026-07-22T07:58:00.000Z",
          },
        ],
      },
      archiveJobs: {
        status: "loaded",
        items: [
          {
            id: "archive-job-1",
            detectedDiscId: "disc-1",
            discLabel: "MY_MOVIE",
            opticalDriveName: "Upper drive",
            status: "failed",
            progressPercent: 42,
          },
        ],
      },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-job-1",
            mediaTitle: "My Movie",
            mediaYear: 2001,
            encodingProfileName: "DVD library",
            status: "failed",
            progressPercent: 18,
          },
        ],
      },
      catalogReview: {
        status: "loaded",
        page: {
          offset: 20,
          limit: 20,
          hasPrevious: true,
          hasNext: true,
        },
        items: [
          {
            id: "archive-1",
            discLabel: "BONUS_DISC",
            discKind: "dvd",
            archiveFormat: "iso",
            archivedAt: "2026-07-22T07:00:00.000Z",
          },
        ],
      },
    });

    expectEverySection(html);
    expect(html.match(/data-state="populated"/g)).toHaveLength(5);
    expect(html).toContain("Upper drive");
    expect(html).toContain("MY_MOVIE");
    expect(html).toContain(">DVD<");
    expect(html).toContain("Title 1");
    expect(html).toContain("1h 35m 11s");
    expect(html).toContain("12 chapters · 2 audio · 1 subtitle");
    expect(html).toContain("English · ac3 · 6 channels · 0x80");
    expect(html).toContain("Francais · dts · 2 channels · 0x89");
    expect(html).toContain("English · Normal · 0x20");
    expect(html).toContain("sha256:reviewable-disc");
    expect(html).toContain("42%");
    expect(html).toContain("My Movie");
    expect(html).toContain("BONUS_DISC");
    expect(html).toContain("Review catalog");
    expect(html).toContain("Previous pending reviews");
    expect(html).toContain("Next pending reviews");
    expect(html).toContain("Worker reported a failure");
    expect(html).toContain("Approve archive");
    expect(html).toContain("Retry archive");
    expect(html).not.toContain("/dev/");
    expect(html).not.toContain("/media/");
    expect(html).not.toContain("HandBrake");
  });

  it("submits a same-origin JSON archive approval", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));

    await requestArchiveApproval("disc-1", fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/archive-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detectedDiscId: "disc-1" }),
    });
  });

  it("renders mixed section states independently", () => {
    const html = render({
      generatedAt: "2026-07-22T08:00:00.000Z",
      opticalDrives: {
        status: "loaded",
        items: [
          {
            id: "drive-1",
            displayName: "Upper drive",
            hardwareName: null,
            state: "ready",
            lastSeenAt: "2026-07-22T07:59:00.000Z",
          },
        ],
      },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: { status: "loading" },
      encodeJobs: { status: "error" },
      catalogReview: {
        status: "loaded",
        items: [
          {
            id: "archive-1",
            discLabel: "NEEDS_REVIEW",
            discKind: "dvd",
            archiveFormat: "iso",
            archivedAt: "2026-07-22T07:00:00.000Z",
          },
        ],
      },
    });

    expect(html.match(/data-state="populated"/g)).toHaveLength(2);
    expect(html.match(/data-state="empty"/g)).toHaveLength(1);
    expect(html.match(/data-state="loading"/g)).toHaveLength(1);
    expect(html.match(/data-state="error"/g)).toHaveLength(1);
    expect(html).toContain("Upper drive");
    expect(html).toContain("NEEDS_REVIEW");
  });

  it("shows every Encode Job state with terminal retry actions", () => {
    const onRequeueEncodeJob = vi.fn();
    const html = renderToStaticMarkup(
      <DashboardView
        state={{
          opticalDrives: { status: "loaded", items: [] },
          detectedDiscs: { status: "loaded", items: [] },
          archiveJobs: { status: "loaded", items: [] },
          encodeJobs: {
            status: "loaded",
            items: [
              {
                id: "queued-job",
                mediaTitle: "Queued title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "queued",
                progressPercent: 0,
              },
              {
                id: "running-job",
                mediaTitle: "Running title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "running",
                progressPercent: 42,
              },
              {
                id: "completed-job",
                mediaTitle: "Completed title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "completed",
                progressPercent: 100,
              },
              {
                id: "failed-job",
                mediaTitle: "Failed title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "failed",
                progressPercent: 19,
              },
            ],
          },
          catalogReview: { status: "loaded", items: [] },
        }}
        onRequeueEncodeJob={onRequeueEncodeJob}
        requeueingEncodeJobId="failed-job"
      />,
    );

    for (const title of [
      "Queued title",
      "Running title",
      "Completed title",
      "Failed title",
    ]) {
      expect(html).toContain(title);
    }
    expect(html).toContain("Re-encode");
    expect(html).toContain("Retrying…");
    expect(html).not.toContain("Retry encode");
  });

  it("includes reviewed Encode Job queueing in the operations control plane", () => {
    const html = renderToStaticMarkup(<OperationsDashboard />);

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Loading encoding options");
  });
});

describe("DashboardConnectionStatus", () => {
  it("announces a reconnecting live stream as an atomic polite status", () => {
    const html = renderToStaticMarkup(
      <DashboardConnectionStatus
        connectionStatus="loaded"
        streamStatus="reconnecting"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Live updates reconnecting");
  });
});
