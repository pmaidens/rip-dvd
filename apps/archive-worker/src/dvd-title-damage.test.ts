import { describe, expect, it, vi } from "vitest";

import {
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdTitleDamageAssessmentRecord,
  type DvdTitleIdentityReviewSet,
  type DvdTitleIdentityObservationId,
  type OriginalDiscArchive,
} from "@rip-dvd/data-access";
import type { ArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import { assessDvdTitleDamageAtCheckpoint } from "./dvd-title-damage.js";

const archive = {
  id: "synthetic-archive",
  archivePath: "/media/originals/synthetic.iso",
} as unknown as OriginalDiscArchive;
const checkpoint = {
  manifestId: "synthetic-manifest-1",
  manifestRevision: 1,
  manifestDigest: "a".repeat(64),
};
const header = {
  currentManifestId: checkpoint.manifestId,
  currentManifestRevision: checkpoint.manifestRevision,
  currentManifestDigest: checkpoint.manifestDigest,
};
const titleIdentity = {
  checkpoint,
  reviewSetIdentity: "b".repeat(64),
} as DvdTitleIdentityReviewSet;
const structural = {
  state: "current",
  currentAssessmentIdentity: `dvd-structural-assessment:${"c".repeat(64)}`,
};

function ownership() {
  let active = false;
  const withConsistentRead = vi.fn(
    async <Result>(
      request: Parameters<ArchiveImageOwnership["withConsistentRead"]>[0],
    ) => {
      active = true;
      try {
        return await request.task({
          descriptor: 42,
          signal: request.signal,
          assertOwned: () => {
            if (!active) throw new Error("consistent read ended");
          },
        }) as Result;
      } finally {
        active = false;
      }
    },
  );
  return {
    archiveImageOwnership: {
      withConsistentRead,
    } as Pick<ArchiveImageOwnership, "withConsistentRead">,
    isActive: () => active,
  };
}

describe("assessDvdTitleDamageAtCheckpoint", () => {
  it("records mapped evidence before the checkpoint-stable interval ends", async () => {
    const imageOwnership = ownership();
    const assessment = { id: "synthetic-assessment" } as
      DvdTitleDamageAssessmentRecord;
    const record = vi.fn(() => {
      expect(imageOwnership.isActive()).toBe(true);
      return assessment;
    });
    const access = {
      catalog: {
        listOriginalDiscArchives: vi.fn(() => [archive]),
        findDvdArchiveEvidenceHeader: vi.fn(() => header),
        readDvdTitleIdentityReviewSet: vi.fn(() => titleIdentity),
      },
      dvdStructuralAssessments: { inspect: vi.fn(() => structural) },
      dvdTitleDamageAssessments: { record },
    } as unknown as DvdTitleDamageAssessmentRequestAccess;
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

    await expect(assessDvdTitleDamageAtCheckpoint({
      access,
      archiveImageOwnership: imageOwnership.archiveImageOwnership,
      originalDiscArchiveId: archive.id,
      originalsLibraryPath: "/media/originals",
      signal: new AbortController().signal,
      mapSource: async ({ descriptor }) => {
        expect(imageOwnership.isActive()).toBe(true);
        expect(descriptor).toBe(42);
        return mappings;
      },
    })).resolves.toBe(assessment);
    expect(record).toHaveBeenCalledWith({
      originalDiscArchiveId: archive.id,
      checkpoint,
      titleIdentityReviewSetIdentity: titleIdentity.reviewSetIdentity,
      structuralAssessmentIdentity: structural.currentAssessmentIdentity,
      titles: mappings,
    });
  });

  it("rejects a checkpoint change before persistence", async () => {
    const imageOwnership = ownership();
    const record = vi.fn();
    const access = {
      catalog: {
        listOriginalDiscArchives: vi.fn(() => [archive]),
        findDvdArchiveEvidenceHeader: vi.fn()
          .mockReturnValueOnce(header)
          .mockReturnValueOnce({
            ...header,
            currentManifestRevision: 2,
          }),
        readDvdTitleIdentityReviewSet: vi.fn(() => titleIdentity),
      },
      dvdStructuralAssessments: { inspect: vi.fn(() => structural) },
      dvdTitleDamageAssessments: { record },
    } as unknown as DvdTitleDamageAssessmentRequestAccess;

    await expect(assessDvdTitleDamageAtCheckpoint({
      access,
      archiveImageOwnership: imageOwnership.archiveImageOwnership,
      originalDiscArchiveId: archive.id,
      originalsLibraryPath: "/media/originals",
      signal: new AbortController().signal,
      mapSource: async () => [],
    })).rejects.toMatchObject({
      code: "DVD_EVIDENCE_CHANGED_DURING_READ",
    } satisfies Partial<DvdCheckpointReadFault>);
    expect(record).not.toHaveBeenCalled();
  });
});

type DvdTitleDamageAssessmentRequestAccess = Pick<
  DataAccess,
  "catalog" | "dvdStructuralAssessments" | "dvdTitleDamageAssessments"
>;
