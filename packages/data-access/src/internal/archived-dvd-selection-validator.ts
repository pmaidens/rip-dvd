import { decodeArchivedDvdTitles } from "../dvd-scan.js";
import { DomainInvariantError } from "../errors.js";
import { requirePositiveSafeInteger } from "./validation.js";

type ArchivedDvdSelectionInput = (
  | {
      kind: "main_feature";
      titleNumber?: null;
      chapterStart?: null;
      chapterEnd?: null;
    }
  | {
      kind: "dvd_title";
      titleNumber: number;
      chapterStart?: null;
      chapterEnd?: null;
    }
  | {
      kind: "dvd_chapters";
      titleNumber: number;
      chapterStart: number;
      chapterEnd: number;
    }
);

export function createArchivedDvdSelectionValidator(scanData: unknown) {
  const archivedTitles = decodeArchivedDvdTitles(scanData);
  const archivedTitlesByNumber = archivedTitles === null
    ? null
    : new Map(archivedTitles.map((title) => [title.number, title]));

  return {
    validate(
      selection: ArchivedDvdSelectionInput,
      { persistedSourceKey }: { persistedSourceKey?: string } = {},
    ) {
      const coordinates =
        selection.kind === "main_feature"
          ? {
              titleNumber: null,
              chapterStart: null,
              chapterEnd: null,
            }
          : selection.kind === "dvd_title"
            ? {
                titleNumber: requirePositiveSafeInteger(
                  selection.titleNumber,
                  "titleNumber",
                ),
                chapterStart: null,
                chapterEnd: null,
              }
            : {
                titleNumber: requirePositiveSafeInteger(
                  selection.titleNumber,
                  "titleNumber",
                ),
                chapterStart: requirePositiveSafeInteger(
                  selection.chapterStart,
                  "chapterStart",
                ),
                chapterEnd: requirePositiveSafeInteger(
                  selection.chapterEnd,
                  "chapterEnd",
                ),
              };
      if (
        coordinates.chapterStart !== null &&
        coordinates.chapterEnd !== null &&
        coordinates.chapterEnd < coordinates.chapterStart
      ) {
        throw new DomainInvariantError(
          "chapterEnd must be greater than or equal to chapterStart",
        );
      }
      const sourceKey = selection.kind === "main_feature"
        ? "dvd:main-feature"
        : selection.kind === "dvd_title"
          ? `dvd:title:${coordinates.titleNumber}`
          : `dvd:title:${coordinates.titleNumber}:chapters:${coordinates.chapterStart}-${coordinates.chapterEnd}`;
      if (
        persistedSourceKey !== undefined &&
        persistedSourceKey !== sourceKey
      ) {
        throw new DomainInvariantError(
          "Catalog review requires canonical Disc Selection source keys",
        );
      }
      if (coordinates.titleNumber === null) {
        return { coordinates, sourceKey };
      }
      if (!archivedTitlesByNumber) {
        throw new DomainInvariantError(
          "DVD title selections require a reviewable DVD title map",
        );
      }
      const title = archivedTitlesByNumber.get(coordinates.titleNumber);
      if (!title) {
        throw new DomainInvariantError(
          `DVD title ${coordinates.titleNumber} is not present in the archived scan`,
        );
      }
      if (
        coordinates.chapterEnd !== null &&
        coordinates.chapterEnd > title.chapters
      ) {
        throw new DomainInvariantError(
          `chapterEnd must not exceed DVD title ${title.number}'s ${title.chapters} chapters`,
        );
      }
      return { coordinates, sourceKey };
    },
  };
}
