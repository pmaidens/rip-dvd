import { createHash } from "node:crypto";

import {
  DomainInvariantError,
  StaleCatalogRevisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import {
  discSelectionCommandRequiresPreview,
  type CatalogReviewCommand,
} from "./catalog-review-command.js";
import {
  executeDiscSelectionCommand,
  previewDiscSelectionChange,
} from "./disc-selection-operations.js";
import { CatalogReviewRevisionStaleError } from "./catalog-review-workflow.js";
import { InvalidMutationKeyError } from "./mutation-key.js";

const archiveId = "archive-1" as OriginalDiscArchiveId;
const selection = {
  mediaItemId: "media-item-1",
  sourceIdentity: { kind: "dvd_title", titleNumber: 1 } as const,
};
const consequentialCommands = [
  {
    action: "update_disc_selection",
    discSelectionId: "selection-1",
    changes: { mediaItemId: "media-item-2" },
  },
  {
    action: "update_disc_selection",
    discSelectionId: "selection-1",
    changes: { sourceIdentity: { kind: "dvd_title", titleNumber: 2 } },
  },
  {
    action: "repair_disc_selection",
    discSelectionId: "selection-1",
    selection,
  },
  {
    action: "correct_disc_selection",
    discSelectionId: "selection-1",
    catalogRevision: "2026-01-01T00:00:00.000Z",
    selection,
  },
  {
    action: "delete_disc_selection",
    discSelectionId: "selection-1",
  },
] satisfies CatalogReviewCommand[];

describe("Disc Selection preview policy", () => {
  it("classifies every mutation whose consequences require acknowledgement", () => {
    for (const command of consequentialCommands) {
      expect(discSelectionCommandRequiresPreview(command)).toBe(true);
    }
    expect(discSelectionCommandRequiresPreview({
      action: "update_disc_selection",
      discSelectionId: "selection-1",
      changes: { label: "Main feature" },
    })).toBe(false);
    expect(discSelectionCommandRequiresPreview({
      action: "create_disc_selection",
      selection,
    })).toBe(false);
  });

  it("rejects consequential mutations before data access without complete acknowledgement", () => {
    const mutateDiscSelection = vi.fn();
    const access = { catalog: { mutateDiscSelection } } as unknown as DataAccess;
    const incompleteOptions = [
      { mutationKey: "00000000-0000-4000-8000-000000000001" },
      {
        mutationKey: "00000000-0000-4000-8000-000000000001",
        acknowledged: true as const,
        expectedCatalogRevision: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        mutationKey: "00000000-0000-4000-8000-000000000001",
        expectedCatalogRevision: new Date("2026-01-01T00:00:00.000Z"),
        previewToken: "invalid-token",
      },
    ];

    for (const command of consequentialCommands) {
      for (const options of incompleteOptions) {
        expect(() => executeDiscSelectionCommand(access, archiveId, command, options))
          .toThrowError(new DomainInvariantError(
            "Disc Selection preview acknowledgement is required",
          ));
      }
    }
    expect(mutateDiscSelection).not.toHaveBeenCalled();
  });

  it("requires a valid mutation key for every Disc Selection mutation", () => {
    const mutateDiscSelection = vi.fn();
    const access = { catalog: { mutateDiscSelection } } as unknown as DataAccess;
    const commands = [
      {
        action: "create_disc_selection",
        selection,
      },
      {
        action: "update_disc_selection",
        discSelectionId: "selection-1",
        changes: { label: "Main feature" },
      },
      ...consequentialCommands,
    ] satisfies CatalogReviewCommand[];

    for (const command of commands) {
      expect(() => executeDiscSelectionCommand(access, archiveId, command))
        .toThrowError(InvalidMutationKeyError);
    }
    expect(mutateDiscSelection).not.toHaveBeenCalled();
  });

  it("rejects a recomputed checksum token for a changed proposal", () => {
    const mutateDiscSelection = vi.fn();
    const access = { catalog: { mutateDiscSelection } } as unknown as DataAccess;
    const payload = JSON.stringify({
      archiveId,
      mutation: { action: "delete", discSelectionId: "selection-2" },
      evidenceHash: "a".repeat(64),
    });
    const forgedToken = `${Buffer.from(payload).toString("base64url")}.${
      createHash("sha256").update(payload).digest("hex")
    }`;

    expect(() => executeDiscSelectionCommand(access, archiveId, {
      action: "delete_disc_selection",
      discSelectionId: "selection-1",
    }, {
      mutationKey: "00000000-0000-4000-8000-000000000001",
      acknowledged: true,
      expectedCatalogRevision: new Date("2026-01-01T00:00:00.000Z"),
      previewToken: forgedToken,
    })).toThrowError(new DomainInvariantError(
      "Disc Selection preview does not match the proposed change",
    ));
    expect(mutateDiscSelection).not.toHaveBeenCalled();
  });

  it("preserves a legacy revision race during preview", () => {
    const previewRevision = "2026-01-01T00:00:00.000Z";
    const currentRevision = new Date("2026-01-01T00:00:01.000Z");
    const access = {
      catalog: {
        previewDiscSelectionMutation: () => ({
          catalogRevision: previewRevision,
          discSelection: {
            id: "selection-1",
            originalDiscArchiveId: archiveId,
            mediaItemId: "media-item-1",
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: null,
          },
          actionAvailability: {
            state: "editable",
            availableActions: ["update", "remove"],
            reason: null,
            relatedEncodeJob: null,
          },
          affectedEncodeJobs: [],
          outputReservationReleaseJobs: [],
          historicalEncodeJobCount: 0,
          evidenceHash: "a".repeat(64),
        }),
        previewDiscSelectionChange: () => {
          throw new StaleCatalogRevisionError(
            "Catalog review revision is stale",
          );
        },
        findDvdArchiveEvidenceHeader: () => null,
        listOriginalDiscArchives: () => [{ updatedAt: currentRevision }],
      },
      archiveJobs: { listForArchive: () => [] },
      readConsistentSnapshot(read: (snapshot: unknown) => unknown) {
        return read(this);
      },
    } as unknown as DataAccess;

    expect(() => previewDiscSelectionChange(access, archiveId, {
      action: "delete_disc_selection",
      discSelectionId: "selection-1",
    })).toThrowError(StaleCatalogRevisionError);
    try {
      previewDiscSelectionChange(access, archiveId, {
        action: "delete_disc_selection",
        discSelectionId: "selection-1",
      });
    } catch (error) {
      expect(error).toMatchObject({
        name: "StaleCatalogRevisionError",
        message: "Catalog review revision is stale",
      });
    }
  });

  it("returns structured stale evidence for a correction preview from an older checkpoint", () => {
    const reviewedRevision = "2026-01-01T00:00:00.000Z";
    const currentRevision = "2026-01-01T00:00:01.000Z";
    const access = {
      catalog: {
        previewDiscSelectionMutation: () => ({
          catalogRevision: currentRevision,
          discSelection: {
            id: "selection-1",
            originalDiscArchiveId: archiveId,
            mediaItemId: "media-item-1",
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: null,
          },
          actionAvailability: {
            state: "locked_provenance",
            availableActions: ["correct"],
            reason: null,
            relatedEncodeJob: null,
          },
          affectedEncodeJobs: [],
          outputReservationReleaseJobs: [],
          historicalEncodeJobCount: 1,
          evidenceHash: "a".repeat(64),
        }),
        findDvdArchiveEvidenceHeader: () => ({
          sourceArchiveJobId: "archive-job-1",
          evidenceFormat: "dvd-recovery-evidence-v1",
          currentManifestRevision: 2,
          currentManifestDigest: "b".repeat(64),
        }),
        findArchiveRecovery: () => ({
          id: "recovery-1",
          attemptId: "attempt-1",
          status: "running",
          work: null,
        }),
        readDvdTitleIdentityReviewSet: () => null,
      },
      archiveJobs: {
        listForArchive: () => [{
          id: "archive-job-1",
          evidenceFormat: "dvd-recovery-evidence-v1",
          status: "completed",
        }],
      },
      dvdTitleDamageAssessments: {
        inspect: () => ({
          state: "unavailable",
          currentAssessmentIdentity: null,
          assessment: null,
        }),
      },
    } as unknown as DataAccess;

    expect(() => previewDiscSelectionChange(access, archiveId, {
      action: "correct_disc_selection",
      discSelectionId: "selection-1",
      catalogRevision: reviewedRevision,
      selection,
    })).toThrowError(CatalogReviewRevisionStaleError);
    try {
      previewDiscSelectionChange(access, archiveId, {
        action: "correct_disc_selection",
        discSelectionId: "selection-1",
        catalogRevision: reviewedRevision,
        selection,
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "STALE_CATALOG_REVISION",
        current: {
          checkpoint: { revision: 2 },
          catalogMappingProjectionId: null,
        },
        blockingReasons: [{
          code: "STALE_CATALOG_REVISION",
          details: {
            expectedCatalogRevision: reviewedRevision,
            currentCatalogRevision: currentRevision,
          },
        }],
      });
    }
  });
});
