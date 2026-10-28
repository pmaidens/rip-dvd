// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DvdTitleDamageAcceptancePreview } from "@rip-dvd/application";

import { CatalogReviewTitleDamageAcceptancePreview } from
  "./catalog-review-title-damage-acceptance-preview";
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
    "dvd-title-damage-acceptance-preview:00000000-0000-4000-8000-000000000001",
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
      sourceIdentity: { kind: "main_feature" },
      resolvedSourceIdentity: {
        resolution: "title_identity_binding",
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
  mainFeatureChoices: [{
    discSelectionId: "synthetic-selection-1",
    mediaItem: {
      id: "synthetic-movie",
      kind: "movie",
      title: "Synthetic Movie",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
    },
    resolvedTitleIdentityId: null,
    resolvedSourceIdentity: null,
  }],
  unresolvedSelections: [],
  assessmentSnapshot: {
    unknownTitleImpact: {
      unrecoveredSourceSectorCount: 7,
      unrecoveredSourceRanges: [],
      reasons: [{ code: "SYNTHETIC_UNKNOWN", message: "Synthetic unknown." }],
    },
    unattributedSourceContinuityRisk: {
      sourceSectorCount: 2,
      sourceRanges: [],
    },
  },
  acknowledgementRequired: false,
  affectedWork: [{
    id: "synthetic-encode-job",
    discSelectionId: "synthetic-selection-1",
    status: "queued",
  }],
  damagePreview: {
    required: false,
    available: false,
    reasons: [{
      code: "DAMAGE_PREVIEW_UNAVAILABLE",
      message: "Damage Preview is optional.",
    }],
  },
} as unknown as DvdTitleDamageAcceptancePreview;

const evidenceGeneration = {
  current: {
    originalDiscArchiveId: "synthetic-archive",
    catalogRevision: "2026-10-27T12:00:00.000Z",
    catalogReviewOutcome: "needs_review" as const,
    archiveJob: { id: "synthetic-archive-job", status: "completed" as const },
    checkpoint: { revision: 2, manifestDigest: "a".repeat(64) },
    recovery: {
      id: "synthetic-recovery",
      attemptId: "synthetic-recovery-attempt",
      state: "stopped" as const,
      work: null,
    },
    catalogMappingProjectionId: "c".repeat(64),
    titleDamageAssessmentId:
      `dvd-title-damage-assessment:${"d".repeat(64)}`,
  },
  titleDamageState: "current" as const,
  activityRevision: "activity-revision-1",
};

const boundEvidenceChanges = [
  {
    name: "catalog revision",
    value: {
      ...evidenceGeneration,
      current: {
        ...evidenceGeneration.current,
        catalogRevision: "2026-10-27T12:00:01.000Z",
      },
    },
  },
  {
    name: "checkpoint",
    value: {
      ...evidenceGeneration,
      current: {
        ...evidenceGeneration.current,
        checkpoint: { revision: 3, manifestDigest: "e".repeat(64) },
      },
    },
  },
  {
    name: "Catalog mapping projection",
    value: {
      ...evidenceGeneration,
      current: {
        ...evidenceGeneration.current,
        catalogMappingProjectionId: "f".repeat(64),
      },
    },
  },
  {
    name: "Title Damage Assessment identity",
    value: {
      ...evidenceGeneration,
      current: {
        ...evidenceGeneration.current,
        titleDamageAssessmentId:
          `dvd-title-damage-assessment:${"1".repeat(64)}`,
      },
    },
  },
  {
    name: "Title Damage Assessment state",
    value: { ...evidenceGeneration, titleDamageState: "outdated" as const },
  },
  {
    name: "Recovery state",
    value: {
      ...evidenceGeneration,
      current: {
        ...evidenceGeneration.current,
        recovery: {
          ...evidenceGeneration.current.recovery,
          state: "running" as const,
        },
      },
    },
  },
  {
    name: "affected-work activity revision",
    value: {
      ...evidenceGeneration,
      activityRevision: "activity-revision-2",
    },
  },
];

it("includes all current content by default and sends only explicit exclusions", async () => {
  const fetcher = vi.fn(async () => Response.json(preview));
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      evidenceGeneration={evidenceGeneration}
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
    "/api/catalog-reviews/synthetic-archive/title-damage-acceptance-preview",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        excludedTitleIdentityIds: ["synthetic-title-1"],
        mainFeatureResolutions: [],
      }),
    }),
  );
  expect(container.textContent).toContain("0 included, 1 excluded");
  expect(container.textContent).toContain("movie: Synthetic Movie");
  expect(container.textContent).toContain(
    "Main-feature choice resolved by its Title Identity binding to DVD title 1, angle 1, chapters 1-4",
  );
  expect(container.textContent).toContain(
    "Unknown title impact: 7 unrecovered source sectors",
  );
  expect(container.textContent).toContain("Encode Job synthetic-encode-job");
  const resolution = container.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    resolution.value = "synthetic-title-1";
    resolution.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).not.toContain(preview.previewToken);
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/catalog-reviews/synthetic-archive/title-damage-acceptance-preview",
    expect.objectContaining({
      body: JSON.stringify({
        excludedTitleIdentityIds: ["synthetic-title-1"],
        mainFeatureResolutions: [{
          discSelectionId: "synthetic-selection-1",
          titleIdentityId: "synthetic-title-1",
        }],
      }),
    }),
  );
  const clearedResolution = container.querySelector(
    "select",
  ) as HTMLSelectElement;
  await act(async () => {
    clearedResolution.value = "";
    clearedResolution.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).not.toContain(preview.previewToken);
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/catalog-reviews/synthetic-archive/title-damage-acceptance-preview",
    expect.objectContaining({
      body: JSON.stringify({
        excludedTitleIdentityIds: ["synthetic-title-1"],
        mainFeatureResolutions: [],
      }),
    }),
  );
  expect(container.textContent).toContain(
    "A Damage Preview is optional. Its unavailability does not block this preflight.",
  );
});

it("invalidates the preview when the current review set changes", async () => {
  const fetcher = vi.fn(async () => Response.json(preview));
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      evidenceGeneration={evidenceGeneration}
      fetcher={fetcher}
    />,
  ));
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  expect(container.textContent).toContain(preview.previewToken);

  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={{
        ...titleIdentity,
        reviewSetIdentity: "new-review-set-identity",
      }}
      evidenceGeneration={evidenceGeneration}
      fetcher={fetcher}
    />,
  ));

  expect(container.textContent).not.toContain(preview.previewToken);
});

it.each(boundEvidenceChanges)(
  "invalidates the preview when the $name changes",
  async ({ value }) => {
    const fetcher = vi.fn(async () => Response.json(preview));
    await act(async () => root.render(
      <CatalogReviewTitleDamageAcceptancePreview
        originalDiscArchiveId="synthetic-archive"
        titleIdentity={titleIdentity}
        evidenceGeneration={evidenceGeneration}
        fetcher={fetcher}
      />,
    ));
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain(preview.previewToken);

    await act(async () => root.render(
      <CatalogReviewTitleDamageAcceptancePreview
        originalDiscArchiveId="synthetic-archive"
        titleIdentity={titleIdentity}
        evidenceGeneration={value}
        fetcher={fetcher}
      />,
    ));

    expect(container.textContent).not.toContain(preview.previewToken);
  },
);

it("ignores an in-flight preview from an older evidence generation", async () => {
  let completeRequest: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
    completeRequest = resolve;
  }));
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      evidenceGeneration={evidenceGeneration}
      fetcher={fetcher}
    />,
  ));
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });

  const changed = {
    ...evidenceGeneration,
    activityRevision: "activity-revision-2",
  };
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      evidenceGeneration={changed}
      fetcher={fetcher}
    />,
  ));
  await act(async () => {
    completeRequest?.(Response.json(preview));
    await Promise.resolve();
  });

  expect(container.textContent).not.toContain(preview.previewToken);
});

it("shows active Disc Selections without a current Title Identity binding", async () => {
  const unresolvedPreview = {
    ...preview,
    available: false,
    previewToken: null,
    unresolvedSelections: [{
      discSelectionId: "synthetic-orphaned-selection",
      sourceIdentity: {
        kind: "dvd_chapters" as const,
        titleNumber: 7,
        chapterStart: 2,
        chapterEnd: 5,
      },
      label: null,
      mediaItem: {
        id: "synthetic-orphaned-episode",
        kind: "episode" as const,
        title: "Synthetic Episode",
        year: 2026,
        seasonNumber: 1,
        episodeNumber: 2,
      },
    }],
  } as unknown as DvdTitleDamageAcceptancePreview;
  const fetcher = vi.fn(async () => Response.json(unresolvedPreview));
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      evidenceGeneration={evidenceGeneration}
      fetcher={fetcher}
    />,
  ));
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });

  expect(container.textContent).toContain("Unresolved Disc Selections");
  expect(container.textContent).toContain(
    "episode: Synthetic Episode. DVD title 7, chapters 2-5",
  );
  expect(container.textContent).toContain("synthetic-orphaned-selection");
});
