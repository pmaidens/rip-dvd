// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";
import type {
  CatalogReviewDiscSelection,
  DiscSelectionKind,
  UpdateDiscSelectionInput,
} from "./catalog-review-model";

(globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

const editableSelection: CatalogReviewDiscSelection = {
  id: "selection-1",
  mediaItemId: "episode-1",
  sourceIdentity: {
    kind: "dvd_chapters",
    titleNumber: 1,
    chapterStart: 2,
    chapterEnd: 5,
  },
  label: "Director's cut",
  actionAvailability: {
    state: "editable",
    availableActions: ["update", "remove"],
    reason: null,
    relatedEncodeJob: null,
  },
};

function InteractiveDiscSelections({
  onUpdate,
  selection = editableSelection,
}: {
  onUpdate(id: string, changes: UpdateDiscSelectionInput): void;
  selection?: CatalogReviewDiscSelection;
}) {
  const [selectionKind, setSelectionKind] =
    useState<DiscSelectionKind>("main_feature");
  return (
    <CatalogReviewDiscSelections
      discSelections={[selection]}
      page={{
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      }}
      correctionHistory={[]}
      correctionHistoryPage={{
        offset: 0,
        limit: 100,
        hasPrevious: false,
        hasNext: false,
      }}
      mediaItems={[
        {
          id: "episode-1",
          parentId: null,
          kind: "episode",
          title: "Episode One",
          year: null,
          seasonNumber: null,
          episodeNumber: 1,
        },
        {
          id: "episode-2",
          parentId: null,
          kind: "episode",
          title: "Episode Two",
          year: null,
          seasonNumber: null,
          episodeNumber: 2,
        },
      ]}
      rawTitles={[{
        number: 1,
        durationSeconds: 2_400,
        chapters: 8,
        audioStreams: [],
        subtitles: [],
      }]}
      selectionKind={selectionKind}
      isSaving={false}
      onPage={() => undefined}
      onCorrectionHistoryPage={() => undefined}
      onSelectionKindChange={setSelectionKind}
      onCreate={() => undefined}
      onUpdate={onUpdate}
      onDelete={() => undefined}
    />
  );
}

describe("CatalogReviewDiscSelections", () => {
  it("renders reviewed mappings, repair choices, and pagination", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "episode-1",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 1,
            chapterStart: 1,
            chapterEnd: 4,
          },
          label: null,
          actionAvailability: {
            state: "editable",
            availableActions: ["update", "remove"],
            reason: null,
            relatedEncodeJob: null,
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: true,
        }}
        correctionHistory={[]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionEncodeHistory={[]}
        correctionEncodeHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionRetainedOutputHistory={[]}
        correctionRetainedOutputHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
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
        onCorrectionHistoryPage={() => undefined}
        onCorrectionEncodeHistoryPage={() => undefined}
        onCorrectionRetainedOutputHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Episode One");
    expect(html).toContain("Title 1, chapters 1–4");
    expect(html).toContain("Label: None");
    expect(html).toContain("Editable");
    expect(html).toContain("Edit Disc Selection");
    expect(html).toContain("Remove Disc Selection");
    expect(html).toContain("Next Disc Selections");
  });

  it("offers supersession for a running dependency without direct mutation actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "movie-1",
          sourceIdentity: { kind: "main_feature" },
          label: null,
          actionAvailability: {
            state: "locked_provenance",
            availableActions: ["correct"],
            reason:
              "Encode Job job-1 is running; correcting by supersession will request cancellation and preserve its provenance",
            relatedEncodeJob: { id: "job-1", status: "running" },
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionHistory={[]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionEncodeHistory={[]}
        correctionEncodeHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionRetainedOutputHistory={[]}
        correctionRetainedOutputHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[{
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Locked Movie",
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onCorrectionHistoryPage={() => undefined}
        onCorrectionEncodeHistoryPage={() => undefined}
        onCorrectionRetainedOutputHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Locked provenance");
    expect(html).toContain("Encode Job job-1 is running");
    expect(html).toContain("Correct by supersession");
    expect(html).toContain("Correction note");
    expect(html).toContain("will request cancellation");
    expect(html).not.toContain("Repair unsafe legacy Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
  });

  it("shows every superseded source and human correction note", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-corrected",
          mediaItemId: "movie-corrected",
          sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
          label: null,
          actionAvailability: {
            state: "editable",
            availableActions: ["update", "remove"],
            reason: null,
            relatedEncodeJob: null,
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionHistory={[
          {
            supersededDiscSelection: {
              id: "selection-mistaken",
              mediaItemId: "movie-mistaken",
              sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
              label: "Theatrical cut",
            },
            replacementDiscSelection: {
              id: "selection-intermediate",
              mediaItemId: "movie-intermediate",
              sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
              label: null,
            },
            reason: "The director's cut is title 2.",
            correctedAt: "2026-08-12T18:00:00.000Z",
          },
          {
            supersededDiscSelection: {
              id: "selection-intermediate",
              mediaItemId: "movie-intermediate",
              sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
              label: null,
            },
            replacementDiscSelection: {
              id: "selection-corrected",
              mediaItemId: "movie-corrected",
              sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
              label: null,
            },
            reason: "The restored edition is title 3.",
            correctedAt: "2026-08-12T19:00:00.000Z",
          },
        ]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionEncodeHistory={[{
          replacementDiscSelectionId: "selection-intermediate",
          predecessorEncodeJob: {
            id: "encode-original",
            status: "completed",
            replacementEncodeJobId: "encode-corrected",
          },
          replacementEncodeJob: {
            id: "encode-corrected",
            status: "completed",
            predecessorEncodeJobId: "encode-original",
          },
        }]}
        correctionEncodeHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionRetainedOutputHistory={[{
          replacementDiscSelectionId: "selection-intermediate",
          retainedOutput: {
            id: "retained-output-1",
            predecessorEncodeJobId: "encode-original",
            replacementEncodeJobId: "encode-corrected",
            state: "retained",
            cleanupEligible: true,
            retainedAt: "2026-08-12T20:00:00.000Z",
          },
        }]}
        correctionRetainedOutputHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[
          {
            id: "movie-corrected",
            parentId: null,
            kind: "movie",
            title: "Correct Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-intermediate",
            parentId: null,
            kind: "movie",
            title: "Intermediate Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-mistaken",
            parentId: null,
            kind: "movie",
            title: "Mistaken Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        ]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onCorrectionHistoryPage={() => undefined}
        onCorrectionEncodeHistoryPage={() => undefined}
        onCorrectionRetainedOutputHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Disc Selection Correction History");
    expect(html).toContain(
      "Mistaken Movie · Title 1 → Intermediate Movie · Title 2",
    );
    expect(html).toContain(
      "Intermediate Movie · Title 2 → Correct Movie · Title 3",
    );
    expect(html).toContain("The director&#x27;s cut is title 2.");
    expect(html).toContain("The restored edition is title 3.");
    expect(html).toContain(
      "Encode Job encode-original · Completed → Encode Job encode-corrected · Completed",
    );
    expect(html).toContain("Replacement Disc Selection selection-intermediate");
    expect(html).toContain("Retained Output retained-output-1 · Retained");
    expect(html).toContain("Retained 2026-08-12T20:00:00.000Z · Cleanup eligible");
    expect(html).toContain("Correct Movie");
  });

  it("marks unsafe legacy selections as Needs repair with only recovery actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[
          {
            id: "selection-1",
            mediaItemId: "movie-1",
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: null,
            actionAvailability: {
              state: "needs_repair",
              availableActions: ["repair", "remove"],
              reason:
                "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review",
              relatedEncodeJob: null,
            },
          },
          {
            id: "selection-2",
            mediaItemId: "movie-2",
            sourceIdentity: { kind: "main_feature" },
            label: null,
            actionAvailability: {
              state: "needs_repair",
              availableActions: [],
              reason:
                "Encode Job job-2 is queued; this unsafe legacy Disc Selection needs repair, but direct mutation is unavailable while the job is active",
              relatedEncodeJob: { id: "job-2", status: "queued" },
            },
          },
        ]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionHistory={[]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionEncodeHistory={[]}
        correctionEncodeHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionRetainedOutputHistory={[]}
        correctionRetainedOutputHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[
          {
            id: "movie-1",
            parentId: null,
            kind: "movie",
            title: "Legacy Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-2",
            parentId: null,
            kind: "movie",
            title: "Legacy Movie with queued work",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        ]}
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
        onCorrectionHistoryPage={() => undefined}
        onCorrectionEncodeHistoryPage={() => undefined}
        onCorrectionRetainedOutputHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Needs repair");
    expect(html).toContain("Unsafe legacy Disc Selection");
    expect(html).toContain("Encode Job job-2 is queued");
    expect(html).toContain("Repair unsafe legacy Disc Selection");
    expect(html).toContain("Remove Disc Selection");
    expect(html).not.toContain("Edit Disc Selection");
    expect(html.match(/Repair unsafe legacy Disc Selection/g)).toHaveLength(1);
    expect(html.match(/Remove Disc Selection/g)).toHaveLength(1);
  });

  it("explains the archive cutover fence without rendering mutation actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "movie-1",
          sourceIdentity: { kind: "main_feature" },
          label: null,
          actionAvailability: {
            state: "changes_unavailable",
            availableActions: [],
            reason:
              "Disc Selection changes are unavailable while legacy cutover repair is pending",
            relatedEncodeJob: null,
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionHistory={[]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionEncodeHistory={[]}
        correctionEncodeHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionRetainedOutputHistory={[]}
        correctionRetainedOutputHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[{
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Cutover Movie",
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onCorrectionHistoryPage={() => undefined}
        onCorrectionEncodeHistoryPage={() => undefined}
        onCorrectionRetainedOutputHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Changes unavailable");
    expect(html).toContain("legacy cutover repair is pending");
    expect(html).not.toContain("Edit Disc Selection");
    expect(html).not.toContain("Repair unsafe legacy Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
  });

  it("prefills an editable mapping and preserves every unchanged field", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onUpdate = vi.fn();
    await act(async () => {
      root.render(<InteractiveDiscSelections onUpdate={onUpdate} />);
    });

    expect(container.textContent).toContain("Label: Director's cut");
    const action = container.querySelector<HTMLSelectElement>(
      'select[name="replacesDiscSelectionId"]',
    );
    if (!action) throw new Error("Expected the Catalog action control");
    await act(async () => {
      action.value = editableSelection.id;
      action.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector<HTMLSelectElement>(
      'select[name="mediaItemId"]',
    )?.value).toBe("episode-1");
    expect(container.querySelector<HTMLSelectElement>(
      'select[name="selectionKind"]',
    )?.value).toBe("dvd_chapters");
    expect(container.querySelector<HTMLSelectElement>(
      'select[name="titleNumber"]',
    )?.value).toBe("1");
    expect(container.querySelector<HTMLInputElement>(
      'input[name="chapterStart"]',
    )?.value).toBe("2");
    expect(container.querySelector<HTMLInputElement>(
      'input[name="chapterEnd"]',
    )?.value).toBe("5");
    expect(container.querySelector<HTMLInputElement>(
      'input[name="label"]',
    )?.value).toBe("Director's cut");

    const mediaItem = container.querySelector<HTMLSelectElement>(
      'select[name="mediaItemId"]',
    );
    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!mediaItem || !submit) {
      throw new Error("Expected editable Disc Selection controls");
    }
    await act(async () => {
      mediaItem.value = "episode-2";
      mediaItem.dispatchEvent(new Event("change", { bubbles: true }));
      submit.click();
    });

    expect(onUpdate).toHaveBeenCalledWith(editableSelection.id, {
      mediaItemId: "episode-2",
    });
    await act(async () => root.unmount());
    container.remove();
  });

  it("requires the explicit clear control before removing an existing label", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onUpdate = vi.fn();
    await act(async () => {
      root.render(<InteractiveDiscSelections onUpdate={onUpdate} />);
    });
    const action = container.querySelector<HTMLSelectElement>(
      'select[name="replacesDiscSelectionId"]',
    );
    if (!action) throw new Error("Expected the Catalog action control");
    await act(async () => {
      action.value = editableSelection.id;
      action.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const label = container.querySelector<HTMLInputElement>(
      'input[name="label"]',
    );
    const clear = container.querySelector<HTMLInputElement>(
      'input[name="clearLabel"]',
    );
    const form = container.querySelector<HTMLFormElement>("form.catalog-form");
    const submit = container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (!label || !clear || !form || !submit) {
      throw new Error("Expected explicit label-clearing controls");
    }
    await act(async () => {
      label.value = "";
      label.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(label.required).toBe(true);
    expect(form.checkValidity()).toBe(false);
    await act(async () => submit.click());
    expect(onUpdate).not.toHaveBeenCalled();

    await act(async () => clear.click());
    expect(label.disabled).toBe(true);
    await act(async () => submit.click());
    expect(onUpdate).toHaveBeenCalledWith(editableSelection.id, {
      label: null,
    });

    await act(async () => {
      root.render(
        <InteractiveDiscSelections
          selection={{ ...editableSelection, label: null }}
          onUpdate={onUpdate}
        />,
      );
    });
    expect(container.querySelector('input[name="clearLabel"]')).toBeNull();
    const refreshedLabel = container.querySelector<HTMLInputElement>(
      'input[name="label"]',
    );
    expect(refreshedLabel?.disabled).toBe(false);
    expect(refreshedLabel?.value).toBe("");
    await act(async () => root.unmount());
    container.remove();
  });
});
