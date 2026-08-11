import React from "react";

import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";
import { DISC_SELECTION_KINDS } from "@rip-dvd/data-access/catalog-kinds";

import { integerFormValue } from "./catalog-review-form";
import { orderMediaItemHierarchy } from "./catalog-review-hierarchy";
import {
  type CatalogReviewDiscSelection,
  type CatalogReviewDto,
  type CatalogReviewMediaItem,
  type CreateDiscSelectionInput,
  type DiscSelectionKind,
} from "./catalog-review-model";
import { CatalogReviewPagination } from "./catalog-review-pagination";

interface CatalogReviewDiscSelectionsProps {
  discSelections: CatalogReviewDiscSelection[];
  page: CatalogReviewDto["discSelectionsPage"];
  mediaItems: CatalogReviewMediaItem[];
  rawTitles: DvdTitle[];
  selectionKind: DiscSelectionKind;
  isSaving: boolean;
  onPage(offset: number): void;
  onSelectionKindChange(kind: DiscSelectionKind): void;
  onCreate(input: CreateDiscSelectionInput): void;
  onDelete(id: string): void;
}

const discSelectionLabels = {
  main_feature: "DVD main feature",
  dvd_title: "DVD title",
  dvd_chapters: "DVD chapter range",
} satisfies Record<DiscSelectionKind, string>;

function discSelectionDescription(
  selection: CatalogReviewDiscSelection,
): string {
  const sourceIdentity = selection.sourceIdentity;
  if (sourceIdentity.kind === "main_feature") {
    return "DVD main feature";
  }
  if (sourceIdentity.kind === "dvd_title") {
    return `Title ${sourceIdentity.titleNumber}`;
  }
  return `Title ${sourceIdentity.titleNumber}, chapters ${sourceIdentity.chapterStart}–${sourceIdentity.chapterEnd}`;
}

export function CatalogReviewDiscSelections({
  discSelections,
  page,
  mediaItems,
  rawTitles,
  selectionKind,
  isSaving,
  onPage,
  onSelectionKindChange,
  onCreate,
  onDelete,
}: CatalogReviewDiscSelectionsProps) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const itemsById = new Map(mediaItems.map((item) => [item.id, item]));

  function createSelection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const replacesDiscSelectionId = String(
      form.get("replacesDiscSelectionId") ?? "",
    ).trim();
    const common = {
      ...(replacesDiscSelectionId ? { replacesDiscSelectionId } : {}),
      mediaItemId: String(form.get("mediaItemId")),
      ...(label ? { label } : {}),
    };
    if (selectionKind === "main_feature") {
      onCreate({
        ...common,
        sourceIdentity: { kind: selectionKind },
      });
      return;
    }
    const titleNumber = integerFormValue(form, "titleNumber");
    if (titleNumber === undefined) {
      return;
    }
    if (selectionKind === "dvd_title") {
      onCreate({
        ...common,
        sourceIdentity: { kind: selectionKind, titleNumber },
      });
      return;
    }
    const chapterStart = integerFormValue(form, "chapterStart");
    const chapterEnd = integerFormValue(form, "chapterEnd");
    if (chapterStart === undefined || chapterEnd === undefined) {
      return;
    }
    onCreate({
      ...common,
      sourceIdentity: {
        kind: selectionKind,
        titleNumber,
        chapterStart,
        chapterEnd,
      },
    });
  }

  return (
    <>
      <h3 id="reviewed-selections">Reviewed Disc Selections</h3>
      {discSelections.length === 0 ? (
        <p className="catalog-empty">No reviewed selections exist yet.</p>
      ) : (
        <ul className="selection-list">
          {discSelections.map((selection) => (
            <li key={selection.id}>
              <strong>
                {itemsById.get(selection.mediaItemId)?.title ??
                  "Unknown Media Item"}
              </strong>
              <span>{discSelectionDescription(selection)}</span>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => onDelete(selection.id)}
              >
                Remove Disc Selection
              </button>
            </li>
          ))}
        </ul>
      )}

      <CatalogReviewPagination
        ariaLabel="Disc Selection pages"
        itemLabel="Disc Selections"
        page={page}
        isSaving={isSaving}
        onPage={onPage}
      />

      <form className="catalog-form" onSubmit={createSelection}>
        <h3>Add Disc Selection</h3>
        <div className="catalog-fields">
          <label>
            Catalog action
            <select name="replacesDiscSelectionId" defaultValue="">
              <option value="">Add a new Disc Selection</option>
              {discSelections.map((selection) => (
                <option key={selection.id} value={selection.id}>
                  Repair an existing Disc Selection: {
                    discSelectionDescription(selection)
                  }
                </option>
              ))}
            </select>
          </label>
          <label>
            Media Item
            <select name="mediaItemId" required defaultValue="">
              <option value="" disabled>Select a Media Item</option>
              {hierarchy.map(({ item, depth }) => (
                <option key={item.id} value={item.id}>
                  {`${"— ".repeat(depth)}${item.title}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source
            <select
              name="selectionKind"
              value={selectionKind}
              onChange={(event) =>
                onSelectionKindChange(
                  event.currentTarget.value as DiscSelectionKind,
                )}
            >
              {DISC_SELECTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {discSelectionLabels[kind]}
                </option>
              ))}
            </select>
          </label>
          {selectionKind !== "main_feature" ? (
            <label>
              DVD title
              <select name="titleNumber" required defaultValue="">
                <option value="" disabled>Select a title</option>
                {rawTitles.map((title) => (
                  <option key={title.number} value={title.number}>
                    Title {title.number} ({title.chapters} chapters)
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectionKind === "dvd_chapters" ? (
            <>
              <label>
                First chapter
                <input name="chapterStart" type="number" min="1" required />
              </label>
              <label>
                Last chapter
                <input name="chapterEnd" type="number" min="1" required />
              </label>
            </>
          ) : null}
          <label>
            Label
            <input name="label" maxLength={256} placeholder="Optional" />
          </label>
        </div>
        <button
          type="submit"
          disabled={isSaving || mediaItems.length === 0}
        >
          Add Disc Selection
        </button>
      </form>
    </>
  );
}
