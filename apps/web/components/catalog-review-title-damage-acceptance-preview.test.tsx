// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  DvdTitleDamageAcceptancePreview,
  DvdTitleDamageAcceptanceWithdrawalPreview,
} from "@rip-dvd/application";

import { CatalogReviewTitleDamageAcceptancePreview } from
  "./catalog-review-title-damage-acceptance-preview";
import type {
  CatalogReviewTitleDamageDecision,
  CatalogReviewTitleIdentity,
} from "./catalog-review-model";

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
    assessmentSnapshot: {
      unrecoveredUniqueSourceSectorCount: 4,
      uniqueSourceSectorCount: 100,
      sourceContinuityRiskSectorCount: 1,
      titleMissingSourcePercentage: 4,
      mappingCoverage: {
        state: "partial",
        unknownReasons: [{
          code: "SYNTHETIC_MAPPING_UNKNOWN",
          message: "Synthetic mapping coverage is incomplete.",
        }],
      },
      estimatedAffectedPlayback: {
        intervals: [{
          playbackOccurrence: 1,
          startMilliseconds: 1_000,
          endMilliseconds: 5_000,
          timingMethods: ["synthetic-vobu-timing-v1"],
          coverage: "source_span",
        }],
        unknownCoverage: [{
          playbackOccurrence: 2,
          unrecoveredSourceSectorCount: 4,
          reasons: [{
            code: "SYNTHETIC_TIMING_UNKNOWN",
            message: "Synthetic timing is unavailable.",
          }],
        }],
      },
    },
    acknowledgementRequired: true,
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

const persistedDecision = {
  schemaVersion: 1,
  state: "accepted",
  current: {
    id: "synthetic-accepted-decision",
    decision: "accepted",
    acceptedDecisionId: null,
    operator: "Synthetic persisted operator",
    recordedAt: "2026-10-28T08:00:00.000Z",
    snapshot: {
      reviewedContent: [{}],
      exclusions: [{}, {}],
    },
  },
  latest: null,
  currentIdentities: {},
} as unknown as CatalogReviewTitleDamageDecision;

const withdrawalPreview = {
  schemaVersion: 1,
  evidenceFormat: "dvd-recovery-evidence-v1",
  available: true,
  previewToken:
    "dvd-title-damage-acceptance-withdrawal-preview:00000000-0000-4000-8000-000000000421",
  action: {
    available: true,
    reasons: [],
    expectedInputs: [
      "mutationKey",
      "operator",
      "previewToken",
      "acceptedDecisionId",
    ],
  },
  acceptedEvent: persistedDecision.current,
  affectedWork: [{
    id: "synthetic-encode-job",
    discSelectionId: "synthetic-selection-1",
    status: "queued",
  }],
  effects: {
    queuedClaimsBlocked: true,
    runningWorkContinues: true,
    existingOutputsChanged: false,
  },
} as unknown as DvdTitleDamageAcceptanceWithdrawalPreview;

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

it("shows the persisted current exact-set decision after refresh", async () => {
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      titleDamageDecision={persistedDecision}
      evidenceGeneration={evidenceGeneration}
    />,
  ));

  expect(container.textContent).toContain("Current exact-set decision");
  expect(container.textContent).toContain(
    "Damage accepted for the current exact reviewed set by Synthetic persisted operator",
  );
  expect(container.textContent).toContain("1 included and 2 excluded");
});

it("preflights and withdraws the current accepted event", async () => {
  const fetcher = vi.fn(async (
    request: RequestInfo | URL,
    _options?: RequestInit,
  ) =>
    String(request).endsWith("title-damage-acceptance-withdrawal-preview")
      ? Response.json(withdrawalPreview)
      : Response.json({ decision: { decision: "withdrawn" } })
  );
  await act(async () => root.render(
    <CatalogReviewTitleDamageAcceptancePreview
      originalDiscArchiveId="synthetic-archive"
      titleIdentity={titleIdentity}
      titleDamageDecision={persistedDecision}
      evidenceGeneration={evidenceGeneration}
      fetcher={fetcher}
    />,
  ));

  const previewButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview withdrawal",
  ) as HTMLButtonElement;
  await act(async () => previewButton.click());
  expect(container.textContent).toContain(
    "1 queued or running Encode Jobs affected",
  );
  expect(container.textContent).toContain(
    "Encode Job synthetic-encode-job: queued",
  );

  const operator = container.querySelector(
    'input[maxlength="128"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(operator, "Synthetic withdrawal operator");
    operator.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const withdrawButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Withdraw damage acceptance",
  ) as HTMLButtonElement;
  expect(withdrawButton.disabled).toBe(false);
  await act(async () => withdrawButton.click());

  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/catalog-reviews/synthetic-archive/title-damage-acceptance-withdrawal",
    expect.objectContaining({ method: "POST", body: expect.any(String) }),
  );
  const options = fetcher.mock.calls.at(-1)?.[1];
  if (options === undefined) throw new Error("Withdrawal request was not sent");
  expect(JSON.parse(options.body as string)).toEqual({
    mutationKey: expect.any(String),
    operator: "Synthetic withdrawal operator",
    previewToken: withdrawalPreview.previewToken,
    acceptedDecisionId: "synthetic-accepted-decision",
  });
  expect(container.textContent).toContain(
    "Damage acceptance withdrawn for the current exact reviewed set by Synthetic withdrawal operator.",
  );
});

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
  expect(container.textContent).toContain(
    "Title Identity synthetic-title-1",
  );
  expect(container.textContent).toContain(
    "Navigation: video title set 1, title-set title 1, program chain 1",
  );
  expect(container.textContent).toContain(
    "Selected path: program 1, cell 1, VOB 1, cell ID 1",
  );
  expect(container.textContent).toContain("movie: Synthetic Movie");
  expect(container.textContent).toContain("movie: Synthetic Movie (2026)");
  expect(container.textContent).toContain(
    "Main-feature choice resolved by its Title Identity binding to DVD title 1, angle 1, chapters 1-4",
  );
  expect(container.textContent).toContain(
    "Unknown title impact: 7 unrecovered source sectors",
  );
  expect(container.textContent).toContain("Encode Job synthetic-encode-job");
  expect(container.textContent).toContain(
    "Title Missing-Source Percentage: 4% (4 of 100 unique source sectors)",
  );
  expect(container.textContent).toContain("SYNTHETIC_MAPPING_UNKNOWN");
  expect(container.textContent).toContain(
    "Occurrence 1: 00:01.000 to 00:05.000",
  );
  expect(container.textContent).toContain(
    "Occurrence 2: playback location unknown for 4 unrecovered source sectors",
  );
  expect(container.textContent).toContain(
    "They do not claim exact playback lost or bound decoder effects",
  );
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

it("submits the exact preview identities and damage acknowledgement", async () => {
  const acceptancePreview = {
    ...preview,
    current: evidenceGeneration.current,
    acknowledgementRequired: true,
  } as unknown as DvdTitleDamageAcceptancePreview;
  const fetcher = vi.fn(async (
    request: RequestInfo | URL,
    _options?: RequestInit,
  ) =>
    String(request).endsWith("/title-damage-acceptance")
      ? Response.json({ decision: { decision: "accepted" } })
      : Response.json(acceptancePreview)
  );
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

  const operator = container.querySelector(
    'input[maxlength="128"]',
  ) as HTMLInputElement;
  const acknowledgement = [...container.querySelectorAll('input[type="checkbox"]')]
    .at(-1) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(operator, "Synthetic operator");
    operator.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    acknowledgement.click();
  });
  const accept = [...container.querySelectorAll("button")].find((button) =>
    button.textContent === "Accept exact reviewed set"
  ) as HTMLButtonElement;
  expect(accept.disabled).toBe(false);
  await act(async () => accept.click());

  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/catalog-reviews/synthetic-archive/title-damage-acceptance",
    expect.objectContaining({
      method: "POST",
      body: expect.any(String),
    }),
  );
  const options = fetcher.mock.calls.at(-1)?.[1];
  if (options === undefined) throw new Error("Acceptance request was not sent");
  expect(JSON.parse(options.body as string)).toEqual({
    mutationKey: expect.any(String),
    operator: "Synthetic operator",
    previewToken: preview.previewToken,
    checkpointRevision: 2,
    checkpointDigest: "a".repeat(64),
    assessmentIdentity: preview.assessmentIdentity,
    reviewSetIdentity: preview.reviewSetIdentity,
    catalogMappingProjectionId: preview.catalogMappingProjectionId,
    reviewedContentIdentity: preview.reviewedContentIdentity,
    excludedTitleIdentityIds: [],
    mainFeatureResolutions: [],
    damageAcknowledgement: true,
  });
  expect(container.textContent).toContain(
    "Damage accepted for this exact reviewed set.",
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

it("does not describe an unavailable assessment as clean", async () => {
  const unavailablePreview = {
    ...preview,
    available: false,
    previewToken: null,
    acknowledgementRequired: false,
    action: {
      available: false,
      reasons: [{
        code: "ASSESSMENT_PENDING",
        message: "Title Damage Assessment is pending.",
        details: {},
      }],
      expectedInputs: [],
    },
  } as unknown as DvdTitleDamageAcceptancePreview;
  const fetcher = vi.fn(async () => Response.json(unavailablePreview));
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

  expect(container.textContent).toContain(
    "Damage acknowledgement has not been determined because the preflight is unavailable",
  );
  expect(container.textContent).not.toContain("clean exact set");
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
        seasonNumber: null,
        episodeNumber: 2,
        episodicContext: {
          tvShow: {
            id: "synthetic-show",
            title: "Synthetic Show",
            year: 2024,
          },
          season: {
            id: "synthetic-season",
            title: "Season One",
            year: 2025,
            seasonNumber: 1,
          },
        },
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
    "episode: Synthetic Show (2024), season 1, episode 2: Synthetic Episode (2026); Media Item synthetic-orphaned-episode. DVD title 7, chapters 2-5",
  );
  expect(container.textContent).toContain("synthetic-orphaned-selection");
});
