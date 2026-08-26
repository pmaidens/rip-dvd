"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import type {
  DiscSelectionId,
  EncodeJobId,
  EncodeJobStatus,
  EncodeQueueHistoryGroup,
  EncodingProfileId,
} from "@rip-dvd/data-access";

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
  selectedProfileId: EncodingProfileId | "";
  isSaving: boolean;
  requestError: string | null;
  onQueue(action: QueueEncodeJobAction): void;
  onRetry(): void;
  onHistoryGroup(group: EncodeQueueHistoryGroup): void;
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
  selectedProfileId,
  isSaving,
  requestError,
  onQueue,
  onRetry,
  onHistoryGroup,
  onProfileChange,
  onSelectionPage,
  onProfilePage,
}: EncodeJobsViewProps) {
  const [selectedSelectionId, setSelectedSelectionId] = useState<
    DiscSelectionId | ""
  >("");
  const [outputPath, setOutputPath] = useState("");

  const selectedSelection = state.status === "loaded"
    ? state.selections.find((selection) =>
      selection.id === selectedSelectionId
    ) ?? null
    : null;
  const logicalJob = selectedSelection?.logicalJob ?? null;
  const visibleSelectedProfileId = state.status === "loaded" &&
      state.profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : "";
  const logicalJobIsTerminal = logicalJob !== null &&
    isTerminalEncodeJobStatus(logicalJob.status);
  const canSubmit = selectedSelection !== null &&
    visibleSelectedProfileId !== "" &&
    (logicalJob === null ||
      (logicalJobIsTerminal && logicalJob.queueAvailable));

  useEffect(() => {
    if (state.status !== "loaded") {
      return;
    }
    const selection = state.selections.find(
      (candidate) => candidate.id === selectedSelectionId,
    );
    if (selection === undefined) {
      setSelectedSelectionId("");
      setOutputPath("");
      return;
    }
    setOutputPath(
      selection.logicalJob?.outputPath ?? selection.suggestedOutputPath ?? "",
    );
  }, [selectedSelectionId, state]);

  function selectDiscSelection(event: React.ChangeEvent<HTMLSelectElement>) {
    if (state.status !== "loaded") {
      return;
    }
    const selectionId = event.currentTarget.value as DiscSelectionId;
    const selection = state.selections.find(
      (candidate) => candidate.id === selectionId,
    );
    setSelectedSelectionId(selectionId);
    setOutputPath(
      selection?.logicalJob?.outputPath ?? selection?.suggestedOutputPath ?? "",
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedSelection === null || visibleSelectedProfileId === "") {
      return;
    }
    if (logicalJob === null) {
      onQueue({
        kind: "enqueue",
        input: {
          discSelectionId: selectedSelection.id,
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
              Showing {state.selections.length} of {state.page.total}{" "}
              {state.historyGroup === "not_encoded"
                ? "not encoded"
                : "re-encode"}{" "}
              Disc Selections.
            </p>
          </div>

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
                  value={selectedSelectionId}
                  disabled={state.selections.length === 0 || isSaving}
                  onChange={selectDiscSelection}
                >
                  <option value="" disabled>Select reviewed media</option>
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
                  onChange={(event) => setOutputPath(event.currentTarget.value)}
                />
              </label>
            </div>

            {selectedSelection ? (
              <div className="encode-selection-summary" aria-live="polite">
                <strong>{mediaDescription(selectedSelection)}</strong>
                <span>
                  {selectedSelection.hasCompletedEncode
                    ? "Encoded before"
                    : "No completed Encode Job history"}
                </span>
                {selectedSelection.priorCompletedJob ? (
                  <span>
                    Previously encoded with {selectedSelection.priorCompletedJob.profile.displayName}, version {selectedSelection.priorCompletedJob.profile.version} · {displayTerm(selectedSelection.priorCompletedJob.status)}
                  </span>
                ) : null}
                {logicalJob === null ? (
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
              {state.historyGroup === "not_encoded"
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
  return { status: "loaded", ...body };
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

export function EncodeJobsManager({ onChanged }: { onChanged(): void }) {
  const [state, setState] = useState<EncodeJobsLoadState>({ status: "loading" });
  const [historyGroup, setHistoryGroup] = useState<EncodeQueueHistoryGroup>(
    "not_encoded",
  );
  const [selectedProfileId, setSelectedProfileId] = useState<
    EncodingProfileId | ""
  >("");
  const [selectionOffset, setSelectionOffset] = useState(0);
  const [profileOffset, setProfileOffset] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = loadVersion.current + 1;
    loadVersion.current = version;
    try {
      const loaded = await requestEncodeJobOptions({
        selectionOffset,
        profileOffset,
        historyGroup,
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
  }, [historyGroup, profileOffset, selectedProfileId, selectionOffset]);

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
      selectedProfileId={selectedProfileId}
      isSaving={isSaving}
      requestError={requestError}
      onQueue={(action) => void queue(action)}
      onRetry={() => void load()}
      onHistoryGroup={(group) => {
        setSelectionOffset(0);
        setHistoryGroup(group);
      }}
      onProfileChange={setSelectedProfileId}
      onSelectionPage={setSelectionOffset}
      onProfilePage={(offset) => {
        setSelectedProfileId("");
        setProfileOffset(offset);
      }}
    />
  );
}
