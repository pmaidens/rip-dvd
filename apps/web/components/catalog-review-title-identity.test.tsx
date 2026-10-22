import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewTitleIdentity } from "./catalog-review-title-identity";

describe("CatalogReviewTitleIdentity", () => {
  it("keeps uncertain selections and newly discovered content visible", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewTitleIdentity
        titleIdentity={{
          available: true,
          unavailableReason: null,
          checkpoint: {
            manifestId: "synthetic-manifest-2",
            manifestRevision: 2,
            manifestDigest: "b".repeat(64),
          },
          policyVersion: "dvd-title-identity-continuity-v1",
          reviewSetIdentity: "c".repeat(64),
          items: [
            {
              titleIdentityId: "synthetic-title-1",
              presentAtCurrentCheckpoint: true,
              mappingState: "needs_mapping_review",
              discSelectionMappings: [{
                discSelectionId: "synthetic-selection-1",
                mappingState: "needs_mapping_review",
              }],
              reviewContinuity: {
                result: "uncertain",
                policyVersion: "dvd-title-identity-continuity-v1",
                previousObservationId: "synthetic-observation-1",
              },
              observation: {
                id: "synthetic-observation-2",
                titleIdentityId: "synthetic-title-1",
                checkpoint: {
                  manifestId: "synthetic-manifest-2",
                  manifestRevision: 2,
                  manifestDigest: "b".repeat(64),
                },
                displayTitleNumber: 3,
                navigation: {
                  videoTitleSetNumber: 1,
                  titleSetTitleNumber: 1,
                  programChainNumber: 2,
                },
                selectedPath: [{
                  programNumber: 1,
                  cellNumber: 1,
                  vobId: 1,
                  cellId: 2,
                }],
                angleNumber: 1,
                angleCount: 1,
                chapterStart: 1,
                chapterEnd: 8,
                chapterCount: 8,
                sourceExtents: [{ startLba: 50, sectorCount: 100 }],
                contentDigest: "d".repeat(64),
                continuity: {
                  result: "uncertain",
                  policyVersion: "dvd-title-identity-continuity-v1",
                  previousObservationId: "synthetic-observation-1",
                },
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
            {
              titleIdentityId: "synthetic-title-2",
              presentAtCurrentCheckpoint: true,
              mappingState: "unmapped",
              discSelectionMappings: [],
              reviewContinuity: {
                result: "new",
                policyVersion: "dvd-title-identity-continuity-v1",
                previousObservationId: null,
              },
              observation: {
                id: "synthetic-observation-3",
                titleIdentityId: "synthetic-title-2",
                checkpoint: {
                  manifestId: "synthetic-manifest-2",
                  manifestRevision: 2,
                  manifestDigest: "b".repeat(64),
                },
                displayTitleNumber: 7,
                navigation: {
                  videoTitleSetNumber: 2,
                  titleSetTitleNumber: 1,
                  programChainNumber: 1,
                },
                selectedPath: [{
                  programNumber: 1,
                  cellNumber: 1,
                  vobId: 2,
                  cellId: 1,
                }],
                angleNumber: 1,
                angleCount: 1,
                chapterStart: 1,
                chapterEnd: 1,
                chapterCount: 1,
                sourceExtents: [{ startLba: 200, sectorCount: 10 }],
                contentDigest: "e".repeat(64),
                continuity: {
                  result: "new",
                  policyVersion: "dvd-title-identity-continuity-v1",
                  previousObservationId: null,
                },
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Title identity across revisions");
    expect(html).toContain("DVD title 3");
    expect(html).toContain("Continuity uncertain. Needs mapping review.");
    expect(html).toContain(
      "Retained Disc Selection ID: synthetic-selection-1.",
    );
    expect(html).toContain("DVD title 7");
    expect(html).toContain("Newly discovered content. Unmapped.");
  });
});
