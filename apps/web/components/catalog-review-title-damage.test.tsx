// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { CatalogReviewTitleDamageEvidence } from "./catalog-review-title-damage";
import type { CatalogReviewTitleDamage } from "./catalog-review-model";

const titleDamage = {
  state: "current",
  checkpointRevision: 4,
  assessmentIdentity: "synthetic-assessment",
  currentAssessmentIdentity: "synthetic-assessment",
  items: [
    {
      titleIdentityId: "synthetic-title-1",
      titleIdentityObservationId: "synthetic-observation-1",
      displayTitleNumber: 1,
      selection: {
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
      mappingCoverage: {
        state: "complete",
        policyVersion: "synthetic-map-v1",
        unknownReasons: [],
      },
      uniqueSourceRanges: [{ startLba: 0, sectorCount: 100 }],
      uniqueSourceSectorCount: 100,
      knownUnrecoveredSourceRanges: [{
        startLba: 10,
        sectorCount: 5,
        classification: "individually_failed",
      }],
      unrecoveredUniqueSourceSectorCount: 5,
      titleMissingSourcePercentage: 5,
    },
    {
      titleIdentityId: "synthetic-title-2",
      titleIdentityObservationId: "synthetic-observation-2",
      displayTitleNumber: 2,
      selection: {
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 2,
          cellId: 1,
        }],
        angleNumber: 2,
        chapterStart: 2,
        chapterEnd: 3,
      },
      mappingCoverage: {
        state: "partial",
        policyVersion: "synthetic-map-v1",
        unknownReasons: [{
          code: "TITLE_SOURCE_MAP_INCOMPLETE",
          message: "The selected path has unresolved navigation.",
        }],
      },
      uniqueSourceRanges: [{ startLba: 200, sectorCount: 20 }],
      uniqueSourceSectorCount: null,
      knownUnrecoveredSourceRanges: [],
      unrecoveredUniqueSourceSectorCount: 0,
      titleMissingSourcePercentage: null,
    },
  ],
  truncated: false,
  unknownTitleImpact: {
    unrecoveredSourceSectorCount: 2,
    unrecoveredSourceRanges: [{
      startLba: 300,
      sectorCount: 2,
      classification: "skipped_untested",
    }],
    reasons: [{
      code: "TITLE_SOURCE_MAP_INCOMPLETE",
      message: "At least one selected title path has incomplete source coverage.",
    }],
  },
  noTitleMissingSourceProved: false,
  unavailableReasons: [],
} as unknown as CatalogReviewTitleDamage;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows proved percentages, partial-map unknowns, and source outside known title paths", () => {
  const html = renderToStaticMarkup(
    <CatalogReviewTitleDamageEvidence
      originalDiscArchiveId="synthetic-archive"
      titleDamage={titleDamage}
    />,
  );

  expect(html).toContain("Title Missing-Source Percentage: 5%");
  expect(html).toContain("Complete Title Missing-Source Percentage unavailable");
  expect(html).toContain("The selected path has unresolved navigation.");
  expect(html).toContain("Unknown title impact: 2 unrecovered source sectors");
  expect(html).not.toContain("no title damage found");
});

it("loads the complete current evidence through the paging route", async () => {
  const thirdItem = {
    ...titleDamage.items[0]!,
    titleIdentityId: "synthetic-title-3",
    titleIdentityObservationId: "synthetic-observation-3",
    displayTitleNumber: 3,
  };
  const fourthItem = {
    ...titleDamage.items[0]!,
    titleIdentityId: "synthetic-title-4",
    titleIdentityObservationId: "synthetic-observation-4",
    displayTitleNumber: 4,
  };
  const page = (items: readonly unknown[], nextCursor: string | null) =>
    Response.json({
      schemaVersion: 1,
      originalDiscArchiveId: "synthetic-archive",
      state: "current",
      checkpointRevision: 4,
      assessmentIdentity: "synthetic-assessment",
      currentAssessmentIdentity: "synthetic-assessment",
      createdAt: "2026-10-22T12:00:00.000Z",
      items,
      itemOffset: nextCursor === null ? 3 : 0,
      truncated: nextCursor !== null,
      nextCursor,
      unknownTitleImpact: titleDamage.unknownTitleImpact,
      noTitleMissingSourceProved: false,
      unavailableReasons: [],
    });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(page(
      [...titleDamage.items, thirdItem],
      "synthetic-next-cursor",
    ))
    .mockResolvedValueOnce(page([fourthItem], null));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(
    <CatalogReviewTitleDamageEvidence
      originalDiscArchiveId="synthetic-archive"
      titleDamage={{ ...titleDamage, truncated: true }}
    />,
  ));
  const button = container.querySelector("button");
  expect(button?.textContent).toContain("Load more Title Damage evidence");

  await act(async () => button?.click());

  expect(fetcher).toHaveBeenCalledWith(
    "/api/catalog-reviews/synthetic-archive/damage?limit=100",
    { headers: { Accept: "application/json" } },
  );
  expect(container.textContent).toContain("DVD title 3");
  expect(container.querySelector("button")).not.toBeNull();

  await act(async () => container.querySelector("button")?.click());

  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/catalog-reviews/synthetic-archive/damage?limit=100&cursor=synthetic-next-cursor",
    { headers: { Accept: "application/json" } },
  );
  expect(container.textContent).toContain("DVD title 4");
  expect(container.querySelector("button")).toBeNull();

  await act(async () => root.unmount());
});
