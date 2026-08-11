import {
  createDiscSelectionSourceIdentity,
  serializeDiscSelectionSourceIdentity,
  type DiscSelectionSourceIdentity,
  type DiscSelectionSourceIdentityInput,
} from "../disc-selection-source-identity.js";
import { decodeArchivedDvdTitles } from "../dvd-scan.js";
import { DomainInvariantError } from "../errors.js";

export function createArchivedDvdSelectionValidator(scanData: unknown): {
  validate(
    sourceIdentityInput: DiscSelectionSourceIdentityInput,
    options?: { persistedSourceKey?: string },
  ): DiscSelectionSourceIdentity;
} {
  const archivedTitles = decodeArchivedDvdTitles(scanData);
  const archivedTitlesByNumber = archivedTitles === null
    ? null
    : new Map(archivedTitles.map((title) => [title.number, title]));

  return {
    validate(
      sourceIdentityInput: DiscSelectionSourceIdentityInput,
      { persistedSourceKey }: { persistedSourceKey?: string } = {},
    ) {
      const sourceIdentity = createDiscSelectionSourceIdentity(
        sourceIdentityInput,
      );
      const sourceKey =
        serializeDiscSelectionSourceIdentity(sourceIdentity).sourceKey;
      if (
        persistedSourceKey !== undefined &&
        persistedSourceKey !== sourceKey
      ) {
        throw new DomainInvariantError(
          "Catalog review requires canonical Disc Selection source keys",
        );
      }
      if (sourceIdentity.kind === "main_feature") {
        return sourceIdentity;
      }
      if (!archivedTitlesByNumber) {
        throw new DomainInvariantError(
          "DVD title selections require a reviewable DVD title map",
        );
      }
      const title = archivedTitlesByNumber.get(sourceIdentity.titleNumber);
      if (!title) {
        throw new DomainInvariantError(
          `DVD title ${sourceIdentity.titleNumber} is not present in the archived scan`,
        );
      }
      if (
        sourceIdentity.kind === "dvd_chapters" &&
        sourceIdentity.chapterEnd > title.chapters
      ) {
        throw new DomainInvariantError(
          `chapterEnd must not exceed DVD title ${title.number}'s ${title.chapters} chapters`,
        );
      }
      return sourceIdentity;
    },
  };
}
