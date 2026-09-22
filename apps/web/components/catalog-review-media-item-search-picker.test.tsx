// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogReviewMediaItemSearchPicker } from "./catalog-review-media-item-search-picker";

describe("CatalogReviewMediaItemSearchPicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("locks every search control while a catalog mutation is saving", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      results: [{
        mediaItem: {
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Synthetic Movie",
          year: 2026,
          seasonNumber: null,
          episodeNumber: null,
        },
        ancestors: [],
        suggestion: "exact",
        maintenance: {
          childCount: 0,
          discSelectionReferenceCount: 0,
          referencedArchiveCount: 0,
          otherArchiveCount: 0,
          deletionAvailability: { state: "available", reason: null },
        },
      }],
      page: {
        offset: 20,
        limit: 20,
        hasPrevious: true,
        hasNext: true,
      },
    })));
    const renderPicker = (isSaving: boolean) => root.render(
      <CatalogReviewMediaItemSearchPicker
        initialQuery="Synthetic Movie"
        selectedMediaItemId="movie-1"
        isSaving={isSaving}
        onSelect={() => undefined}
      />,
    );

    await act(async () => renderPicker(false));
    const search = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Search full catalog",
    );
    if (!search) throw new Error("Expected Media Item search button");
    await act(async () => search.click());

    await act(async () => renderPicker(true));

    const controls = container.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input, button");
    expect(controls).toHaveLength(5);
    expect([...controls].every((control) => control.disabled)).toBe(true);
  });
});
