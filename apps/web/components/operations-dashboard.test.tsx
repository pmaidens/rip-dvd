// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { watchDashboardActivity } from "../lib/dashboard-activity";
import type { DashboardSnapshot } from "../lib/dashboard";

import type { EncodeJobId } from "@rip-dvd/data-access";

import {
  ActionOverview,
  DashboardConnectionStatus,
  DashboardView,
  OperationsDashboard,
  requestActionOverview,
  requestArchiveApproval,
  requestFilesystemVerification,
  type DashboardLoadState,
} from "./operations-dashboard";
import {
  expectVerificationResultList,
  VERIFICATION_RESULT_CASES,
  VERIFICATION_TIMESTAMP,
} from "./filesystem-verification-result.test-support";

vi.mock("../lib/dashboard-activity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/dashboard-activity")>();
  return { ...actual, watchDashboardActivity: vi.fn() };
});

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
  it("renders accessible indeterminate metadata and determinate hash inspection progress", () => {
    const inspection = {
      id: "inspection-1",
      status: "running" as const,
      phase: "reading_metadata" as const,
      attemptCount: 1,
      consecutiveFailureCount: 0,
      volumeLabel: null,
      titleCount: null,
      chapterCount: null,
      audioStreamCount: null,
      subtitleStreamCount: null,
      totalBytes: null,
      bytesHashed: null,
      bytesPerSecond: null,
      etaSeconds: null,
      retryAt: null,
      manualRetryRequested: false,
      reasonCode: null,
      archiveWorkFulfilled: false,
      phaseStartedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const state = {
      opticalDrives: {
        status: "loaded" as const,
        items: [{
          id: "drive-1",
          displayName: "Upper drive",
          hardwareName: "Pioneer",
          state: "ready" as const,
          lastSeenAt: new Date().toISOString(),
          currentInspection: inspection,
        }],
      },
      detectedDiscs: { status: "loaded" as const, items: [] },
      archiveJobs: { status: "loaded" as const, items: [] },
      encodeJobs: { status: "loaded" as const, items: [] },
      catalogReview: { status: "loaded" as const, items: [] },
    };

    const metadataHtml = renderToStaticMarkup(<DashboardView state={state} />);
    expect(metadataHtml).toContain('role="progressbar"');
    expect(metadataHtml).toContain('aria-label="Reading DVD metadata"');
    expect(metadataHtml).not.toContain("aria-valuenow");

    const hashHtml = renderToStaticMarkup(
      <DashboardView state={{
        ...state,
        opticalDrives: {
          ...state.opticalDrives,
          items: [{
            ...state.opticalDrives.items[0]!,
            currentInspection: {
              ...inspection,
              phase: "hashing_content" as const,
              totalBytes: 1_000,
              bytesHashed: 440,
            },
          }],
        },
      }} />,
    );
    expect(hashHtml).toContain('aria-label="Hashing DVD content"');
    expect(hashHtml).toContain('aria-valuenow="44"');
    expect(hashHtml).toContain("Calculating speed and time remaining");
  });

  it("uses the automatic failure streak for retry-wait copy", () => {
    const inspection = {
      id: "inspection-with-interruptions",
      status: "running" as const,
      phase: "retry_wait" as const,
      attemptCount: 8,
      consecutiveFailureCount: 2,
      volumeLabel: "INTERRUPTED_DISC",
      titleCount: 1,
      chapterCount: 8,
      audioStreamCount: 2,
      subtitleStreamCount: 1,
      totalBytes: 1_000,
      bytesHashed: 400,
      bytesPerSecond: null,
      etaSeconds: null,
      retryAt: new Date(Date.now() + 30_000).toISOString(),
      manualRetryRequested: false,
      reasonCode: "content_read_failed" as const,
      archiveWorkFulfilled: false,
      phaseStartedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const state = {
      opticalDrives: {
        status: "loaded" as const,
        items: [{
          id: "drive-1",
          displayName: "Upper drive",
          hardwareName: "Pioneer",
          state: "ready" as const,
          lastSeenAt: new Date().toISOString(),
          currentInspection: inspection,
        }],
      },
      detectedDiscs: { status: "loaded" as const, items: [] },
      archiveJobs: { status: "loaded" as const, items: [] },
      encodeJobs: { status: "loaded" as const, items: [] },
      catalogReview: { status: "loaded" as const, items: [] },
    };

    const automaticRetryHtml = renderToStaticMarkup(
      <DashboardView state={state} />,
    );
    expect(automaticRetryHtml).toContain("Attempt 3 of 5");
    expect(automaticRetryHtml).not.toContain("Attempt 9 of 5");
    expect(automaticRetryHtml).not.toContain("8 attempts");

    const manualRetryHtml = renderToStaticMarkup(
      <DashboardView state={{
        ...state,
        opticalDrives: {
          ...state.opticalDrives,
          items: [{
            ...state.opticalDrives.items[0]!,
            currentInspection: {
              ...inspection,
              consecutiveFailureCount: 0,
            },
          }],
        },
      }} />,
    );
    expect(manualRetryHtml).toContain("Manual retry queued");
    expect(manualRetryHtml).not.toContain("8 attempts");

    const awaitingEvidenceHtml = renderToStaticMarkup(
      <DashboardView state={{
        ...state,
        opticalDrives: {
          ...state.opticalDrives,
          items: [{
            ...state.opticalDrives.items[0]!,
            currentInspection: {
              ...inspection,
              status: "failed",
              phase: "hashing_content",
              manualRetryRequested: true,
              retryAt: null,
            },
          }],
        },
      }} />,
    );
    expect(awaitingEvidenceHtml).toContain(
      "waiting for the worker to verify this insertion",
    );
    expect(awaitingEvidenceHtml).not.toContain("Retry inspection");
  });

  it("keeps completed inspection progress and findings until archive work is fulfilled", () => {
    const completedInspection = {
      id: "inspection-1",
      status: "completed" as const,
      phase: "confirming_media" as const,
      attemptCount: 3,
      consecutiveFailureCount: 0,
      volumeLabel: "FEATURE_DISC",
      titleCount: 2,
      chapterCount: 18,
      audioStreamCount: 3,
      subtitleStreamCount: 1,
      totalBytes: 1_000,
      bytesHashed: 1_000,
      bytesPerSecond: null,
      etaSeconds: null,
      retryAt: null,
      manualRetryRequested: false,
      reasonCode: null,
      archiveWorkFulfilled: false,
      phaseStartedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const state = {
      opticalDrives: {
        status: "loaded" as const,
        items: [{
          id: "drive-1",
          displayName: "Upper drive",
          hardwareName: "Pioneer",
          state: "ready" as const,
          lastSeenAt: new Date().toISOString(),
          currentInspection: completedInspection,
        }],
      },
      detectedDiscs: { status: "loaded" as const, items: [] },
      archiveJobs: { status: "loaded" as const, items: [] },
      encodeJobs: { status: "loaded" as const, items: [] },
      catalogReview: { status: "loaded" as const, items: [] },
    };

    const awaitingArchiveHtml = renderToStaticMarkup(
      <DashboardView state={state} />,
    );
    expect(awaitingArchiveHtml).toContain("FEATURE_DISC · 2 titles");
    expect(awaitingArchiveHtml).toContain('aria-valuenow="100"');
    expect(awaitingArchiveHtml).toContain("100%");

    const fulfilledHtml = renderToStaticMarkup(
      <DashboardView state={{
        ...state,
        opticalDrives: {
          ...state.opticalDrives,
          items: [{
            ...state.opticalDrives.items[0]!,
            currentInspection: {
              ...completedInspection,
              archiveWorkFulfilled: true,
            },
          }],
        },
      }} />,
    );
    expect(fulfilledHtml).toContain("Inspection complete");
    expect(fulfilledHtml).not.toContain("FEATURE_DISC · 2 titles");
    expect(fulfilledHtml).not.toContain('aria-valuenow="100"');
  });

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

  it("offers queued cancellation and renders Cancelled separately from failure", () => {
    const html = render({
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: { status: "loaded", items: [] },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "queued-encode" as EncodeJobId,
            mediaTitle: "Queued Movie",
            mediaYear: null,
            encodingProfileName: "DVD library · Version 1",
            status: "queued",
            progressPhase: null,
            progressPercent: 0,
            progressEtaSeconds: null,
          },
          {
            id: "cancelled-encode" as EncodeJobId,
            mediaTitle: "Cancelled Movie",
            mediaYear: null,
            encodingProfileName: "DVD library · Version 1",
            status: "cancelled",
            progressPhase: null,
            progressPercent: 0,
            progressEtaSeconds: null,
            requeueable: true,
          },
          {
            id: "cancelled-ineligible-encode" as EncodeJobId,
            mediaTitle: "Cancelled Ineligible Movie",
            mediaYear: null,
            encodingProfileName: "DVD library · Version 1",
            status: "cancelled",
            progressPhase: null,
            progressPercent: 0,
            progressEtaSeconds: null,
            requeueable: false,
          },
        ],
      },
      catalogReview: { status: "loaded", items: [] },
    });

    expect(html).toContain("Cancel queued encode");
    expect(html).toContain("Requeue encode");
    expect(html).toContain("status status-cancelled");
    expect(html).toContain(">Cancelled<");
    expect(html).toContain(
      "Requeue requires an active Disc Selection with completed",
    );
    expect(html).not.toContain("Worker reported a failure");
  });

  it.each([
    ["discs", ["Optical Drives", "Detected Discs", "Archive Jobs"]],
    ["encoding", ["Encode Jobs"]],
    ["catalog", ["Catalog Review"]],
  ] as const)("renders only the %s detail-page sections", (section, expected) => {
    const html = renderToStaticMarkup(
      <DashboardView
        section={section}
        state={{
          opticalDrives: { status: "loaded", items: [] },
          detectedDiscs: { status: "loaded", items: [] },
          archiveJobs: { status: "loaded", items: [] },
          encodeJobs: { status: "loaded", items: [] },
          catalogReview: { status: "loaded", items: [] },
        }}
      />,
    );

    const expectedSections = new Set<string>(expected);
    for (const sectionName of sectionNames) {
      expect(html.includes(sectionName)).toBe(expectedSections.has(sectionName));
    }
  });

  it("renders Reviewed discovery controls and review summaries", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        section="catalog"
        catalogReviewView="reviewed"
        catalogReviewQuery="needle"
        catalogReviewOutcome="reviewed_with_selections"
        state={{
          opticalDrives: { status: "loaded", items: [] },
          detectedDiscs: { status: "loaded", items: [] },
          archiveJobs: { status: "loaded", items: [] },
          encodeJobs: { status: "loaded", items: [] },
          catalogReview: {
            status: "loaded",
            items: [{
              id: "reviewed-archive",
              discLabel: "REVIEWED_DISC",
              discKind: "dvd",
              archiveFormat: "iso",
              archivedAt: "2026-08-10T12:00:00.000Z",
              catalogReviewedAt: "2026-08-11T12:00:00.000Z",
              catalogReviewOutcome: "reviewed_with_selections",
              mappedMediaItemCount: 2,
              mappedMediaItemTitles: ["Needle Movie", "Needle Extra"],
            }],
            page: {
              limit: 20,
              previousCursor: null,
              nextCursor: null,
            },
          },
        }}
      />,
    );

    expect(html).toContain("Needs review");
    expect(html).toContain("Reviewed");
    expect(html).toContain('aria-label="Search reviewed archives"');
    expect(html).toContain("Reviewed with selections");
    expect(html).toContain("Reviewed Aug");
    expect(html).toContain("Needle Movie");
    expect(html).toContain("Needle Extra");
    expect(html).toContain("Open review");
    expect(html).not.toContain("Review catalog");
  });

  it("renders populated operations with path-free worker failure details", () => {
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
            archiveRequestId: "archive-request-1",
            attemptOrdinal: 1,
            discLabel: "MY_MOVIE",
            opticalDriveName: "Upper drive",
            status: "failed",
            progressPhase: "copying",
            progressPercent: 42,
            failureDetail: "DVD archive copy failed: Input/output error",
          },
        ],
      },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-job-1" as EncodeJobId,
            mediaTitle: "My Movie",
            mediaYear: 2001,
            encodingProfileName: "DVD library",
            status: "failed",
            progressPhase: null,
            progressPercent: 18,
            progressEtaSeconds: null,
            failureDetail: "HandBrake stopped after a source read error",
          },
        ],
      },
      catalogReview: {
        status: "loaded",
        page: {
          limit: 20,
          previousCursor: "previous-page",
          nextCursor: "next-page",
        },
        items: [
          {
            id: "archive-1",
            discLabel: "BONUS_DISC",
            discKind: "dvd",
            archiveFormat: "iso",
            archivedAt: "2026-07-22T07:00:00.000Z",
            catalogReviewedAt: null,
            catalogReviewOutcome: "needs_review",
            mappedMediaItemCount: 0,
            mappedMediaItemTitles: [],
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
    expect(html.match(/<details class="job-failure">/g)).toHaveLength(2);
    expect(html).toContain("DVD archive copy failed: Input/output error");
    expect(html).toContain("HandBrake stopped after a source read error");
    expect(html).toContain("Request archive");
    expect(html).not.toContain("/dev/");
    expect(html).not.toContain("/media/");
  });

  it("compacts already archived discs at the bottom in expandable rows", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const detectedDisc = (
      id: string,
      volumeLabel: string,
      status: "archived" | "scanned" | "rejected",
    ) => ({
      id,
      volumeLabel,
      discKind: "dvd" as const,
      status,
      opticalDriveName: "Upper drive",
      fingerprint: `sha256:${id}`,
      titles: [],
      detectedAt: "2026-07-22T07:58:00.000Z",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DashboardView
          section="discs"
          state={{
            opticalDrives: { status: "loaded", items: [] },
            detectedDiscs: {
              status: "loaded",
              items: [
                detectedDisc("archived-a", "ARCHIVED_A", "archived"),
                detectedDisc("scanned", "SCANNED", "scanned"),
                detectedDisc("archived-b", "ARCHIVED_B", "archived"),
                detectedDisc("rejected", "REJECTED", "rejected"),
              ],
            },
            archiveJobs: { status: "loaded", items: [] },
            encodeJobs: { status: "loaded", items: [] },
            catalogReview: { status: "loaded", items: [] },
          }}
        />,
      );
    });

    const rows = [...container.querySelectorAll(".item-list > article")];
    expect(
      rows.map(
        (row) => row.querySelector("h3, summary strong")?.textContent,
      ),
    ).toEqual(["SCANNED", "REJECTED", "ARCHIVED_A", "ARCHIVED_B"]);

    const disclosures = container.querySelectorAll<HTMLDetailsElement>(
      "details.archived-disc",
    );
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0].open).toBe(false);
    expect(disclosures[0].textContent).toContain("sha256:archived-a");

    await act(async () => {
      disclosures[0].querySelector("summary")?.click();
    });
    expect(disclosures[0].open).toBe(true);

    await act(async () => root.unmount());
  });

  it("expands a worker failure when its summary is clicked", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DashboardView
          section="discs"
          state={{
            opticalDrives: { status: "loaded", items: [] },
            detectedDiscs: { status: "loaded", items: [] },
            archiveJobs: {
              status: "loaded",
              items: [
                {
                  id: "failed-archive",
                  detectedDiscId: "failed-disc",
                  archiveRequestId: "failed-request",
                  attemptOrdinal: 1,
                  discLabel: "FAILED_DISC",
                  opticalDriveName: "Upper drive",
                  status: "failed",
                  progressPhase: "copying",
                  progressPercent: 28,
                  failureDetail: "DVD archive copy failed: Input/output error",
                },
              ],
            },
            encodeJobs: { status: "loaded", items: [] },
            catalogReview: { status: "loaded", items: [] },
          }}
        />,
      );
    });

    const disclosure = container.querySelector("details");
    const summary = container.querySelector("summary");
    expect(disclosure?.open).toBe(false);
    await act(async () => summary?.click());
    expect(disclosure?.open).toBe(true);
    await act(async () => root.unmount());
  });

  it("shows failed Archive Job history without job-level retry controls", () => {
    const html = render({
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: {
        status: "loaded",
        items: [
          {
            id: "retryable-archive-job",
            detectedDiscId: "retryable-disc",
            archiveRequestId: "retryable-request",
            attemptOrdinal: 1,
            discLabel: "RETRYABLE_DISC",
            opticalDriveName: "Upper drive",
            status: "failed",
            progressPhase: "copying",
            progressPercent: 20,
          },
          {
            id: "superseded-archive-job",
            detectedDiscId: "superseded-disc",
            archiveRequestId: "superseded-request",
            attemptOrdinal: 1,
            discLabel: "SUPERSEDED_DISC",
            opticalDriveName: "Lower drive",
            status: "failed",
            progressPhase: "copying",
            progressPercent: 30,
          },
        ],
      },
      encodeJobs: { status: "loaded", items: [] },
      catalogReview: { status: "loaded", items: [] },
    });

    expect(html).toContain("RETRYABLE_DISC");
    expect(html).toContain("SUPERSEDED_DISC");
    expect(html.match(/Retry archive/g)).toBeNull();
  });

  it("explains Archive Job work before and between percentage updates", () => {
    const phases = [
      ["preparing", "running", "Preparing the disc for archiving"],
      ["copying", "running", "Copying the disc image"],
      ["verifying", "running", "Verifying the disc image"],
      ["finalizing", "running", "Saving the archive"],
    ] as const;
    const html = render({
      opticalDrives: { status: "loaded", items: [] },
      detectedDiscs: { status: "loaded", items: [] },
      archiveJobs: {
        status: "loaded",
        items: phases.map(([progressPhase, status], index) => ({
          id: `archive-job-${index}`,
          detectedDiscId: `disc-${index}`,
          archiveRequestId: `request-${index}`,
          attemptOrdinal: 1,
          discLabel: `DISC_${index}`,
          opticalDriveName: "Upper drive",
          status,
          progressPhase,
          progressPercent: 99,
        })),
      },
      encodeJobs: { status: "loaded", items: [] },
      catalogReview: { status: "loaded", items: [] },
    });

    for (const [, , detail] of phases) {
      expect(html).toContain(detail);
    }
  });

  it("submits a same-origin JSON Archive Request", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));

    await requestArchiveApproval("disc-1", fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/archive-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detectedDiscId: "disc-1" }),
    });
  });

  it("requests the exact action overview without caching", async () => {
    const snapshot = {
      generatedAt: "2026-08-10T20:00:00.000Z",
      discApprovals: { count: 0, items: [] },
      failedArchives: { count: 0, items: [] },
      failedEncodes: { count: 0, items: [] },
      catalogReviews: { count: 0, items: [] },
      filesystemProblems: { count: 0, items: [] },
    };
    const fetcher = vi.fn(async () => Response.json(snapshot));

    await expect(requestActionOverview(fetcher)).resolves.toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledWith("/api/action-overview", {
      cache: "no-store",
    });
  });

  it.each([
    ["original_disc_archive", "archive-1"],
    ["encode_job_output", "encode-job-1"],
  ] as const)("submits an explicit %s verification", async (target, id) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await requestFilesystemVerification(target, id, fetcher);

    expect(fetcher).toHaveBeenCalledWith("/api/filesystem-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, id }),
    });
  });

  it("renders explicit verification actions and database-backed results", () => {
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
                id: "encode-job-1" as EncodeJobId,
                mediaTitle: "Missing output",
                mediaYear: 2001,
                encodingProfileName: "DVD library · Version 1",
                status: "completed",
                progressPhase: "encoding",
                progressPercent: 100,
                progressEtaSeconds: null,
                verificationStatus: "missing",
                verificationMessage: "File is missing at the recorded path.",
                verifiedAt: "2026-08-06T20:00:00.000Z",
              },
            ],
          },
          catalogReview: {
            status: "loaded",
            items: [
              {
                id: "archive-1",
                discLabel: "UNREADABLE_DISC",
                discKind: "dvd",
                archiveFormat: "iso",
                archivedAt: "2026-08-06T19:00:00.000Z",
                catalogReviewedAt: null,
                catalogReviewOutcome: "needs_review",
                mappedMediaItemCount: 0,
                mappedMediaItemTitles: [],
                verificationStatus: "inaccessible",
                verificationMessage:
                  "The web process cannot access the recorded path.",
                verifiedAt: "2026-08-06T20:05:00.000Z",
              },
            ],
          },
        }}
        verifyingFilesystemTarget="encode_job_output:encode-job-1"
      />,
    );

    expect(html).toContain("Verify archive file");
    expect(html).toContain("Verifying output…");
    expect(html).toContain("File is missing at the recorded path.");
    expect(html).toContain(
      "The web process cannot access the recorded path.",
    );
    expect(html).not.toContain("/media/");
  });

  it("shows null and verified filesystem states consistently", () => {
    const html = renderToStaticMarkup(
      <DashboardView
        state={{
          opticalDrives: { status: "loaded", items: [] },
          detectedDiscs: { status: "loaded", items: [] },
          archiveJobs: { status: "loaded", items: [] },
          encodeJobs: {
            status: "loaded",
            items: [
              ...VERIFICATION_RESULT_CASES.map(
                (
                  {
                    status: verificationStatus,
                    message: verificationMessage,
                  },
                  index,
                ) => ({
                  id: `verified-job-${index}` as EncodeJobId,
                  mediaTitle: `Verified job ${index}`,
                  mediaYear: null,
                  encodingProfileName: "DVD library · Version 1",
                  status: "completed" as const,
                  progressPhase: "encoding" as const,
                  progressPercent: 100,
                  progressEtaSeconds: null,
                  verificationStatus,
                  verificationMessage,
                  verifiedAt: VERIFICATION_TIMESTAMP,
                }),
              ),
              {
                id: "unverified-job" as EncodeJobId,
                mediaTitle: "Unverified job",
                mediaYear: null,
                encodingProfileName: "DVD library · Version 1",
                status: "completed",
                progressPhase: "encoding",
                progressPercent: 100,
                progressEtaSeconds: null,
                verificationStatus: null,
                verificationMessage: null,
                verifiedAt: null,
              },
            ],
          },
          catalogReview: { status: "loaded", items: [] },
        }}
      />,
    );

    expectVerificationResultList(html);
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
            catalogReviewedAt: null,
            catalogReviewOutcome: "needs_review",
            mappedMediaItemCount: 0,
            mappedMediaItemTitles: [],
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
                id: "queued-job" as EncodeJobId,
                mediaTitle: "Queued title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "queued",
                progressPhase: null,
                progressPercent: 0,
                progressEtaSeconds: null,
              },
              {
                id: "running-job" as EncodeJobId,
                mediaTitle: "Running title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "running",
                progressPhase: "encoding",
                progressPercent: 42,
                progressEtaSeconds: 723,
              },
              {
                id: "completed-job" as EncodeJobId,
                mediaTitle: "Completed title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "completed",
                progressPhase: "encoding",
                progressPercent: 100,
                progressEtaSeconds: null,
              },
              {
                id: "failed-job" as EncodeJobId,
                mediaTitle: "Failed title",
                mediaYear: null,
                encodingProfileName: "DVD library v1",
                status: "failed",
                progressPhase: "encoding",
                progressPercent: 19,
                progressEtaSeconds: null,
              },
            ],
          },
          catalogReview: { status: "loaded", items: [] },
        }}
        onRequeueEncodeJob={onRequeueEncodeJob}
        requeueingEncodeJobId={"failed-job" as EncodeJobId}
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
    expect(html).toContain("Encoding · ETA 12m 3s");
    expect(html).toContain("Retrying…");
    expect(html).not.toContain("Retry encode");
  });

  it("includes reviewed Encode Job queueing in the operations control plane", () => {
    const html = renderToStaticMarkup(<OperationsDashboard page="encoding" />);

    expect(html).toContain("Queue Encode Jobs");
    expect(html).toContain("Loading encoding options");
  });

  it("includes durable verification inventory beyond transient operation sections", () => {
    const html = renderToStaticMarkup(
      <OperationsDashboard page="verification" />,
    );

    expect(html).toContain("Filesystem Verification");
    expect(html).toContain("Encode Job outputs");
    expect(html).toContain("Original Disc Archives");
  });

  it("keeps the default front page focused on the actionable overview", () => {
    const html = renderToStaticMarkup(<OperationsDashboard />);

    expect(html).toContain("What needs action");
    expect(html).not.toContain("Queue Encode Jobs");
    expect(html).not.toContain("Filesystem Verification");
    expect(html).not.toContain("Optical Drives");
  });
});

describe("ActionOverview", () => {
  it("summarizes every operator-intervention category and links to its workflow", () => {
    const html = renderToStaticMarkup(
      <ActionOverview
        state={{
          status: "loaded",
          snapshot: {
            generatedAt: "2026-08-10T20:00:00.000Z",
            discApprovals: {
              count: 1,
              items: [{ id: "disc-action", label: "NEEDS_APPROVAL" }],
            },
            failedArchives: {
              count: 1,
              items: [{ id: "archive-failed", label: "ARCHIVE_FAILED" }],
            },
            failedEncodes: {
              count: 4,
              items: [
                { id: "encode-failed-1", label: "Encode Failed (2001)" },
                { id: "encode-failed-2", label: "Encode Failed 2" },
                { id: "encode-failed-3", label: "Encode Failed 3" },
              ],
            },
            catalogReviews: {
              count: 1,
              items: [{ id: "review-1", label: "CATALOG_REVIEW" }],
            },
            filesystemProblems: {
              count: 1,
              items: [
                {
                  id: "encode_job_output:encode-failed-1",
                  label: "Encode Failed (2001)",
                },
              ],
            },
          },
        }}
      />,
    );

    expect(html).toContain("Discs awaiting approval");
    expect(html).toContain("Archive requests");
    expect(html).toContain("Failed encodes");
    expect(html).toContain("Catalog reviews");
    expect(html).toContain("Filesystem problems");
    expect(html).toContain("NEEDS_APPROVAL");
    expect(html).toContain("ARCHIVE_FAILED");
    expect(html).toContain("Encode Failed (2001)");
    expect(html).toContain("CATALOG_REVIEW");
    expect(html).toContain("+1 more");
    expect(html).toContain('href="/discs"');
    expect(html).toContain('href="/catalog"');
    expect(html).toContain('href="/encoding"');
    expect(html).toContain('href="/verification"');
  });

  it("distinguishes loading, unavailable, and clear attention categories", () => {
    const loading = renderToStaticMarkup(
      <ActionOverview state={{ status: "loading" }} />,
    );
    const unavailable = renderToStaticMarkup(
      <ActionOverview state={{ status: "error" }} />,
    );
    const clear = renderToStaticMarkup(
      <ActionOverview
        state={{
          status: "loaded",
          snapshot: {
            generatedAt: "2026-08-10T20:00:00.000Z",
            discApprovals: { count: 0, items: [] },
            failedArchives: { count: 0, items: [] },
            failedEncodes: { count: 0, items: [] },
            catalogReviews: { count: 0, items: [] },
            filesystemProblems: { count: 0, items: [] },
          },
        }}
      />,
    );

    expect(loading.match(/Checking current state/g)).toHaveLength(5);
    expect(unavailable.match(/Current state unavailable/g)).toHaveLength(5);
    expect(clear.match(/No action needed/g)).toHaveLength(5);
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function mutationDashboardState(
  encodeJobStatus: "failed" | "queued" = "failed",
): DashboardSnapshot {
  return {
    generatedAt: "2026-08-10T20:00:00.000Z",
    opticalDrives: { status: "loaded", items: [] },
    detectedDiscs: {
      status: "loaded",
      items: [
        {
          id: "disc-1",
          volumeLabel: "READY_TO_ARCHIVE",
          discKind: "dvd",
          status: "scanned",
          opticalDriveName: "Upper drive",
          fingerprint: "sha256:ready-to-archive",
          titles: [],
          detectedAt: "2026-08-10T19:00:00.000Z",
        },
      ],
    },
    archiveJobs: { status: "loaded", items: [] },
    encodeJobs: {
      status: "loaded",
      items: [
        {
          id: "encode-job-1" as EncodeJobId,
          mediaTitle: encodeJobStatus === "failed"
            ? "Failed Encode"
            : "Queued Encode",
          mediaYear: 2001,
          encodingProfileName: "DVD library · Version 1",
          status: encodeJobStatus,
          progressPhase: encodeJobStatus === "failed" ? "encoding" : null,
          progressPercent: encodeJobStatus === "failed" ? 42 : 0,
          progressEtaSeconds: null,
        },
      ],
    },
    catalogReview: { status: "loaded", items: [] },
  };
}

function findButton(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`Could not find button: ${label}`);
  }
  return button;
}

const dashboardMutationCases = [
  {
    action: "Archive Request creation",
    page: "discs",
    readyLabel: "Request archive",
    busyLabel: "Requesting…",
    requestPath: "/api/archive-requests",
    requestMethod: "POST",
    errorMessage: "Archive Request creation failed. Try again.",
  },
  {
    action: "Encode Job requeue",
    page: "encoding",
    readyLabel: "Retry encode",
    busyLabel: "Retrying…",
    requestPath: "/api/encode-jobs",
    requestMethod: "PATCH",
    errorMessage:
      "Encode Job retry failed. Confirm its catalog review, then try again.",
  },
  {
    action: "Encode Job cancellation",
    page: "encoding",
    readyLabel: "Cancel queued encode",
    busyLabel: "Cancelling…",
    requestPath: "/api/encode-jobs",
    requestMethod: "PATCH",
    errorMessage:
      "Encode Job cancellation failed. Refresh the queue and try again.",
    encodeJobStatus: "queued",
  },
] as const;

async function renderMutationDashboard(
  mutationCase: (typeof dashboardMutationCases)[number],
  mutationResponse: Deferred<Response>,
): Promise<{
  container: HTMLDivElement;
  root: Root;
  mutationRequests: () => number;
}> {
  const watch = vi.mocked(watchDashboardActivity);
  watch.mockImplementation(({ onSnapshot, onStreamStatus }) => {
    onSnapshot(mutationDashboardState(
      "encodeJobStatus" in mutationCase
        ? mutationCase.encodeJobStatus
        : "failed",
    ));
    onStreamStatus?.("live");
    return () => undefined;
  });
  const fetcher = vi.fn(
    async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = String(input);
      if (
        path === mutationCase.requestPath &&
        init?.method === mutationCase.requestMethod
      ) {
        return mutationResponse.promise;
      }
      if (path === "/api/encoding-profiles") {
        return Response.json({ profiles: [] });
      }
      if (path.startsWith("/api/encode-jobs?")) {
        return Response.json({
          selections: [],
          profiles: [],
          page: {
            offset: 0,
            limit: 20,
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
      throw new Error(`Unexpected dashboard request: ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationsDashboard page={mutationCase.page} />);
  });
  return {
    container,
    root,
    mutationRequests: () =>
      fetcher.mock.calls.filter(
        ([input, init]) =>
          String(input) === mutationCase.requestPath &&
          init?.method === mutationCase.requestMethod,
      ).length,
  };
}

afterEach(() => {
  vi.mocked(watchDashboardActivity).mockReset();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps the selected Reviewed filters across live dashboard snapshots", async () => {
  const snapshot: DashboardSnapshot = {
    generatedAt: "2026-08-12T17:00:00.000Z",
    opticalDrives: { status: "loaded", items: [] },
    detectedDiscs: { status: "loaded", items: [] },
    archiveJobs: { status: "loaded", items: [] },
    encodeJobs: { status: "loaded", items: [] },
    catalogReview: { status: "loaded", items: [] },
  };
  const watch = vi.mocked(watchDashboardActivity);
  watch.mockImplementation(({ onSnapshot }) => {
    onSnapshot(snapshot);
    return () => undefined;
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<OperationsDashboard page="catalog" />));
  const reviewed = findButton(container, "Reviewed");
  await act(async () => reviewed.click());
  const query = container.querySelector<HTMLInputElement>(
    'input[name="query"]',
  );
  const outcome = container.querySelector<HTMLSelectElement>(
    'select[name="outcome"]',
  );
  if (!query || !outcome) {
    throw new Error("Expected Reviewed search controls");
  }
  query.value = "needle title";
  outcome.value = "archive_only";
  await act(async () => findButton(container, "Search reviewed archives").click());

  expect(watch).toHaveBeenLastCalledWith(expect.objectContaining({
    catalogReviewCursor: null,
    catalogReviewView: "reviewed",
    catalogReviewQuery: "needle title",
    catalogReviewOutcome: "archive_only",
  }));
  const latestOptions = watch.mock.calls.at(-1)![0];
  await act(async () => latestOptions.onSnapshot({
    ...snapshot,
    generatedAt: "2026-08-12T17:00:01.000Z",
  }));
  expect(findButton(container, "Reviewed").getAttribute("aria-pressed"))
    .toBe("true");
  expect(container.textContent).toContain(
    "No reviewed Original Disc Archives match these filters.",
  );
  await act(async () => root.unmount());
});

describe.each(dashboardMutationCases)("$action dashboard mutation", (mutationCase) => {
  it("suppresses duplicate clicks, refreshes after success, and clears busy state", async () => {
    const mutationResponse = deferred<Response>();
    const { container, root, mutationRequests } = await renderMutationDashboard(
      mutationCase,
      mutationResponse,
    );

    const button = findButton(container, mutationCase.readyLabel);
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    expect(mutationRequests()).toBe(1);
    expect(findButton(container, mutationCase.busyLabel).disabled).toBe(true);
    expect(watchDashboardActivity).toHaveBeenCalledOnce();

    await act(async () => {
      mutationResponse.resolve(new Response(null, { status: 200 }));
      await mutationResponse.promise;
    });

    expect(watchDashboardActivity).toHaveBeenCalledTimes(2);
    expect(findButton(container, mutationCase.readyLabel).disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("shows its action-specific failure and clears busy state without refreshing", async () => {
    const mutationResponse = deferred<Response>();
    const { container, root } = await renderMutationDashboard(
      mutationCase,
      mutationResponse,
    );

    await act(async () => {
      findButton(container, mutationCase.readyLabel).click();
      await Promise.resolve();
    });
    expect(findButton(container, mutationCase.busyLabel).disabled).toBe(true);

    await act(async () => {
      mutationResponse.reject(new Error("request failed"));
      try {
        await mutationResponse.promise;
      } catch {
        // The component converts the request rejection into visible error state.
      }
    });

    expect(watchDashboardActivity).toHaveBeenCalledOnce();
    expect(findButton(container, mutationCase.readyLabel).disabled).toBe(false);
    expect(
      [...container.querySelectorAll('[role="status"]')].some(
        (instance) => instance.textContent === mutationCase.errorMessage,
      ),
    ).toBe(true);
    await act(async () => root.unmount());
  });
});
