"use client";

import React, { useCallback, useEffect, useState } from "react";

import type {
  DiscSelectionId,
  EncodeJobId,
  EncodingProfileId,
} from "@rip-dvd/data-access";

export interface EncodeSelectionOption {
  id: DiscSelectionId;
  mediaItemId: string;
  mediaTitle: string;
  mediaYear: number | null;
  sourceDescription: string;
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
  hasPrevious: boolean;
  hasNext: boolean;
}

export type EncodeJobsLoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "loaded";
      selections: EncodeSelectionOption[];
      profiles: EncodeProfileOption[];
      page: EncodeOptionsPage;
      profilePage: EncodeOptionsPage;
    };

export interface QueueEncodeJobInput {
  discSelectionId: DiscSelectionId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
}

interface EncodeJobsViewProps {
  state: EncodeJobsLoadState;
  isSaving: boolean;
  requestError: string | null;
  onQueue(input: QueueEncodeJobInput): void;
  onRetry(): void;
  onSelectionPage(offset: number): void;
  onProfilePage(offset: number): void;
}

interface OptionPagerProps {
  ariaLabel: string;
  isSaving: boolean;
  nextLabel: string;
  onPage(offset: number): void;
  page: EncodeOptionsPage;
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
    <nav
      className="profile-actions profile-form"
      aria-label={ariaLabel}
    >
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

export function EncodeJobsView({
  state,
  isSaving,
  requestError,
  onQueue,
  onRetry,
  onSelectionPage,
  onProfilePage,
}: EncodeJobsViewProps) {
  function populateOutputPath(event: React.ChangeEvent<HTMLSelectElement>) {
    if (state.status !== "loaded") {
      return;
    }
    const selection = state.selections.find(
      (candidate) => candidate.id === event.currentTarget.value,
    );
    const outputInput = event.currentTarget.form?.elements.namedItem(
      "outputPath",
    );
    if (outputInput instanceof HTMLInputElement) {
      outputInput.value = selection?.suggestedOutputPath ?? "";
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onQueue({
      discSelectionId: String(
        form.get("discSelectionId") ?? "",
      ) as DiscSelectionId,
      encodingProfileId: String(
        form.get("encodingProfileId") ?? "",
      ) as EncodingProfileId,
      outputPath: String(form.get("outputPath") ?? "").trim(),
    });
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
            Choose reviewed Disc Selections and active DVD video profile
            versions. Repeating a pair keeps one logical Encode Job.
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
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <form className="profile-form" onSubmit={submit}>
            <div className="profile-fields encode-job-fields">
              <label>
                Reviewed Disc Selection
                <select
                  name="discSelectionId"
                  required
                  defaultValue=""
                  disabled={state.selections.length === 0}
                  onChange={populateOutputPath}
                >
                  <option value="" disabled>Select reviewed media</option>
                  {state.selections.map((selection) => (
                    <option key={selection.id} value={selection.id}>
                      {`${selection.mediaTitle}${
                        selection.mediaYear === null
                          ? ""
                          : ` (${selection.mediaYear})`
                      } · ${selection.sourceDescription}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Active Encoding Profile
                <select
                  name="encodingProfileId"
                  required
                  defaultValue=""
                  disabled={state.profiles.length === 0}
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
                Final output path
                <input
                  name="outputPath"
                  required
                  maxLength={4096}
                  placeholder="/media/movies/Movie (2001)/Movie (2001).mkv"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={
                isSaving ||
                state.selections.length === 0 ||
                state.profiles.length === 0
              }
            >
              {isSaving ? "Queueing…" : "Queue encode"}
            </button>
          </form>

          {state.selections.length === 0 ? (
            <div className="section-message">
              No reviewed Disc Selections are available for encoding.
            </div>
          ) : null}
          {state.profiles.length === 0 ? (
            <div className="section-message">
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

export async function requestEncodeJobOptions(
  selectionOffset: number,
  profileOffset: number,
  fetcher: EncodeJobsFetch = fetch,
): Promise<Extract<EncodeJobsLoadState, { status: "loaded" }>> {
  const response = await fetcher(
    `/api/encode-jobs?selectionOffset=${selectionOffset}&profileOffset=${profileOffset}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("Encoding options request failed");
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
  const [selectionOffset, setSelectionOffset] = useState(0);
  const [profileOffset, setProfileOffset] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await requestEncodeJobOptions(selectionOffset, profileOffset));
      setRequestError(null);
    } catch {
      setState({ status: "error" });
    }
  }, [profileOffset, selectionOffset]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  async function queue(input: QueueEncodeJobInput) {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setRequestError(null);
    try {
      await queueEncodeJob(input);
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
      isSaving={isSaving}
      requestError={requestError}
      onQueue={(input) => void queue(input)}
      onRetry={() => void load()}
      onSelectionPage={setSelectionOffset}
      onProfilePage={setProfileOffset}
    />
  );
}
