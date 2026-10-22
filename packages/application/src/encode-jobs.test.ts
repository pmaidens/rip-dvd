import { describe, expect, it } from "vitest";
import {
  createDiscSelectionSourceIdentity,
  type ArchiveRecovery,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryClaimToken,
  type ArchiveRecoveryId,
  type ConsistentReadAccess,
  type DataAccess,
  type DiscSelection,
  type DiscSelectionId,
  type MediaItem,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { readQueueOptions } from "./encode-jobs.js";

describe("readQueueOptions", () => {
  it("reports recovery ownership as an unavailable Encode action without fencing fields", () => {
    const timestamp = new Date(1);
    const archiveId = "synthetic-archive" as OriginalDiscArchiveId;
    const recoveryId = "synthetic-recovery" as ArchiveRecoveryId;
    const attemptId = "synthetic-attempt" as ArchiveRecoveryAttemptId;
    const selection: DiscSelection = {
      id: "synthetic-selection" as DiscSelectionId,
      originalDiscArchiveId: archiveId,
      mediaItemId: "synthetic-media" as MediaItemId,
      sourceIdentity: createDiscSelectionSourceIdentity({
        kind: "dvd_title",
        titleNumber: 1,
      }),
      label: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const mediaItem: MediaItem = {
      id: selection.mediaItemId,
      parentId: null,
      kind: "movie",
      title: "Synthetic Movie",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const recovery: ArchiveRecovery = {
      id: recoveryId,
      originalDiscArchiveId: archiveId,
      attemptId,
      attemptOrdinal: 1,
      status: "eligible",
      stopOperationId: null,
      stopRequestedAt: null,
      stoppedAt: null,
      faultCode: null,
      work: {
        archiveRecoveryId: recoveryId,
        originalDiscArchiveId: archiveId,
        attemptId,
        status: "claimed",
        verificationId: null,
        requestedAt: null,
        claimedBy: "private-worker",
        claimToken: "private-token" as ArchiveRecoveryClaimToken,
        claimedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const snapshot = {
      catalog: {
        findArchiveRecovery: () => recovery,
        listDiscSelections: () => [selection],
        listMediaItems: () => [mediaItem],
        listMediaItemMaintenance: () => [{
          mediaItemId: mediaItem.id,
          childCount: 0,
          discSelectionReferenceCount: 1,
          referencedArchiveCount: 1,
          otherArchiveCount: 0,
          deletionAvailability: {
            state: "unavailable" as const,
            reason: "Referenced by a Disc Selection.",
          },
        }],
      },
      encodingProfiles: { list: () => [] },
      encodeJobs: {
        listQueueDiscSelections: () => ({
          selections: [{
            selection,
            hasCompletedEncode: false,
            priorCompletedJob: null,
            priorCompletedProfile: null,
            logicalJob: null,
          }],
          counts: { notEncoded: 1, reEncode: 0 },
          total: 1,
        }),
        listForDiscSelection: () => [],
        hasReservedOutputPath: () => false,
      },
    } as unknown as ConsistentReadAccess;
    const access = {
      readConsistentSnapshot: <Result>(
        read: (value: ConsistentReadAccess) => Result,
      ) => read(snapshot),
    } as DataAccess;

    const result = readQueueOptions(
      access,
      0,
      0,
      "/media",
      "not_encoded",
    );

    expect(result.selections[0]).toMatchObject({
      currentWork: {
        archiveRecovery: {
          id: recoveryId,
          originalDiscArchiveId: archiveId,
          work: { status: "claimed" },
        },
        encodeJobs: [],
      },
      queueAction: {
        name: "enqueue",
        eligible: false,
        blockingReasons: [{
          code: "ENCODE_WORK_CONFLICT",
          current: {
            archiveRecovery: {
              id: recoveryId,
              work: { status: "claimed" },
            },
          },
        }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-worker");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});
