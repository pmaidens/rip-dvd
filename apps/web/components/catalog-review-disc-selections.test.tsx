import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";

describe("CatalogReviewDiscSelections", () => {
  it("renders reviewed mappings, repair choices, and pagination", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "episode-1",
          sourceKey: "dvd:title:1:chapters:1-4",
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
          label: null,
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: true,
        }}
        mediaItems={[{
          id: "episode-1",
          parentId: null,
          kind: "episode",
          title: "Episode One",
          year: null,
          seasonNumber: null,
          episodeNumber: 1,
        }]}
        rawTitles={[{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Episode One");
    expect(html).toContain("Title 1, chapters 1–4");
    expect(html).toContain("Repair an existing Disc Selection");
    expect(html).toContain("Remove Disc Selection");
    expect(html).toContain("Next Disc Selections");
  });
});
