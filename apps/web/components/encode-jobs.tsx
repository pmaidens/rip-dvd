"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  type DiscSelectionId,
  type EncodeJobId,
  type EncodeJobStatus,
  type EncodeQueueHistoryGroup,
  type EncodingProfileId,
} from "@rip-dvd/data-access";
import {
  ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH,
  validateEncodeQueueSearchQuery,
} from "@rip-dvd/data-access/encode-queue-search";

import { displayTerm } from "../lib/display-term";
import { isTerminalEncodeJobStatus } from "../lib/encode-job-status";

interface PriorCompletedEncodeJob {
  id: EncodeJobId;
  status: EncodeJobStatus;
  profile: EncodeProfileOption;
}

interface LogicalEncodeJob {
  id: EncodeJobId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
  status: EncodeJobStatus;
  queueAvailable: boolean;
}

export interface EncodeSelectionOption {
  id: DiscSelectionId;
  mediaItemId: string;
  mediaTitle: string;
  mediaYear: number | null;
  sourceDescription: string;
  hasCompletedEncode: boolean;
  priorCompletedJob: PriorCompletedEncodeJob | null;
  logicalJob: LogicalEncodeJob | null;
  suggestedOutputPath: string | null;
}

export interface EncodeProfileOption {
  id: EncodingProfileId;
  displayName: string;
  version: number;
}

export interface EncodeOptionsPage {
  offset: number;
  limit: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

interface EncodeHistoryCounts {
  notEncoded: number;
  reEncode: number;
}

export type EncodeJobsLoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "loaded";
      historyGroup: EncodeQueueHistoryGroup;
      query: string;
      counts: EncodeHistoryCounts;
      selections: EncodeSelectionOption[];
      profiles: EncodeProfileOption[];
      page: EncodeOptionsPage;
      profilePage: Omit<EncodeOptionsPage, "total">;
    };

export interface QueueEncodeJobInput {
  discSelectionId: DiscSelectionId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
}

export type QueueEncodeJobAction =
  | { kind: "enqueue"; input: QueueEncodeJobInput }
  | { kind: "requeue"; encodeJobId: EncodeJobId };

export type EncodeWorklistRowStatus =
  | "ready"
  | "queueing"
  | "queued"
  | "failed";

export interface EncodeWorklistRow {
  selection: EncodeSelectionOption;
  outputPath: string;
  status: EncodeWorklistRowStatus;
  error: string | null;
  attemptedProfile: EncodeProfileOption | null;
}

interface EncodeQueueSummary {
  queued: number;
  failed: number;
}

interface EncodeJobsViewProps {
  state: EncodeJobsLoadState;
  successfulQueueRevision?: number;
  checkedSelections: readonly EncodeSelectionOption[];
  worklistRows: readonly EncodeWorklistRow[];
  queueSummary: EncodeQueueSummary | null;
  profileUnavailable: boolean;
  selectedProfileId: EncodingProfileId | "";
  isSaving: boolean;
  requestError: string | null;
  onQueue(action: QueueEncodeJobAction): void;
  onToggleSelection(selection: EncodeSelectionOption, checked: boolean): void;
  onAddSelected(): void;
  onWorklistPath(selectionId: DiscSelectionId, outputPath: string): void;
  onRemoveWorklistRow(selectionId: DiscSelectionId): void;
  onClearWorklist(): void;
  onQueueWorklist(): void;
  onRetry(): void;
  onHistoryGroup(group: EncodeQueueHistoryGroup): void;
  onSearch(query: string): void;
  onProfileChange(profileId: EncodingProfileId | ""): void;
  onSelectionPage(offset: number): void;
  onProfilePage(offset: number): void;
}

interface OptionPagerProps {
  ariaLabel: string;
  isSaving: boolean;
  nextLabel: string;
  onPage(offset: number): void;
  page: Pick<
    EncodeOptionsPage,
    "offset" | "limit" | "hasPrevious" | "hasNext"
  >;
  previousLabel: string;
}

function OptionPager({
  ariaLabel,
  isSaving,
  nextLabel,
  onPage,
  page,
  previousLabel,
}: OptionPagerProps) {
  if (!page.hasPrevious && !page.hasNext) {
    return null;
  }
  return (
    <nav className="profile-actions profile-form" aria-label={ariaLabel}>
      <button
        type="button"
        disabled={isSaving || !page.hasPrevious}
        onClick={() => onPage(Math.max(0, page.offset - page.limit))}
      >
        {previousLabel}
      </button>
      <button
        type="button"
        disabled={isSaving || !page.hasNext}
        onClick={() => onPage(page.offset + page.limit)}
      >
        {nextLabel}
      </button>
    </nav>
  );
}

function mediaDescription(selection: EncodeSelectionOption): string {
  return `${selection.mediaTitle}${
    selection.mediaYear === null ? "" : ` (${selection.mediaYear})`
  } · ${selection.sourceDescription}`;
}

function selectionOptionLabel(selection: EncodeSelectionOption): string {
  const history = selection.hasCompletedEncode
    ? "Encoded before"
    : "Not encoded";
  const prior = selection.priorCompletedJob;
  if (prior === null) {
    return `${mediaDescription(selection)} · ${history}`;
  }
  return `${mediaDescription(selection)} · ${history} · ${prior.profile.displayName} version ${prior.profile.version} · ${displayTerm(prior.status)}`;
}

const ENCODE_JOB_PRESENTATION: Record<
  EncodeJobStatus,
  { activeDescription: string | null; submitLabel: string }
> = {
  queued: {
    activeDescription: "This Encode Job is already queued.",
    submitLabel: "Already queued",
  },
  running: {
    activeDescription:
      "This Encode Job is running and cannot be queued again.",
    submitLabel: "Encoding in progress",
  },
  cancellation_requested: {
    activeDescription:
      "Cancellation has been requested; this Encode Job cannot be queued again.",
    submitLabel: "Cancellation requested",
  },
  completed: { activeDescription: null, submitLabel: "Re-encode" },
  failed: { activeDescription: null, submitLabel: "Retry Encode Job" },
  cancelled: { activeDescription: null, submitLabel: "Retry Encode Job" },
};

function activeJobDescription(status: EncodeJobStatus): string {
  return ENCODE_JOB_PRESENTATION[status].activeDescription ??
    "This Encode Job cannot be queued again.";
}

function submitLabel(job: LogicalEncodeJob | null): string {
  if (job === null) {
    return "Queue new Encode Job";
  }
  if (isTerminalEncodeJobStatus(job.status) && !job.queueAvailable) {
    return "Cleanup in progress";
  }
  return ENCODE_JOB_PRESENTATION[job.status].submitLabel;
}

function worklistStatusLabel(status: EncodeWorklistRowStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "queueing":
      return "Queueing";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
  }
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function EncodeJobsView({
  state,
  successfulQueueRevision = 0,
  checkedSelections,
  worklistRows,
  queueSummary,
  profileUnavailable,
  selectedProfileId,
  isSaving,
  requestError,
  onQueue,
  onToggleSelection,
  onAddSelected,
  onWorklistPath,
  onRemoveWorklistRow,
  onClearWorklist,
  onQueueWorklist,
  onRetry,
  onHistoryGroup,
  onSearch,
  onProfileChange,
  onSelectionPage,
  onProfilePage,
}: EncodeJobsViewProps) {
  const [selectedSelection, setSelectedSelection] = useState<
    EncodeSelectionOption | null
  >(null);
  const [selectedSelectionGroup, setSelectedSelectionGroup] = useState<
    EncodeQueueHistoryGroup | null
  >(null);
  const [selectedSelectionProfileId, setSelectedSelectionProfileId] = useState<
    EncodingProfileId | ""
  >("");
  const [searchQuery, setSearchQuery] = useState(
    state.status === "loaded" ? state.query : "",
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [reencodeOutputPath, setReencodeOutputPath] = useState("");
  const [isReencodeOutputPathEdited, setIsReencodeOutputPathEdited] = useState(
    false,
  );
  const clearSelectedSelection = useCallback(() => {
    setSelectedSelection(null);
    setSelectedSelectionGroup(null);
    setSelectedSelectionProfileId("");
    setReencodeOutputPath("");
    setIsReencodeOutputPathEdited(false);
  }, []);

  const loadedHistoryGroup = state.status === "loaded"
    ? state.historyGroup
    : null;
  const groupedSelectedSelection = loadedHistoryGroup !== null &&
      selectedSelectionGroup === loadedHistoryGroup
    ? selectedSelection
    : null;
  const pageSelection = state.status === "loaded" &&
      groupedSelectedSelection !== null
    ? state.selections.find((selection) =>
      selection.id === groupedSelectedSelection.id
    )
    : undefined;
  const visibleSelection = pageSelection ?? groupedSelectedSelection;
  const logicalJob = visibleSelection?.logicalJob ?? null;
  const visibleSelectedProfileId = state.status === "loaded" &&
      state.profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : "";
  const logicalJobIsTerminal = logicalJob !== null &&
    isTerminalEncodeJobStatus(logicalJob.status);
  const selectionDetailsAreCurrent = pageSelection !== undefined &&
    selectedSelectionProfileId === visibleSelectedProfileId;
  const canSubmit = visibleSelection !== null &&
    visibleSelectedProfileId !== "" &&
    selectionDetailsAreCurrent &&
    (logicalJob === null ||
      (logicalJobIsTerminal && logicalJob.queueAvailable));
  const loadedQuery = state.status === "loaded" ? state.query : null;
  const groupTotal = state.status !== "loaded"
    ? 0
    : state.historyGroup === "not_encoded"
    ? state.counts.notEncoded
    : state.counts.reEncode;
  const groupLabel = state.status === "loaded" &&
      state.historyGroup === "re_encode"
    ? "re-encode"
    : "not encoded";

  useEffect(() => {
    if (
      state.status !== "loaded" ||
      selectedSelection === null ||
      selectedSelectionGroup !== state.historyGroup
    ) {
      return;
    }
    const refreshedSelection = state.selections.find(
      (candidate) => candidate.id === selectedSelection.id,
    );
    if (
      refreshedSelection !== undefined &&
      refreshedSelection !== selectedSelection
    ) {
      const selectedProfileChanged =
        selectedSelectionProfileId !== visibleSelectedProfileId;
      setSelectedSelection(refreshedSelection);
      setSelectedSelectionProfileId(visibleSelectedProfileId);
      if (
        selectedProfileChanged ||
        refreshedSelection.logicalJob !== null ||
        !isReencodeOutputPathEdited
      ) {
        setReencodeOutputPath(
          refreshedSelection.logicalJob?.outputPath ??
            refreshedSelection.suggestedOutputPath ??
            "",
        );
        setIsReencodeOutputPathEdited(false);
      }
    }
  }, [
    isReencodeOutputPathEdited,
    selectedSelection,
    selectedSelectionGroup,
    selectedSelectionProfileId,
    state,
    visibleSelectedProfileId,
  ]);

  useEffect(() => {
    if (
      loadedHistoryGroup !== null &&
      selectedSelectionGroup !== null &&
      selectedSelectionGroup !== loadedHistoryGroup
    ) {
      clearSelectedSelection();
    }
  }, [
    clearSelectedSelection,
    loadedHistoryGroup,
    selectedSelectionGroup,
  ]);

  useEffect(() => {
    clearSelectedSelection();
  }, [clearSelectedSelection, successfulQueueRevision]);

  useEffect(() => {
    if (loadedQuery !== null) {
      setSearchQuery(loadedQuery);
      setSearchError(null);
    }
  }, [loadedQuery]);

  function selectDiscSelection(event: React.ChangeEvent<HTMLSelectElement>) {
    if (state.status !== "loaded") {
      return;
    }
    const selectionId = event.currentTarget.value as DiscSelectionId;
    const selection = state.selections.find(
      (candidate) => candidate.id === selectionId,
    );
    if (selection === undefined) {
      clearSelectedSelection();
      return;
    }
    setSelectedSelection(selection);
    setSelectedSelectionGroup(state.historyGroup);
    setSelectedSelectionProfileId(visibleSelectedProfileId);
    setIsReencodeOutputPathEdited(false);
    setReencodeOutputPath(
      selection?.logicalJob?.outputPath ?? selection?.suggestedOutputPath ?? "",
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canSubmit ||
      visibleSelection === null ||
      visibleSelectedProfileId === ""
    ) {
      return;
    }
    if (logicalJob === null) {
      onQueue({
        kind: "enqueue",
        input: {
          discSelectionId: visibleSelection.id,
          encodingProfileId: visibleSelectedProfileId,
          outputPath: reencodeOutputPath.trim(),
        },
      });
      return;
    }
    if (isTerminalEncodeJobStatus(logicalJob.status)) {
      onQueue({ kind: "requeue", encodeJobId: logicalJob.id });
    }
  }

  const checkedSelectionIds = new Set(
    checkedSelections.map((selection) => selection.id),
  );
  const worklistSelectionIds = new Set(
    worklistRows.map((row) => row.selection.id),
  );
  const failedRows = worklistRows.filter((row) => row.status === "failed");
  const readyRows = worklistRows.filter((row) => row.status === "ready");
  const actionableCount = failedRows.length > 0
    ? failedRows.length
    : readyRows.length;
  const queueButtonLabel = failedRows.length > 0
    ? `Retry ${countLabel(failedRows.length, "failed Encode Job", "failed Encode Jobs")}`
    : `Queue ${countLabel(actionableCount, "Encode Job", "Encode Jobs")}`;

  return (
    <section
      className="encoding-profiles encode-jobs-manager"
      aria-labelledby="queue-encode-jobs-title"
    >
      <header className="profiles-header">
        <div>
          <p className="section-eyebrow">Reviewed catalog</p>
          <h2 id="queue-encode-jobs-title">Queue Encode Jobs</h2>
          <p>
            Build a first-encode worklist from Not encoded Disc Selections. The
            Re-encode view keeps its one-item queue action for deliberate repeat
            work.
          </p>
        </div>
      </header>

      {requestError ? (
        <div className="section-message section-error" role="alert">
          {requestError}
        </div>
      ) : null}

      {state.status === "loading" ? (
        <div className="section-message" aria-live="polite">
          Loading encoding options…
        </div>
      ) : state.status === "error" ? (
        <div className="section-message section-error" role="status">
          <span>Encoding options are unavailable. </span>
          <button type="button" onClick={onRetry}>Try again</button>
        </div>
      ) : (
        <>
          <div className="encode-worklist-toolbar">
            <label>
              Worklist Encoding Profile
              <select
                name="encodingProfileId"
                required
                value={visibleSelectedProfileId}
                disabled={state.profiles.length === 0 || isSaving}
                onChange={(event) =>
                  onProfileChange(
                    event.currentTarget.value as EncodingProfileId | "",
                  )}
              >
                <option value="" disabled>Select an active profile</option>
                {state.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {`${profile.displayName} · Version ${profile.version}`}
                  </option>
                ))}
              </select>
            </label>
            <div className="encode-worklist-queue-action">
              <span>
                {visibleSelectedProfileId === ""
                  ? "Choose one active profile for every actionable row."
                  : "The selected profile applies to every actionable row."}
              </span>
              <button
                type="button"
                disabled={
                  isSaving ||
                  actionableCount === 0 ||
                  visibleSelectedProfileId === ""
                }
                onClick={onQueueWorklist}
              >
                {isSaving && actionableCount > 0
                  ? `Queueing ${countLabel(actionableCount, "Encode Job", "Encode Jobs")}…`
                  : queueButtonLabel}
              </button>
            </div>
          </div>

          {profileUnavailable && worklistRows.length > 0 ? (
            <div className="section-message section-error" role="alert">
              The selected Encoding Profile is no longer available. Your
              worklist is intact. Choose a replacement profile before queueing.
            </div>
          ) : null}

          {queueSummary === null ? null : (
            <div className="section-message" role="status" aria-live="polite">
              {countLabel(
                queueSummary.queued,
                "Encode Job queued",
                "Encode Jobs queued",
              )}. {queueSummary.failed} failed.
            </div>
          )}

          <div className="encode-workspace">
            <section
              className="encode-picker-panel"
              aria-labelledby="encode-picker-title"
            >
              <header>
                <div>
                  <p className="section-eyebrow">Disc Selection picker</p>
                  <h3 id="encode-picker-title">Choose reviewed media</h3>
                </div>
                <span>{checkedSelections.length} selected</span>
              </header>

              <div className="encode-history-picker">
                <div
                  role="group"
                  aria-label="Encode history"
                  className="encode-history-groups"
                >
                  <button
                    type="button"
                    aria-pressed={state.historyGroup === "not_encoded"}
                    disabled={isSaving}
                    onClick={() => onHistoryGroup("not_encoded")}
                  >
                    <span>Not encoded</span>
                    <span>{state.counts.notEncoded}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={state.historyGroup === "re_encode"}
                    disabled={isSaving}
                    onClick={() => onHistoryGroup("re_encode")}
                  >
                    <span>Re-encode</span>
                    <span>{state.counts.reEncode}</span>
                  </button>
                </div>
                <p aria-live="polite">
                  {state.query === ""
                    ? `Showing ${state.selections.length} of ${state.page.total} ${groupLabel} Disc Selections.`
                    : `Showing ${state.selections.length} of ${state.page.total} matches in ${groupTotal} ${groupLabel} Disc Selections.`}
                </p>
              </div>

              <form
                className="encode-selection-search"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = new FormData(event.currentTarget).get(
                    "selectionQuery",
                  );
                  const query = typeof value === "string" ? value.trim() : "";
                  if (query === "") {
                    setSearchError(null);
                    if (state.query !== "") {
                      onSearch("");
                    }
                    return;
                  }
                  const validation = validateEncodeQueueSearchQuery(query);
                  if (!validation.valid) {
                    setSearchError(
                      validation.reason === "too_long"
                        ? `Search must be ${ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH} characters or fewer.`
                        : "Enter letters or numbers to search.",
                    );
                    return;
                  }
                  setSearchError(null);
                  if (validation.query !== state.query) {
                    onSearch(validation.query);
                  }
                }}
              >
                <label>
                  Search reviewed Disc Selections
                  <input
                    type="search"
                    name="selectionQuery"
                    maxLength={ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH}
                    value={searchQuery}
                    aria-describedby={
                      searchError === null
                        ? undefined
                        : "encode-selection-search-error"
                    }
                    aria-invalid={searchError !== null}
                    disabled={isSaving}
                    onChange={(event) => {
                      setSearchQuery(event.currentTarget.value);
                      setSearchError(null);
                    }}
                  />
                  {searchError === null ? null : (
                    <span id="encode-selection-search-error" role="alert">
                      {searchError}
                    </span>
                  )}
                </label>
                <button
                  type="submit"
                  disabled={isSaving || searchQuery.trim() === state.query}
                >
                  Search
                </button>
                {state.query === "" ? null : (
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      setSearchQuery("");
                      setSearchError(null);
                      onSearch("");
                    }}
                  >
                    Clear search
                  </button>
                )}
              </form>

              {state.historyGroup === "not_encoded" ? (
                <>
                  <ul className="encode-picker-results">
                    {state.selections.map((selection) => {
                      const isInWorklist = worklistSelectionIds.has(selection.id);
                      const existingJob = selection.logicalJob;
                      if (existingJob !== null) {
                        const canRequeue =
                          isTerminalEncodeJobStatus(existingJob.status) &&
                          existingJob.queueAvailable;
                        return (
                          <li key={selection.id}>
                            <div className="encode-picker-existing-job">
                              <span>
                                <strong>{mediaDescription(selection)}</strong>
                                <small>
                                  {canRequeue
                                    ? `Selected profile job: ${displayTerm(existingJob.status)}. Use the single-item action.`
                                    : activeJobDescription(existingJob.status)}
                                </small>
                              </span>
                              <button
                                type="button"
                                disabled={isSaving || !canRequeue}
                                onClick={() =>
                                  onQueue({
                                    kind: "requeue",
                                    encodeJobId: existingJob.id,
                                  })}
                              >
                                {submitLabel(existingJob)}
                              </button>
                            </div>
                          </li>
                        );
                      }
                      return (
                        <li key={selection.id}>
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Select ${mediaDescription(selection)}`}
                              checked={checkedSelectionIds.has(selection.id)}
                              disabled={isSaving || isInWorklist}
                              onChange={(event) =>
                                onToggleSelection(
                                  selection,
                                  event.currentTarget.checked,
                                )}
                            />
                            <span>
                              <strong>{mediaDescription(selection)}</strong>
                              <small>
                                First-encode candidate
                                {isInWorklist ? " · In worklist" : ""}
                              </small>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    className="encode-add-selected"
                    disabled={isSaving || checkedSelections.length === 0}
                    onClick={onAddSelected}
                  >
                    <span>Add selected to batch</span>
                    <span>{checkedSelections.length} selected</span>
                  </button>
                </>
              ) : (
                <form className="profile-form encode-requeue-form" onSubmit={submit}>
                  <div className="profile-fields">
                    <label>
                      Reviewed Disc Selection
                      <select
                        name="discSelectionId"
                        required
                        value={visibleSelection?.id ?? ""}
                        disabled={
                          (state.selections.length === 0 &&
                            visibleSelection === null) ||
                          isSaving
                        }
                        onChange={selectDiscSelection}
                      >
                        <option value="" disabled>Select reviewed media</option>
                        {visibleSelection !== null &&
                            pageSelection === undefined ? (
                          <option value={visibleSelection.id}>
                            {`Currently selected · ${selectionOptionLabel(visibleSelection)}`}
                          </option>
                        ) : null}
                        {state.selections.map((selection) => (
                          <option key={selection.id} value={selection.id}>
                            {selectionOptionLabel(selection)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Re-encode final output path
                      <input
                        name="outputPath"
                        required
                        readOnly={
                          logicalJob !== null || !selectionDetailsAreCurrent
                        }
                        maxLength={4096}
                        placeholder="/media/movies/Movie (2001)/Movie (2001).mkv"
                        value={reencodeOutputPath}
                        onChange={(event) => {
                          setReencodeOutputPath(event.currentTarget.value);
                          setIsReencodeOutputPathEdited(true);
                        }}
                      />
                    </label>
                  </div>

                  {visibleSelection ? (
                    <div className="encode-selection-summary" aria-live="polite">
                      <strong>{mediaDescription(visibleSelection)}</strong>
                      <span>
                        {visibleSelection.hasCompletedEncode
                          ? "Encoded before"
                          : "No completed Encode Job history"}
                      </span>
                      {visibleSelection.priorCompletedJob ? (
                        <span>
                          Previously encoded with {visibleSelection.priorCompletedJob.profile.displayName}, version {visibleSelection.priorCompletedJob.profile.version} · {displayTerm(visibleSelection.priorCompletedJob.status)}
                        </span>
                      ) : null}
                      {!selectionDetailsAreCurrent ? (
                        <span>
                          This choice is outside the current results. Return to
                          its result page to refresh the queue action and output
                          path. The last known path is read-only until then.
                        </span>
                      ) : logicalJob === null ? (
                        <span>
                          {visibleSelectedProfileId === ""
                            ? "Choose an Encoding Profile to determine the queue action."
                            : "This pair will create a new logical Encode Job. The suggested output path is editable."}
                        </span>
                      ) : logicalJobIsTerminal && logicalJob.queueAvailable ? (
                        <span>
                          This {displayTerm(logicalJob.status).toLowerCase()} Encode
                          Job will be queued again. Its reserved output path cannot
                          be changed.
                        </span>
                      ) : logicalJobIsTerminal ? (
                        <span>
                          Pending output cleanup must finish before this Encode Job
                          can be queued again.
                        </span>
                      ) : (
                        <span>{activeJobDescription(logicalJob.status)}</span>
                      )}
                    </div>
                  ) : null}

                  <button type="submit" disabled={isSaving || !canSubmit}>
                    {isSaving ? "Queueing…" : submitLabel(logicalJob)}
                  </button>
                </form>
              )}

              {state.selections.length === 0 ? (
                <div className="section-message" role="status">
                  {state.query !== "" && groupTotal > 0
                    ? `No Disc Selections match "${state.query}" in ${
                      state.historyGroup === "not_encoded"
                        ? "Not encoded"
                        : "Re-encode"
                    }.`
                    : state.historyGroup === "not_encoded"
                    ? "No not-encoded Disc Selections are available."
                    : "No Disc Selections are available for re-encoding."}
                </div>
              ) : null}
              <OptionPager
                ariaLabel="Encode selection pages"
                isSaving={isSaving}
                nextLabel="Next reviewed selections"
                onPage={onSelectionPage}
                page={state.page}
                previousLabel="Previous reviewed selections"
              />
            </section>

            <section
              className="encode-worklist-panel"
              aria-labelledby="encode-worklist-title"
            >
              <header>
                <div>
                  <p className="section-eyebrow">In-memory worklist</p>
                  <h3 id="encode-worklist-title">First-encode worklist</h3>
                </div>
                <button
                  type="button"
                  disabled={isSaving || worklistRows.length === 0}
                  onClick={onClearWorklist}
                >
                  Clear entire worklist
                </button>
              </header>

              {worklistRows.length === 0 ? (
                <div className="encode-worklist-empty">
                  Check Not encoded Disc Selections, then add them to the batch.
                </div>
              ) : (
                <table className="encode-worklist-table">
                  <thead>
                    <tr>
                      <th scope="col">Media Item</th>
                      <th scope="col">Disc Selection</th>
                      <th scope="col">Intent</th>
                      <th scope="col">Final output path</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worklistRows.map((row) => {
                      const title = row.selection.mediaTitle;
                      return (
                        <tr key={row.selection.id}>
                          <td data-label="Media Item">
                            <strong>{title}</strong>
                            {row.selection.mediaYear === null
                              ? null
                              : <span>{row.selection.mediaYear}</span>}
                          </td>
                          <td data-label="Disc Selection">
                            {row.selection.sourceDescription}
                          </td>
                          <td data-label="Intent">First encode</td>
                          <td data-label="Final output path">
                            <label>
                              <span className="visually-hidden">
                                Final output path for {title}
                              </span>
                              <input
                                type="text"
                                required
                                maxLength={4096}
                                aria-label={`Final output path for ${title}`}
                                value={row.outputPath}
                                readOnly={
                                  isSaving || row.status === "queued"
                                }
                                onChange={(event) =>
                                  onWorklistPath(
                                    row.selection.id,
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                          </td>
                          <td data-label="Outcome" aria-live="polite">
                            <strong>{worklistStatusLabel(row.status)}</strong>
                            {row.attemptedProfile === null ? null : (
                              <span>
                                {row.attemptedProfile.displayName}, version {row.attemptedProfile.version}
                              </span>
                            )}
                            {row.error === null ? null : (
                              <span className="encode-row-error" role="alert">
                                {row.error}
                              </span>
                            )}
                          </td>
                          <td data-label="Actions">
                            <button
                              type="button"
                              disabled={isSaving}
                              aria-label={`Remove ${title} from worklist`}
                              onClick={() =>
                                onRemoveWorklistRow(row.selection.id)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          {state.profiles.length === 0 ? (
            <div className="section-message" role="status">
              No active DVD video Encoding Profiles are available.
            </div>
          ) : null}
          <OptionPager
            ariaLabel="Encode profile pages"
            isSaving={isSaving}
            nextLabel="Next active profiles"
            onPage={onProfilePage}
            page={state.profilePage}
            previousLabel="Previous active profiles"
          />
        </>
      )}
    </section>
  );
}

type EncodeJobsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function errorMessage(response: Response, fallback: string) {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.trim() !== ""
    ) {
      return body.error.trim().slice(0, 512);
    }
  } catch {
    // Keep the bounded fallback for non-JSON responses.
  }
  return fallback;
}

interface EncodeJobOptionsRequest {
  selectionOffset: number;
  profileOffset: number;
  historyGroup: EncodeQueueHistoryGroup;
  query?: string;
  encodingProfileId?: EncodingProfileId;
}

class EncodeJobOptionsRequestError extends Error {
  constructor(readonly status: number) {
    super("Encoding options request failed");
  }
}

export async function requestEncodeJobOptions(
  request: EncodeJobOptionsRequest,
  fetcher: EncodeJobsFetch = fetch,
): Promise<Extract<EncodeJobsLoadState, { status: "loaded" }>> {
  const parameters = new URLSearchParams({
    historyGroup: request.historyGroup,
    selectionOffset: String(request.selectionOffset),
    profileOffset: String(request.profileOffset),
  });
  if (request.query?.trim()) {
    parameters.set("query", request.query.trim());
  }
  if (request.encodingProfileId !== undefined) {
    parameters.set("encodingProfileId", request.encodingProfileId);
  }
  const response = await fetcher(`/api/encode-jobs?${parameters}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new EncodeJobOptionsRequestError(response.status);
  }
  const body = await response.json() as Omit<
    Extract<EncodeJobsLoadState, { status: "loaded" }>,
    "status"
  >;
  return {
    status: "loaded",
    ...body,
    query: typeof body.query === "string" ? body.query : "",
  };
}

export async function queueEncodeJob(
  input: QueueEncodeJobInput,
  fetcher: EncodeJobsFetch = fetch,
): Promise<EncodeJobStatus> {
  const response = await fetcher("/api/encode-jobs", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Encode Job queueing failed"));
  }
  const body = await response.json() as { job: { status: EncodeJobStatus } };
  return body.job.status;
}

export async function retryEncodeJob(
  encodeJobId: EncodeJobId,
  fetcher: EncodeJobsFetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/encode-jobs", {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "requeue", encodeJobId }),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Encode Job retry failed"));
  }
}

export async function cancelEncodeJob(
  encodeJobId: EncodeJobId,
  fetcher: EncodeJobsFetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/encode-jobs", {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "cancel", encodeJobId }),
  });
  if (!response.ok) {
    throw new Error(
      await errorMessage(response, "Encode Job cancellation failed"),
    );
  }
}

export function EncodeJobsManager({
  onChanged,
  revision = 0,
}: {
  onChanged(): void;
  revision?: number;
}) {
  const [state, setState] = useState<EncodeJobsLoadState>({ status: "loading" });
  const [historyGroup, setHistoryGroup] = useState<EncodeQueueHistoryGroup>(
    "not_encoded",
  );
  const [selectedProfileId, setSelectedProfileId] = useState<
    EncodingProfileId | ""
  >("");
  const [selectionViews, setSelectionViews] = useState<Record<
    EncodeQueueHistoryGroup,
    { query: string; selectionOffset: number }
  >>({
    not_encoded: { query: "", selectionOffset: 0 },
    re_encode: { query: "", selectionOffset: 0 },
  });
  const [profileOffset, setProfileOffset] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [successfulQueueRevision, setSuccessfulQueueRevision] = useState(0);
  const [checkedSelections, setCheckedSelections] = useState<
    EncodeSelectionOption[]
  >([]);
  const [worklistRows, setWorklistRows] = useState<EncodeWorklistRow[]>([]);
  const [queueSummary, setQueueSummary] = useState<EncodeQueueSummary | null>(
    null,
  );
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const loadVersion = useRef(0);
  const selectionView = selectionViews[historyGroup];

  const load = useCallback(async () => {
    const version = loadVersion.current + 1;
    loadVersion.current = version;
    try {
      const loaded = await requestEncodeJobOptions({
        selectionOffset: selectionView.selectionOffset,
        profileOffset,
        historyGroup,
        query: selectionView.query,
        encodingProfileId: selectedProfileId || undefined,
      });
      if (loadVersion.current === version) {
        if (
          loaded.page.offset > 0 &&
          loaded.page.offset >= loaded.page.total
        ) {
          setSelectionViews((current) => ({
            ...current,
            [historyGroup]: {
              ...current[historyGroup],
              selectionOffset: 0,
            },
          }));
          setRequestError(null);
          return;
        }
        setState(loaded);
        setRequestError(null);
        if (selectedProfileId !== "") {
          setProfileUnavailable(false);
        }
      }
    } catch (error) {
      if (loadVersion.current === version) {
        if (
          selectedProfileId !== "" &&
          error instanceof EncodeJobOptionsRequestError &&
          error.status === 404
        ) {
          setProfileUnavailable(true);
          setSelectedProfileId("");
          setProfileOffset(0);
          setState({ status: "loading" });
        } else {
          setState({ status: "error" });
        }
      }
    }
  }, [
    historyGroup,
    profileOffset,
    revision,
    selectedProfileId,
    selectionView.query,
    selectionView.selectionOffset,
  ]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  async function queue(action: QueueEncodeJobAction) {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setRequestError(null);
    try {
      if (action.kind === "enqueue") {
        await queueEncodeJob(action.input);
      } else {
        await retryEncodeJob(action.encodeJobId);
      }
      setSuccessfulQueueRevision((current) => current + 1);
      await load();
      onChanged();
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Encode Job queueing failed",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function updateWorklistRow(
    selectionId: DiscSelectionId,
    update: Partial<Omit<EncodeWorklistRow, "selection">>,
  ) {
    setWorklistRows((current) => current.map((row) =>
      row.selection.id === selectionId ? { ...row, ...update } : row
    ));
  }

  async function queueWorklist() {
    if (isSaving || state.status !== "loaded") {
      return;
    }
    const profile = state.profiles.find(
      (candidate) => candidate.id === selectedProfileId,
    );
    if (profile === undefined) {
      return;
    }
    const failedRows = worklistRows.filter((row) => row.status === "failed");
    const actionableRows = failedRows.length > 0
      ? failedRows
      : worklistRows.filter((row) => row.status === "ready");
    if (actionableRows.length === 0) {
      return;
    }

    setIsSaving(true);
    setRequestError(null);
    setQueueSummary(null);
    let queued = 0;
    let failed = 0;
    try {
      for (const row of actionableRows) {
        updateWorklistRow(row.selection.id, {
          status: "queueing",
          error: null,
          attemptedProfile: profile,
        });
        try {
          const queuedStatus = await queueEncodeJob({
            discSelectionId: row.selection.id,
            encodingProfileId: profile.id,
            outputPath: row.outputPath.trim(),
          });
          if (queuedStatus !== "queued") {
            throw new Error(
              `The selected profile already has an Encode Job with ${displayTerm(queuedStatus).toLowerCase()} status. Use its single-item action instead.`,
            );
          }
          queued += 1;
          updateWorklistRow(row.selection.id, {
            status: "queued",
            error: null,
            attemptedProfile: profile,
          });
        } catch (error) {
          failed += 1;
          updateWorklistRow(row.selection.id, {
            status: "failed",
            error: error instanceof Error
              ? error.message.slice(0, 512)
              : "Encode Job queueing failed",
            attemptedProfile: profile,
          });
        }
      }
      setQueueSummary({ queued, failed });
      await load();
      onChanged();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <EncodeJobsView
      state={state}
      successfulQueueRevision={successfulQueueRevision}
      checkedSelections={checkedSelections}
      worklistRows={worklistRows}
      queueSummary={queueSummary}
      profileUnavailable={profileUnavailable}
      selectedProfileId={selectedProfileId}
      isSaving={isSaving}
      requestError={requestError}
      onQueue={(action) => void queue(action)}
      onToggleSelection={(selection, checked) => {
        setCheckedSelections((current) => checked
          ? current.some((candidate) => candidate.id === selection.id)
            ? current
            : [...current, selection]
          : current.filter((candidate) => candidate.id !== selection.id));
      }}
      onAddSelected={() => {
        setWorklistRows((current) => {
          const existingIds = new Set(
            current.map((row) => row.selection.id),
          );
          return [
            ...current,
            ...checkedSelections.flatMap((selection) =>
              existingIds.has(selection.id)
                ? []
                : [{
                    selection,
                    outputPath: selection.suggestedOutputPath ?? "",
                    status: "ready" as const,
                    error: null,
                    attemptedProfile: null,
                  }]
            ),
          ];
        });
        setCheckedSelections([]);
        setQueueSummary(null);
      }}
      onWorklistPath={(selectionId, outputPath) => {
        updateWorklistRow(selectionId, { outputPath });
      }}
      onRemoveWorklistRow={(selectionId) => {
        setWorklistRows((current) =>
          current.filter((row) => row.selection.id !== selectionId)
        );
      }}
      onClearWorklist={() => {
        setWorklistRows([]);
        setQueueSummary(null);
      }}
      onQueueWorklist={() => void queueWorklist()}
      onRetry={() => void load()}
      onHistoryGroup={(group) => {
        setHistoryGroup(group);
      }}
      onSearch={(query) => {
        setSelectionViews((current) => ({
          ...current,
          [historyGroup]: { query: query.trim(), selectionOffset: 0 },
        }));
      }}
      onProfileChange={(profileId) => {
        setProfileUnavailable(false);
        setSelectedProfileId(profileId);
      }}
      onSelectionPage={(selectionOffset) => {
        setSelectionViews((current) => ({
          ...current,
          [historyGroup]: {
            ...current[historyGroup],
            selectionOffset,
          },
        }));
      }}
      onProfilePage={(offset) => {
        setSelectedProfileId("");
        setProfileOffset(offset);
      }}
    />
  );
}
