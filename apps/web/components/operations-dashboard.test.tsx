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

describe("DashboardView", () => {
  it("shows an explicit loading state in every operations section", () => {
    const html = render({ status: "loading" });

    expectEverySection(html);
    expect(html.match(/data-state="loading"/g)).toHaveLength(5);
    expect(html).toContain("Loading current state");
  });

  it("shows an explicit error state in every operations section", () => {
    const html = render({ status: "error" });

    expectEverySection(html);
    expect(html.match(/data-state="error"/g)).toHaveLength(5);
    expect(html).toContain("Current state is unavailable");
  });

  it("shows a specific empty state in every operations section", () => {
    const html = render({
      status: "loaded",
      data: {
        generatedAt: "2026-07-22T08:00:00.000Z",
        opticalDrives: [],
        detectedDiscs: [],
        archiveJobs: [],
        encodeJobs: [],
        catalogReview: [],
      },
    });

    expectEverySection(html);
    expect(html.match(/data-state="empty"/g)).toHaveLength(5);
    expect(html).toContain("No Optical Drives have been discovered.");
    expect(html).toContain("No Detected Discs are currently known.");
    expect(html).toContain("No Archive Jobs are recorded.");
    expect(html).toContain("No Encode Jobs are recorded.");
    expect(html).toContain("No Original Disc Archives need catalog review.");
  });

  it("renders populated database-backed operations in every section", () => {
    const html = render({
      status: "loaded",
      data: {
        generatedAt: "2026-07-22T08:00:00.000Z",
        opticalDrives: [
          {
            id: "drive-1",
            displayName: "Upper drive",
            devicePath: "/dev/sr0",
            hardwareName: "Pioneer BDR-XD08",
            state: "ready",
            lastSeenAt: "2026-07-22T07:59:00.000Z",
          },
        ],
        detectedDiscs: [
          {
            id: "disc-1",
            volumeLabel: "MY_MOVIE",
            discKind: "dvd",
            status: "scanned",
            opticalDriveName: "Upper drive",
            detectedAt: "2026-07-22T07:58:00.000Z",
          },
        ],
        archiveJobs: [
          {
            id: "archive-job-1",
            discLabel: "MY_MOVIE",
            opticalDriveName: "Upper drive",
            status: "running",
            progressPercent: 42,
            errorMessage: null,
          },
        ],
        encodeJobs: [
          {
            id: "encode-job-1",
            mediaTitle: "My Movie",
            mediaYear: 2001,
            encodingProfileName: "DVD library",
            status: "queued",
            progressPercent: 0,
            outputPath: "/media/movies/My Movie (2001).mkv",
            errorMessage: null,
          },
        ],
        catalogReview: [
          {
            id: "archive-1",
            discLabel: "BONUS_DISC",
            discKind: "dvd",
            archiveFormat: "iso",
            archivePath: "/media/originals/Bonus Disc.iso",
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
  });
});
