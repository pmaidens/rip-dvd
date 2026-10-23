import { describe, expect, it } from "vitest";

import {
  dvdTitleIdentityCatalogMappingProjectionDigest,
  dvdTitleIdentityCatalogMappingItems,
  dvdTitleIdentityContentDigest,
  dvdTitleIdentityDiscSelectionDigest,
  dvdTitleIdentityObservationSetDigest,
  dvdTitleIdentityReviewSetDigest,
  normalizeDvdTitleIdentityObservation,
} from "./dvd-title-identity.js";
import {
  createDiscSelectionSourceIdentity,
} from "./disc-selection-source-identity.js";
import type {
  DiscSelectionId,
  DvdTitleIdentityId,
  DvdTitleIdentityObservationId,
  DvdTitleIdentityReviewSetItem,
  MediaItemId,
} from "./types.js";

describe("DVD Title Identity digests", () => {
  it("uses stable domain-separated canonical encodings", () => {
    const observation = normalizeDvdTitleIdentityObservation({
      displayTitleNumber: 7,
      navigation: {
        videoTitleSetNumber: 2,
        titleSetTitleNumber: 3,
        programChainNumber: 4,
      },
      selectedPath: [{
        programNumber: 1,
        cellNumber: 2,
        vobId: 3,
        cellId: 4,
      }],
      angleNumber: 1,
      angleCount: 2,
      chapterStart: 2,
      chapterEnd: 5,
      chapterCount: 8,
      sourceExtents: [{ startLba: 100, sectorCount: 20 }],
    }, 1_000);
    const contentDigest = dvdTitleIdentityContentDigest(observation);
    const observationSetDigest = dvdTitleIdentityObservationSetDigest([{
      ...observation,
      contentDigest,
    }]);
    const checkpoint = {
      manifestId: "manifest-2",
      manifestRevision: 2,
      manifestDigest: "a".repeat(64),
    };
    const discSelectionIdentity = dvdTitleIdentityDiscSelectionDigest({
      discSelectionId: "selection-1" as DiscSelectionId,
      mediaItemId: "media-item-1" as MediaItemId,
      sourceIdentity: createDiscSelectionSourceIdentity({
        kind: "dvd_title",
        titleNumber: 7,
      }),
    });
    const items: DvdTitleIdentityReviewSetItem[] = [{
      titleIdentityId: "title-identity-1" as DvdTitleIdentityId,
      presentAtCurrentCheckpoint: true,
      observation: {
        id: "observation-2" as DvdTitleIdentityObservationId,
        titleIdentityId: "title-identity-1" as DvdTitleIdentityId,
        checkpoint,
        ...observation,
        contentDigest,
        continuity: {
          result: "proved",
          policyVersion: "dvd-title-identity-continuity-v1",
          previousObservationId:
            "observation-1" as DvdTitleIdentityObservationId,
        },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      reviewContinuity: {
        result: "proved",
        policyVersion: "dvd-title-identity-continuity-v1",
        previousObservationId:
          "observation-1" as DvdTitleIdentityObservationId,
      },
      mappingState: "mapped",
      discSelectionMappings: [{
        discSelectionId: "selection-1" as DiscSelectionId,
        discSelectionIdentity,
        mappingState: "mapped",
      }],
    }];

    expect(contentDigest).toBe(
      "2bc4355f0c56481249997a6954f6cd4c489ced56283ecc65ae15edf7dd18748b",
    );
    expect(observationSetDigest).toBe(
      "7dfc3b5b6498b860dee1e11419014e7aa25fc1a1d6405a86b55253dcc91fda2d",
    );
    expect(dvdTitleIdentityReviewSetDigest(checkpoint, items)).toBe(
      "fe9665b3f060fa2db6f1dca0bb19906dcd9c8dea8db7ba15305bd156219f168d",
    );
    const changedSelectionItems = [{
      ...items[0]!,
      discSelectionMappings: [{
        ...items[0]!.discSelectionMappings[0]!,
        discSelectionIdentity: dvdTitleIdentityDiscSelectionDigest({
          discSelectionId: "selection-1" as DiscSelectionId,
          mediaItemId: "media-item-1" as MediaItemId,
          sourceIdentity: createDiscSelectionSourceIdentity({
            kind: "dvd_chapters",
            titleNumber: 7,
            chapterStart: 2,
            chapterEnd: 5,
          }),
        }),
      }],
    }];
    expect(dvdTitleIdentityReviewSetDigest(checkpoint, changedSelectionItems))
      .toBe(dvdTitleIdentityReviewSetDigest(checkpoint, items));
    expect(
      dvdTitleIdentityCatalogMappingProjectionDigest(
        checkpoint,
        changedSelectionItems,
      ),
    ).not.toBe(
      dvdTitleIdentityCatalogMappingProjectionDigest(checkpoint, items),
    );
    expect(dvdTitleIdentityContentDigest({
      ...observation,
      displayTitleNumber: 99,
    })).toBe(contentDigest);

    const alternateAngle = {
      ...items[0]!,
      titleIdentityId: "title-identity-2" as DvdTitleIdentityId,
      observation: {
        ...items[0]!.observation,
        id: "observation-3" as DvdTitleIdentityObservationId,
        titleIdentityId: "title-identity-2" as DvdTitleIdentityId,
        angleNumber: 2,
      },
      mappingState: "unmapped" as const,
      discSelectionMappings: [],
    };
    expect(dvdTitleIdentityCatalogMappingItems([
      items[0]!,
      alternateAngle,
      {
        ...alternateAngle,
        discSelectionMappings: [{
          discSelectionId: "selection-2" as DiscSelectionId,
          discSelectionIdentity: "b".repeat(64),
          mappingState: "needs_mapping_review",
        }],
      },
    ])).toEqual([
      items[0],
      expect.objectContaining({
        titleIdentityId: "title-identity-2",
        discSelectionMappings: [expect.objectContaining({
          discSelectionId: "selection-2",
        })],
      }),
    ]);
  });
});
