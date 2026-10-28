// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DvdDamageAcceptancePreview } from "@rip-dvd/application";

import { CatalogReviewDamageAcceptancePreview } from
  "./catalog-review-damage-acceptance-preview";
import type { CatalogReviewTitleIdentity } from "./catalog-review-model";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const titleIdentity = {
  available: true,
  unavailableReason: null,
  checkpoint: {
    manifestId: "synthetic-manifest",
    manifestRevision: 2,
    manifestDigest: "a".repeat(64),
  },
  policyVersion: "synthetic-title-identity-v1",
  reviewSetIdentity: "b".repeat(64),
  items: [{
    titleIdentityId: "synthetic-title-1",
    presentAtCurrentCheckpoint: true,
    mappingState: "mapped",
    discSelectionMappings: [{
      discSelectionId: "synthetic-selection-1",
      mappingState: "mapped",
    }],
    reviewContinuity: {
      result: "proved",
      policyVersion: "synthetic-title-identity-v1",
      previousObservationId: "synthetic-observation-0",
    },
    observation: {
      id: "synthetic-observation-1",
      titleIdentityId: "synthetic-title-1",
      checkpoint: {
        manifestId: "synthetic-manifest",
        manifestRevision: 2,
        manifestDigest: "a".repeat(64),
      },
      displayTitleNumber: 1,
      navigation: {
        videoTitleSetNumber: 1,
        titleSetTitleNumber: 1,
        programChainNumber: 1,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 1,
        vobId: 1,
        cellId: 1,
      }],
      angleNumber: 1,
      angleCount: 1,
      chapterStart: 1,
      chapterEnd: 4,
      chapterCount: 4,
      sourceExtents: [{ startLba: 0, sectorCount: 100 }],
      contentDigest: "c".repeat(64),
      continuity: {
        result: "proved",
        policyVersion: "synthetic-title-identity-v1",
        previousObservationId: "synthetic-observation-0",
      },
      createdAt: "2026-10-27T12:00:00.000Z",
    },
  }],
} satisfies CatalogReviewTitleIdentity;

const preview = {
  schemaVersion: 1,
  evidenceFormat: "dvd-recovery-evidence-v1",
  available: true,
  previewToken:
    "dvd-damage-acceptance-preview:00000000-0000-4000-8000-000000000001",
  action: { available: true, reasons: [], expectedInputs: ["previewToken"] },
  current: null,
  reviewSetIdentity: "b".repeat(64),
  catalogMappingProjectionId: "c".repeat(64),
  assessmentIdentity: `dvd-title-damage-assessment:${"d".repeat(64)}`,
  reviewedContentIdentity: "e".repeat(64),
  allContent: [{
    titleIdentityId: "synthetic-title-1",
    titleIdentityObservationId: "synthetic-observation-1",
    included: false,
    mappingState: "mapped",
    reviewContinuity: titleIdentity.items[0]!.reviewContinuity,
    sourceIdentity: {
      displayTitleNumber: 1,
      navigation: titleIdentity.items[0]!.observation.navigation,
      selectedPath: titleIdentity.items[0]!.observation.selectedPath,
      angleNumber: 1,
      angleCount: 1,
      chapterStart: 1,
      chapterEnd: 4,
      chapterCount: 4,
      sourceExtents: [{ startLba: 0, sectorCount: 100 }],
    },
    catalogMappings: [{
      discSelectionId: "synthetic-selection-1",
      discSelectionIdentity: "f".repeat(64),
      mappingState: "mapped",
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 2,
      },
      label: null,
      mediaItem: {
        id: "synthetic-movie",
        kind: "movie",
        title: "Synthetic Movie",
        year: 2026,
        seasonNumber: null,
        episodeNumber: null,
      },
    }],
    assessmentSnapshot: null,
    acknowledgementRequired: false,
  }],
  reviewedContent: [],
  exclusions: [{
    titleIdentityId: "synthetic-title-1",
    titleIdentityObservationId: "synthetic-observation-1",
    displayTitleNumber: 1,
    angleNumber: 1,
  }],
  assessmentSnapshot: null,
  acknowledgementRequired: false,
  affectedWork: [],
  damagePreview: {
    required: false,
    available: false,
    reasons: [{
      code: "DAMAGE_PREVIEW_UNAVAILABLE",
      message: "Damage Preview is optional.",
    }],
  },
} as unknown as DvdDamageAcceptancePreview;

it("includes all current content by default and sends only explicit exclusions", async () => {
  const fetcher = vi.fn(async () => Response.json(preview));
  await act(async () => root.render(
    <CatalogReviewDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      fetcher={fetcher}
    />,
  ));
  expect(container.textContent).toContain(
    "DVD title 1, angle 1 of 1, chapters 1-4",
  );
  const exclusion = container.querySelector("input") as HTMLInputElement;
  expect(exclusion.checked).toBe(false);
  await act(async () => exclusion.click());
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/catalog-reviews/synthetic-archive/damage-acceptance-preview",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        excludedTitleIdentityIds: ["synthetic-title-1"],
      }),
    }),
  );
  expect(container.textContent).toContain("0 included, 1 excluded");
  expect(container.textContent).toContain("movie: Synthetic Movie");
  expect(container.textContent).toContain(
    "A Damage Preview is optional. Its unavailability does not block this preflight.",
  );
});
