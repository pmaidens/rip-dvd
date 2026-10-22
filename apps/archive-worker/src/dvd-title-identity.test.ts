import { describe, expect, it, vi } from "vitest";

import {
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdArchiveEvidenceHeader,
  type DvdTitleIdentityReviewSet,
  type OriginalDiscArchive,
} from "@rip-dvd/data-access";
import type { ArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import { observeDvdTitleIdentitiesAtCheckpoint } from "./dvd-title-identity.js";

const archive = {
  id: "synthetic-archive",
  archivePath: "/media/originals/synthetic.iso",
} as unknown as OriginalDiscArchive;

const header = {
  originalDiscArchiveId: archive.id,
  evidenceFormat: "dvd-recovery-evidence-v1",
  currentManifestId: "synthetic-manifest-1",
  currentManifestRevision: 1,
  currentManifestDigest: "a".repeat(64),
} as unknown as DvdArchiveEvidenceHeader;

const observation = {
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
  chapterEnd: 1,
  chapterCount: 1,
  sourceExtents: [{ startLba: 0, sectorCount: 1 }],
};

function ownership() {
  let intervalActive = false;
  const withConsistentRead = vi.fn(
    async <Result>(request: Parameters<ArchiveImageOwnership["withConsistentRead"]>[0]) => {
      intervalActive = true;
      try {
        return await request.task({
          descriptor: 42,
          signal: request.signal,
          assertOwned: () => {
            if (!intervalActive) throw new Error("consistent read ended");
          },
        }) as Result;
      } finally {
        intervalActive = false;
      }
    },
  );
  return {
    archiveImageOwnership: {
      withConsistentRead,
    } as Pick<ArchiveImageOwnership, "withConsistentRead">,
    intervalIsActive: () => intervalActive,
    withConsistentRead,
  };
}

describe("observeDvdTitleIdentitiesAtCheckpoint", () => {
  it("records observations while the same checkpoint has a shared read interval", async () => {
    const imageOwnership = ownership();
    const result = { reviewSetIdentity: "review-set" } as DvdTitleIdentityReviewSet;
    const record = vi.fn(() => {
      expect(imageOwnership.intervalIsActive()).toBe(true);
      return result;
    });
    const findHeader = vi.fn(() => header);
    const access = {
      catalog: {
        listOriginalDiscArchives: vi.fn(() => [archive]),
        findDvdArchiveEvidenceHeader: findHeader,
        recordDvdTitleIdentityObservations: record,
      },
    } as unknown as Pick<DataAccess, "catalog">;

    await expect(observeDvdTitleIdentitiesAtCheckpoint({
      access,
      archiveImageOwnership: imageOwnership.archiveImageOwnership,
      originalDiscArchiveId: archive.id,
      originalsLibraryPath: "/media/originals",
      signal: new AbortController().signal,
      observe: async ({ checkpoint, descriptor }) => {
        expect(imageOwnership.intervalIsActive()).toBe(true);
        expect(checkpoint).toEqual({
          manifestId: header.currentManifestId,
          manifestRevision: 1,
          manifestDigest: header.currentManifestDigest,
        });
        expect(descriptor).toBe(42);
        return [observation];
      },
    })).resolves.toBe(result);
    expect(findHeader).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith({
      originalDiscArchiveId: archive.id,
      checkpoint: {
        manifestId: header.currentManifestId,
        manifestRevision: 1,
        manifestDigest: header.currentManifestDigest,
      },
      observations: [observation],
    });
  });

  it("rejects mixed revisions before recording", async () => {
    const imageOwnership = ownership();
    const record = vi.fn();
    const findHeader = vi.fn()
      .mockReturnValueOnce(header)
      .mockReturnValueOnce({
        ...header,
        currentManifestId: "synthetic-manifest-2",
        currentManifestRevision: 2,
        currentManifestDigest: "b".repeat(64),
      });
    const access = {
      catalog: {
        listOriginalDiscArchives: vi.fn(() => [archive]),
        findDvdArchiveEvidenceHeader: findHeader,
        recordDvdTitleIdentityObservations: record,
      },
    } as unknown as Pick<DataAccess, "catalog">;

    await expect(observeDvdTitleIdentitiesAtCheckpoint({
      access,
      archiveImageOwnership: imageOwnership.archiveImageOwnership,
      originalDiscArchiveId: archive.id,
      originalsLibraryPath: "/media/originals",
      signal: new AbortController().signal,
      observe: async () => [observation],
    })).rejects.toMatchObject({
      code: "DVD_EVIDENCE_CHANGED_DURING_READ",
    } satisfies Partial<DvdCheckpointReadFault>);
    expect(record).not.toHaveBeenCalled();
  });
});
