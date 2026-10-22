import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { CatalogReviewTitleDamageEvidence } from "./catalog-review-title-damage";
import type { CatalogReviewTitleDamage } from "./catalog-review-model";

it("shows proved percentages, partial-map unknowns, and source outside known title paths", () => {
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

  const html = renderToStaticMarkup(
    <CatalogReviewTitleDamageEvidence titleDamage={titleDamage} />,
  );

  expect(html).toContain("Title Missing-Source Percentage: 5%");
  expect(html).toContain("Complete Title Missing-Source Percentage unavailable");
  expect(html).toContain("The selected path has unresolved navigation.");
  expect(html).toContain("Unknown title impact: 2 unrecovered source sectors");
  expect(html).not.toContain("no title damage found");
});
