import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewMediaItems } from "./catalog-review-media-items";
import { CatalogReviewMediaItemMaintenanceResult } from "./catalog-review-media-items";

describe("CatalogReviewMediaItems", () => {
  it("keeps mapped hierarchy and ancestor context editable", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewMediaItems
        archiveId="archive-1"
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
            maintenance: {
              childCount: 0,
              discSelectionReferenceCount: 1,
              referencedArchiveCount: 3,
              otherArchiveCount: 2,
              deletionAvailability: {
                state: "unavailable",
                reason: "1 Disc Selection reference",
              },
            },
          },
        ]}
        mappedMediaItemIds={["episode-1"]}
        editingMediaItemId="episode-1"
        isSaving={false}
        onEdit={() => undefined}
        onCancelEdit={() => undefined}
        onSave={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Parent context");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(html).toContain('value="show-1" selected="">Parent Show');
    expect(html).not.toContain("Previous Media Items");
    expect(html).toContain("Edit Current Episode");
    expect(html).toContain("Changes affect 2 other archives");
    expect(html).toContain(
      "Deletion unavailable: 1 Disc Selection reference",
    );
    expect(html).toMatch(/disabled=""[^>]*>Delete Media Item/);
  });

  it("presents unused bounded-search results for maintenance", () => {
    const html = renderToStaticMarkup(
      <ul>
        <CatalogReviewMediaItemMaintenanceResult
          result={{
            mediaItem: {
              id: "unused-1",
              parentId: null,
              kind: "movie",
              title: "Unused Movie",
              year: null,
              seasonNumber: null,
              episodeNumber: null,
            },
            ancestors: [],
            suggestion: null,
            maintenance: {
              childCount: 0,
              discSelectionReferenceCount: 0,
              referencedArchiveCount: 0,
              otherArchiveCount: 0,
              deletionAvailability: { state: "available", reason: null },
            },
          }}
          isSaving={false}
          onEdit={() => undefined}
          onDelete={() => undefined}
        />
      </ul>,
    );

    expect(html).toContain("Unused Movie");
    expect(html).toContain("Unused Media Item");
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Delete Media Item</button>");
  });
});
