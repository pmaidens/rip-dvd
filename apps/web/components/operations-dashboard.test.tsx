import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DashboardView,
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
            detectedAt: "2026-07-22T07:58:00.000Z",
          },
        ],
      },
      archiveJobs: {
        status: "loaded",
        items: [
          {
            id: "archive-job-1",
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
    expect(html).toContain("42%");
    expect(html).toContain("My Movie");
    expect(html).toContain("BONUS_DISC");
    expect(html).toContain("Worker reported a failure");
    expect(html).not.toContain("/dev/");
    expect(html).not.toContain("/media/");
    expect(html).not.toContain("HandBrake");
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
});
