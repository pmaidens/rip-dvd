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

interface EncodeJobsViewProps {
  state: EncodeJobsLoadState;
  successfulQueueRevision?: number;
  selectedProfileId: EncodingProfileId | "";
  isSaving: boolean;
  requestError: string | null;
  onQueue(action: QueueEncodeJobAction): void;
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

export function EncodeJobsView({
  state,
  successfulQueueRevision = 0,
  selectedProfileId,
  isSaving,
  requestError,
  onQueue,
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
  const [outputPath, setOutputPath] = useState("");
  const [isOutputPathEdited, setIsOutputPathEdited] = useState(false);
  const clearSelectedSelection = useCallback(() => {
    setSelectedSelection(null);
    setSelectedSelectionGroup(null);
    setSelectedSelectionProfileId("");
    setOutputPath("");
    setIsOutputPathEdited(false);
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
  const selectionDetailsAreCurrent = pageSelection !== undefined ||
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
      if (selectedProfileChanged || !isOutputPathEdited) {
        setOutputPath(
          refreshedSelection.logicalJob?.outputPath ??
            refreshedSelection.suggestedOutputPath ??
            "",
        );
        setIsOutputPathEdited(false);
      }
    }
  }, [
    isOutputPathEdited,
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
    setIsOutputPathEdited(false);
    setOutputPath(
      selection?.logicalJob?.outputPath ?? selection?.suggestedOutputPath ?? "",
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (visibleSelection === null || visibleSelectedProfileId === "") {
      return;
    }
    if (logicalJob === null) {
      onQueue({
        kind: "enqueue",
        input: {
          discSelectionId: visibleSelection.id,
          encodingProfileId: visibleSelectedProfileId,
          outputPath: outputPath.trim(),
        },
      });
      return;
    }
    if (isTerminalEncodeJobStatus(logicalJob.status)) {
      onQueue({ kind: "requeue", encodeJobId: logicalJob.id });
    }
  }

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
            Start with Disc Selections that have never completed an encode, or
            choose Re-encode for deliberate repeat work.
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
              if (query !== state.query) {
                onSearch(query);
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
                disabled={isSaving}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
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
                  onSearch("");
                }}
              >
                Clear search
              </button>
            )}
          </form>

          <form className="profile-form" onSubmit={submit}>
            <div className="profile-fields encode-job-fields">
              <label>
                Active Encoding Profile
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
              <label>
                Reviewed Disc Selection
                <select
                  name="discSelectionId"
                  required
                  value={visibleSelection?.id ?? ""}
                  disabled={
                    (state.selections.length === 0 && visibleSelection === null) ||
                    isSaving
                  }
                  onChange={selectDiscSelection}
                >
                  <option value="" disabled>Select reviewed media</option>
                  {visibleSelection !== null && pageSelection === undefined ? (
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
                Final output path
                <input
                  name="outputPath"
                  required
                  readOnly={logicalJob !== null}
                  maxLength={4096}
                  placeholder="/media/movies/Movie (2001)/Movie (2001).mkv"
                  value={outputPath}
                  onChange={(event) => {
                    setOutputPath(event.currentTarget.value);
                    setIsOutputPathEdited(true);
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
                    This choice is outside the current results. Return to its result page to refresh the queue action for this Encoding Profile.
                  </span>
                ) : logicalJob === null ? (
                  <span>
                    {visibleSelectedProfileId === ""
                      ? "Choose an Encoding Profile to determine the queue action."
                      : "This pair will create a new logical Encode Job. The suggested output path is editable."}
                  </span>
                ) : logicalJobIsTerminal && logicalJob.queueAvailable ? (
                  <span>
                    This {displayTerm(logicalJob.status).toLowerCase()} Encode Job will be queued again. Its reserved output path cannot be changed.
                  </span>
                ) : logicalJobIsTerminal ? (
                  <span>
                    Pending output cleanup must finish before this Encode Job can be queued again.
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

          {state.selections.length === 0 ? (
            <div className="section-message" role="status">
              {state.query !== "" &&
                  groupTotal > 0
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
          {state.profiles.length === 0 ? (
            <div className="section-message" role="status">
              No active DVD video Encoding Profiles are available.
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
): Promise<void> {
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
        setState(loaded);
        setRequestError(null);
      }
    } catch (error) {
      if (loadVersion.current === version) {
        if (
          selectedProfileId !== "" &&
          error instanceof EncodeJobOptionsRequestError &&
          error.status === 404
        ) {
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

  return (
    <EncodeJobsView
      state={state}
      successfulQueueRevision={successfulQueueRevision}
      selectedProfileId={selectedProfileId}
      isSaving={isSaving}
      requestError={requestError}
      onQueue={(action) => void queue(action)}
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
      onProfileChange={setSelectedProfileId}
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
