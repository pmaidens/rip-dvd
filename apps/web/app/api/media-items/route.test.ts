import { describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createMediaItemSearchRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

describe("Media Item search API", () => {
  it("searches the full catalog in bounded pages with ancestor context", async () => {
    const access = dataAccessFixture.create();
    for (let index = 0; index < 25; index += 1) {
      access.catalog.createMediaItem({
        kind: "movie",
        title: `Unused Search Result ${String(index).padStart(2, "0")}`,
      });
    }
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Searchable Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Season 2",
      seasonNumber: 2,
    });
    access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Existing Episode",
      episodeNumber: 4,
    });

    const firstResponse = await createMediaItemSearchRoute(
      new Request("http://localhost:3000/api/media-items?query=Unused&offset=0"),
      () => access,
    );
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    const firstPage = await firstResponse.json();
    expect(firstPage.results).toHaveLength(20);
    expect(firstPage.page).toEqual({
      offset: 0,
      limit: 20,
      hasPrevious: false,
      hasNext: true,
    });

    const lastResponse = await createMediaItemSearchRoute(
      new Request("http://localhost:3000/api/media-items?query=Unused&offset=20"),
      () => access,
    );
    const lastPage = await lastResponse.json();
    expect(lastPage.results).toHaveLength(5);
    expect(lastPage.page).toEqual({
      offset: 20,
      limit: 20,
      hasPrevious: true,
      hasNext: false,
    });

    const hierarchyResponse = await createMediaItemSearchRoute(
      new Request(
        "http://localhost:3000/api/media-items?query=Existing%20Episode",
      ),
      () => access,
    );
    const hierarchy = await hierarchyResponse.json();
    expect(hierarchy.results).toEqual([{
      mediaItem: expect.objectContaining({ title: "Existing Episode" }),
      ancestors: [
        expect.objectContaining({ title: "Searchable Show" }),
        expect.objectContaining({ title: "Season 2" }),
      ],
      suggestion: "exact",
    }]);
  });

  it("offers normalized matches as unselected suggestions", async () => {
    const access = dataAccessFixture.create();
    access.catalog.createMediaItem({ kind: "movie", title: "Alien_3" });

    const response = await createMediaItemSearchRoute(
      new Request("http://localhost:3000/api/media-items?query=Alien%203"),
      () => access,
    );
    const body = await response.json();

    expect(body.results).toEqual([{
      mediaItem: expect.objectContaining({ title: "Alien_3" }),
      ancestors: [],
      suggestion: "normalized",
    }]);
    expect(body).not.toHaveProperty("selectedMediaItemId");
  });

  it.each([
    "http://localhost:3000/api/media-items",
    "http://localhost:3000/api/media-items?query=%20%20",
    "http://localhost:3000/api/media-items?query=%25_%2B",
    `http://localhost:3000/api/media-items?query=${"x".repeat(257)}`,
    "http://localhost:3000/api/media-items?query=Movie&offset=-1",
    "http://localhost:3000/api/media-items?query=Movie&query=Other",
  ])("fails closed on malformed query input: %s", async (url) => {
    const getAccess = vi.fn();
    const response = await createMediaItemSearchRoute(
      new Request(url),
      getAccess,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getAccess).not.toHaveBeenCalled();
  });
});
