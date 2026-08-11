import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewMediaItems } from "./catalog-review-media-items";

describe("CatalogReviewMediaItems", () => {
  it("keeps hierarchy context while limiting editing to the current page", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewMediaItems
        mediaItems={[
          {
            id: "show-1",
            parentId: null,
            kind: "tv_show",
            title: "Parent Show",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "episode-1",
            parentId: "show-1",
            kind: "episode",
            title: "Current Episode",
            year: null,
            seasonNumber: null,
            episodeNumber: 1,
          },
        ]}
        page={{
          offset: 100,
          limit: 100,
          hasPrevious: true,
          hasNext: false,
          itemIds: ["episode-1"],
        }}
        editingMediaItemId="episode-1"
        isSaving={false}
        onEdit={() => undefined}
        onCancelEdit={() => undefined}
        onPage={() => undefined}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain("Parent context");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(1);
    expect(html).toContain('value="show-1" selected="">Parent Show');
    expect(html).toContain("Previous Media Items");
    expect(html).toContain("Edit Current Episode");
  });
});
