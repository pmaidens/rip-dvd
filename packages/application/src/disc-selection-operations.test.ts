import {
  DomainInvariantError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import {
  discSelectionCommandRequiresPreview,
  type CatalogReviewCommand,
} from "./catalog-review-command.js";
import { executeDiscSelectionCommand } from "./disc-selection-operations.js";
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
});
