import { describe, expect, it, vi } from "vitest";

import {
  type DataAccess,
  type DvdCheckpointReadHandle,
  type DvdTitleDamageAssessmentRecord,
  type DvdTitleIdentityObservationId,
  type DvdTitleIdentityReviewSet,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { assessDvdTitleDamageAtCheckpoint } from "./dvd-title-damage.js";

const archiveId = "synthetic-archive" as OriginalDiscArchiveId;
const checkpoint = {
  manifestId: "synthetic-manifest-1",
  manifestRevision: 1,
  manifestDigest: "a".repeat(64),
};
const titleIdentity = {
  checkpoint,
  reviewSetIdentity: "b".repeat(64),
} as DvdTitleIdentityReviewSet;
const structuralAssessmentIdentity =
  `dvd-structural-assessment:${"c".repeat(64)}`;
const evidence = {
  checkpoint,
  titleIdentity,
  structuralAssessmentIdentity,
};
const handle = {
  descriptor: 42,
  signal: new AbortController().signal,
  assertOwned: vi.fn(),
} satisfies DvdCheckpointReadHandle;

describe("assessDvdTitleDamageAtCheckpoint", () => {
  it("delegates mapping and persistence to the owned data-access operation", async () => {
    const assessment = { id: "synthetic-assessment" } as
      DvdTitleDamageAssessmentRecord;
    const mappings = [{
      titleIdentityObservationId:
        "synthetic-observation" as DvdTitleIdentityObservationId,
      sourceReferences: [{
        kind: "multiplexed_content" as const,
        startLba: 10,
        sectorCount: 2,
      }],
      mappingCoverage: {
        state: "partial" as const,
        policyVersion: "synthetic-map-v1",
        unknownReasons: [{
          code: "TITLE_SOURCE_MAP_INCOMPLETE",
          message: "Synthetic incomplete map.",
        }],
      },
    }];
    const withConsistentRead = vi.fn(async (request) => {
      expect(request.signal.aborted).toBe(false);
      return request.task(handle);
    });
    const assessDvdTitleDamage = vi.fn(async (
      _id,
      ownership,
      assess,
    ) => {
      await ownership.withConsistentRead({
        archiveId,
        imagePath: null,
        originalsLibraryPath: "/media/originals",
        signal: new AbortController().signal,
        task: (ownedHandle: DvdCheckpointReadHandle) =>
          assess(evidence, ownedHandle),
      });
      return assessment;
    }) as DataAccess["assessDvdTitleDamage"];

    await expect(assessDvdTitleDamageAtCheckpoint({
      access: { assessDvdTitleDamage },
      archiveImageOwnership: { withConsistentRead },
      originalDiscArchiveId: archiveId,
      signal: new AbortController().signal,
      mapSource: async (input) => {
        expect(input).toMatchObject({
          ...evidence,
          descriptor: 42,
        });
        return mappings;
      },
    })).resolves.toBe(assessment);
    expect(assessDvdTitleDamage).toHaveBeenCalledOnce();
    expect(withConsistentRead).toHaveBeenCalledOnce();
  });

  it("rejects an archive without new-format checkpoint evidence", async () => {
    const assessDvdTitleDamage = vi.fn(async () => null) as
      DataAccess["assessDvdTitleDamage"];

    await expect(assessDvdTitleDamageAtCheckpoint({
      access: { assessDvdTitleDamage },
      archiveImageOwnership: { withConsistentRead: vi.fn() },
      originalDiscArchiveId: archiveId,
      signal: new AbortController().signal,
      mapSource: async () => [],
    })).rejects.toThrow(
      "Title Damage Assessment requires a new-format DVD evidence checkpoint",
    );
  });
});
