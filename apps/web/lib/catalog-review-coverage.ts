import type {
  DiscSelectionSourceIdentityInput,
} from "@rip-dvd/data-access";
import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";

export type CatalogReviewTitleCoverageStatus =
  | "mapped"
  | "partially_mapped"
  | "unmapped";

export interface CatalogReviewTitleCoverage {
  titleNumber: number;
  status: CatalogReviewTitleCoverageStatus;
  hasOverlap: boolean;
}

export interface CatalogReviewCoverage {
  discSelectionCount: number;
  mediaItemsWithSelections: number;
  mappedTitles: number;
  partiallyMappedTitles: number;
  unmappedTitles: number;
  mainFeatureSelections: number;
  titles: CatalogReviewTitleCoverage[];
}

interface CoverageDiscSelection {
  mediaItemId: string;
  sourceIdentity: DiscSelectionSourceIdentityInput;
}

interface ChapterInterval {
  start: number;
  end: number;
}

function titleIntervals(
  title: DvdTitle,
  selections: readonly CoverageDiscSelection[],
): { intervals: ChapterInterval[]; hasWholeTitle: boolean } {
  const intervals: ChapterInterval[] = [];
  let hasWholeTitle = false;
  for (const selection of selections) {
    const source = selection.sourceIdentity;
    if (source.kind === "main_feature" || source.titleNumber !== title.number) {
      continue;
    }
    if (source.kind === "dvd_title") {
      hasWholeTitle = true;
      if (title.chapters > 0) {
        intervals.push({ start: 1, end: title.chapters });
      }
      continue;
    }
    const start = Math.max(1, source.chapterStart);
    const end = Math.min(title.chapters, source.chapterEnd);
    if (start <= end) {
      intervals.push({ start, end });
    }
  }
  return { intervals, hasWholeTitle };
}

function intervalCoverage(intervals: readonly ChapterInterval[]): {
  coveredChapters: number;
  hasOverlap: boolean;
} {
  const ordered = [...intervals].sort((left, right) =>
    left.start - right.start || left.end - right.end
  );
  let coveredChapters = 0;
  let hasOverlap = false;
  let unionStart: number | null = null;
  let unionEnd: number | null = null;
  for (const interval of ordered) {
    if (unionStart === null || unionEnd === null) {
      unionStart = interval.start;
      unionEnd = interval.end;
      continue;
    }
    if (interval.start <= unionEnd) {
      hasOverlap = true;
      unionEnd = Math.max(unionEnd, interval.end);
      continue;
    }
    coveredChapters += unionEnd - unionStart + 1;
    unionStart = interval.start;
    unionEnd = interval.end;
  }
  if (unionStart !== null && unionEnd !== null) {
    coveredChapters += unionEnd - unionStart + 1;
  }
  return { coveredChapters, hasOverlap };
}

export function calculateCatalogReviewCoverage(
  titles: readonly DvdTitle[],
  selections: readonly CoverageDiscSelection[],
): CatalogReviewCoverage {
  const mediaItemIds = new Set<string>();
  const selectionsByTitle = new Map<number, CoverageDiscSelection[]>();
  let mainFeatureSelections = 0;
  for (const selection of selections) {
    mediaItemIds.add(selection.mediaItemId);
    const source = selection.sourceIdentity;
    if (source.kind === "main_feature") {
      mainFeatureSelections += 1;
      continue;
    }
    const titleSelections = selectionsByTitle.get(source.titleNumber) ?? [];
    titleSelections.push(selection);
    selectionsByTitle.set(source.titleNumber, titleSelections);
  }
  const titleCoverage = titles.map((title): CatalogReviewTitleCoverage => {
    const { intervals, hasWholeTitle } = titleIntervals(
      title,
      selectionsByTitle.get(title.number) ?? [],
    );
    const { coveredChapters, hasOverlap } = intervalCoverage(intervals);
    const status: CatalogReviewTitleCoverageStatus = hasWholeTitle ||
        (title.chapters > 0 && coveredChapters >= title.chapters)
      ? "mapped"
      : coveredChapters > 0
      ? "partially_mapped"
      : "unmapped";
    return {
      titleNumber: title.number,
      status,
      hasOverlap,
    };
  });

  return {
    discSelectionCount: selections.length,
    mediaItemsWithSelections: mediaItemIds.size,
    mappedTitles: titleCoverage.filter(({ status }) => status === "mapped")
      .length,
    partiallyMappedTitles: titleCoverage.filter(
      ({ status }) => status === "partially_mapped",
    ).length,
    unmappedTitles: titleCoverage.filter(({ status }) => status === "unmapped")
      .length,
    mainFeatureSelections,
    titles: titleCoverage,
  };
}
