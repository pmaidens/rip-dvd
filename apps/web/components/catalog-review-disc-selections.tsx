import React, { useEffect, useState } from "react";

import type { DiscSelectionAction } from "@rip-dvd/data-access";
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
  type UpdateDiscSelectionInput,
} from "./catalog-review-model";
import { CatalogReviewPagination } from "./catalog-review-pagination";
import { displayTerm } from "../lib/display-term";

interface CatalogReviewDiscSelectionsProps {
  discSelections: CatalogReviewDiscSelection[];
  page: CatalogReviewDto["discSelectionsPage"];
  correctionHistory: CatalogReviewDto["correctionHistory"];
  correctionHistoryPage: CatalogReviewDto["correctionHistoryPage"];
  mediaItems: CatalogReviewMediaItem[];
  rawTitles: DvdTitle[];
  selectionKind: DiscSelectionKind;
  isSaving: boolean;
  onPage(offset: number): void;
  onCorrectionHistoryPage(offset: number): void;
  onSelectionKindChange(kind: DiscSelectionKind): void;
  onCreate(input: CreateDiscSelectionInput): void;
  onUpdate(id: string, changes: UpdateDiscSelectionInput): void;
  onDelete(id: string): void;
}

const discSelectionLabels = {
  main_feature: "DVD main feature",
  dvd_title: "DVD title",
  dvd_chapters: "DVD chapter range",
} satisfies Record<DiscSelectionKind, string>;

const actionStateLabels = {
  editable: "Editable",
  locked_provenance: "Locked provenance",
  correction_lineage: "Correction lineage",
  needs_repair: "Needs repair",
  changes_unavailable: "Changes unavailable",
} as const;

function hasAction(
  selection: CatalogReviewDiscSelection,
  action: DiscSelectionAction,
): boolean {
  const actions = selection.actionAvailability.availableActions as readonly
    DiscSelectionAction[];
  return actions.includes(action);
}

function discSelectionDescription(
  selection: Pick<CatalogReviewDiscSelection, "sourceIdentity">,
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

function sameSourceIdentity(
  left: CatalogReviewDiscSelection["sourceIdentity"],
  right: CatalogReviewDiscSelection["sourceIdentity"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "main_feature" && right.kind === "main_feature") {
    return true;
  }
  if (left.kind === "dvd_title" && right.kind === "dvd_title") {
    return left.titleNumber === right.titleNumber;
  }
  return left.kind === "dvd_chapters" && right.kind === "dvd_chapters" &&
    left.titleNumber === right.titleNumber &&
    left.chapterStart === right.chapterStart &&
    left.chapterEnd === right.chapterEnd;
}

export function CatalogReviewDiscSelections({
  discSelections,
  page,
  correctionHistory,
  correctionHistoryPage,
  mediaItems,
  rawTitles,
  selectionKind,
  isSaving,
  onPage,
  onCorrectionHistoryPage,
  onSelectionKindChange,
  onCreate,
  onUpdate,
  onDelete,
}: CatalogReviewDiscSelectionsProps) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const itemsById = new Map(mediaItems.map((item) => [item.id, item]));
  const [editingSelectionId, setEditingSelectionId] = useState<string | null>(
    null,
  );
  const [mediaItemId, setMediaItemId] = useState("");
  const [titleNumber, setTitleNumber] = useState("");
  const [chapterStart, setChapterStart] = useState("");
  const [chapterEnd, setChapterEnd] = useState("");
  const [label, setLabel] = useState("");
  const [clearLabel, setClearLabel] = useState(false);
  const editingSelection = editingSelectionId === null
    ? null
    : discSelections.find((selection) => selection.id === editingSelectionId) ??
      null;

  useEffect(() => {
    const selection = editingSelection;
    if (selection === null) return;
    setMediaItemId(selection.mediaItemId);
    setLabel(selection.label ?? "");
    setClearLabel(false);
    onSelectionKindChange(selection.sourceIdentity.kind);
    if (selection.sourceIdentity.kind === "main_feature") {
      setTitleNumber("");
      setChapterStart("");
      setChapterEnd("");
      return;
    }
    setTitleNumber(String(selection.sourceIdentity.titleNumber));
    if (selection.sourceIdentity.kind === "dvd_chapters") {
      setChapterStart(String(selection.sourceIdentity.chapterStart));
      setChapterEnd(String(selection.sourceIdentity.chapterEnd));
    } else {
      setChapterStart("");
      setChapterEnd("");
    }
  }, [editingSelection, onSelectionKindChange]);

  function selectCatalogAction(event: React.ChangeEvent<HTMLSelectElement>) {
    const selection = discSelections.find(
      (candidate) => candidate.id === event.currentTarget.value,
    );
    if (selection?.actionAvailability.state !== "editable") {
      if (editingSelectionId !== null) {
        setMediaItemId("");
        setTitleNumber("");
        setChapterStart("");
        setChapterEnd("");
        setLabel("");
        onSelectionKindChange("main_feature");
      }
      setEditingSelectionId(null);
      setClearLabel(false);
      return;
    }
    setEditingSelectionId(selection.id);
  }

  function submitSelection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextLabel = String(form.get("label") ?? "").trim();
    const replacesDiscSelectionId = String(
      form.get("replacesDiscSelectionId") ?? "",
    ).trim();
    const correctionReason = String(
      form.get("correctionReason") ?? "",
    ).trim();
    const common = {
      ...(replacesDiscSelectionId ? { replacesDiscSelectionId } : {}),
      ...(correctionReason ? { correctionReason } : {}),
      mediaItemId: String(form.get("mediaItemId")),
      ...(nextLabel ? { label: nextLabel } : {}),
    };
    let sourceIdentity: CatalogReviewDiscSelection["sourceIdentity"];
    if (selectionKind === "main_feature") {
      sourceIdentity = { kind: selectionKind };
    } else {
      const selectedTitleNumber = integerFormValue(form, "titleNumber");
      if (selectedTitleNumber === undefined) return;
      if (selectionKind === "dvd_title") {
        sourceIdentity = {
          kind: selectionKind,
          titleNumber: selectedTitleNumber,
        };
      } else {
        const selectedChapterStart = integerFormValue(form, "chapterStart");
        const selectedChapterEnd = integerFormValue(form, "chapterEnd");
        if (
          selectedChapterStart === undefined || selectedChapterEnd === undefined
        ) return;
        sourceIdentity = {
          kind: selectionKind,
          titleNumber: selectedTitleNumber,
          chapterStart: selectedChapterStart,
          chapterEnd: selectedChapterEnd,
        };
      }
    }

    const target = discSelections.find(
      (selection) => selection.id === replacesDiscSelectionId,
    );
    if (target?.actionAvailability.state === "editable") {
      const changes: Partial<UpdateDiscSelectionInput> = {};
      if (common.mediaItemId !== target.mediaItemId) {
        changes.mediaItemId = common.mediaItemId;
      }
      if (!sameSourceIdentity(sourceIdentity, target.sourceIdentity)) {
        changes.sourceIdentity = sourceIdentity;
      }
      if (form.get("clearLabel") === "on") {
        changes.label = null;
      } else if (nextLabel === "" && target.label !== null) {
        return;
      } else if (nextLabel !== (target.label ?? "")) {
        changes.label = nextLabel;
      }
      if (Object.keys(changes).length > 0) {
        onUpdate(target.id, changes as UpdateDiscSelectionInput);
      }
      return;
    }

    onCreate({ ...common, sourceIdentity });
  }

  const hasSupersessionCorrection = discSelections.some(
    (selection) =>
      (selection.actionAvailability.state === "locked_provenance" ||
        selection.actionAvailability.state === "correction_lineage") &&
      hasAction(selection, "correct"),
  );

  return (
    <>
      <h3 id="reviewed-selections">Reviewed Disc Selections</h3>
      {discSelections.length === 0 ? (
        <p className="catalog-empty">No reviewed selections exist yet.</p>
      ) : (
        <ul className="selection-list">
          {discSelections.map((selection) => (
            <li key={selection.id}>
              <div>
                <strong>
                  {itemsById.get(selection.mediaItemId)?.title ??
                    "Unknown Media Item"}
                </strong>
                <span>{discSelectionDescription(selection)}</span>
                <span>Label: {selection.label ?? "None"}</span>
              </div>
              <div className="selection-action-state">
                <span className="attention-mark">
                  {actionStateLabels[selection.actionAvailability.state]}
                </span>
                <p>
                  {selection.actionAvailability.reason ??
                    "Direct editing and removal are available."}
                </p>
                {hasAction(selection, "remove") ? (
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => onDelete(selection.id)}
                  >
                    Remove Disc Selection
                  </button>
                ) : null}
              </div>
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

      {correctionHistory.length > 0 ? (
        <div className="selection-correction-history">
          <h4>Disc Selection Correction History</h4>
          <ol>
            {correctionHistory.map((correction) => (
              <li key={correction.supersededDiscSelection.id}>
                <p>
                  {itemsById.get(
                    correction.supersededDiscSelection.mediaItemId,
                  )?.title ?? "Unknown Media Item"} · {discSelectionDescription(
                    correction.supersededDiscSelection,
                  )} → {itemsById.get(
                    correction.replacementDiscSelection.mediaItemId,
                  )?.title ?? "Unknown Media Item"} · {discSelectionDescription(
                    correction.replacementDiscSelection,
                  )}
                </p>
                {correction.reason ? <p>{correction.reason}</p> : null}
                {correction.encodeHistory.length > 0 ? (
                  <ol className="selection-encode-history">
                    {correction.encodeHistory.map((job) => (
                      <li key={job.id}>
                        <p>
                          Encode Job {job.id} · {displayTerm(job.status)}
                        </p>
                        {job.replacementEncodeJobId ? (
                          <p>Superseded by {job.replacementEncodeJobId}</p>
                        ) : null}
                        {job.predecessorEncodeJobId ? (
                          <p>Replaces {job.predecessorEncodeJobId}</p>
                        ) : null}
                        {job.retainedOutput ? (
                          <p>
                            Prior output retained · {job.retainedOutput.cleanupEligible
                              ? "Cleanup eligible"
                              : "Cleanup unavailable"}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <CatalogReviewPagination
        ariaLabel="Disc Selection Correction History pages"
        itemLabel="Corrections"
        page={correctionHistoryPage}
        isSaving={isSaving}
        onPage={onCorrectionHistoryPage}
      />

      <form className="catalog-form" onSubmit={submitSelection}>
        <h3>{editingSelection ? "Edit Disc Selection" : "Add Disc Selection"}</h3>
        {hasSupersessionCorrection ? (
          <p>
            A job-backed Disc Selection Correction creates a new identity and
            preserves prior Encode Job provenance. Queued work is cancelled;
            running work will request cancellation without waiting here.
          </p>
        ) : null}
        <div className="catalog-fields">
          <label>
            Catalog action
            <select
              name="replacesDiscSelectionId"
              defaultValue=""
              onChange={selectCatalogAction}
            >
              <option value="">Add a new Disc Selection</option>
              {discSelections
                .filter((selection) =>
                  hasAction(selection, "correct") ||
                  hasAction(selection, "repair")
                )
                .map((selection) => (
                  <option key={selection.id} value={selection.id}>
                    {hasAction(selection, "repair")
                      ? "Repair unsafe legacy Disc Selection: "
                      : selection.actionAvailability.state !== "editable"
                        ? "Correct by supersession: "
                        : "Edit Disc Selection: "}
                    {discSelectionDescription(selection)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Media Item
            <select
              name="mediaItemId"
              required
              value={mediaItemId}
              onChange={(event) => setMediaItemId(event.currentTarget.value)}
            >
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
              onChange={(event) => {
                onSelectionKindChange(
                  event.currentTarget.value as DiscSelectionKind,
                );
              }}
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
              <select
                name="titleNumber"
                required
                value={titleNumber}
                onChange={(event) => setTitleNumber(event.currentTarget.value)}
              >
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
                <input
                  name="chapterStart"
                  type="number"
                  min="1"
                  required
                  value={chapterStart}
                  onChange={(event) => setChapterStart(event.currentTarget.value)}
                />
              </label>
              <label>
                Last chapter
                <input
                  name="chapterEnd"
                  type="number"
                  min="1"
                  required
                  value={chapterEnd}
                  onChange={(event) => setChapterEnd(event.currentTarget.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            Label
            <input
              name="label"
              maxLength={256}
              placeholder="Optional"
              value={label}
              disabled={clearLabel}
              required={
                editingSelection !== null && editingSelection.label !== null &&
                !clearLabel
              }
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          {editingSelection !== null && editingSelection.label !== null ? (
            <label className="catalog-clear-label">
              <input
                name="clearLabel"
                type="checkbox"
                checked={clearLabel}
                onChange={(event) => setClearLabel(event.currentTarget.checked)}
              />
              Clear current label
            </label>
          ) : null}
          {editingSelection ? (
            <p className="catalog-edit-preservation">
              Unchanged values are preserved. Use Clear current label to
              remove the existing label intentionally.
            </p>
          ) : null}
          {hasSupersessionCorrection ? (
            <label>
              Correction note
              <textarea
                name="correctionReason"
                maxLength={1_000}
                placeholder="Optional human context for catalog and encode history"
              />
            </label>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={isSaving || mediaItems.length === 0}
        >
          {editingSelection ? "Save Disc Selection" : "Add Disc Selection"}
        </button>
      </form>
    </>
  );
}
