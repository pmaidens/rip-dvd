"use client";

import React, { useEffect, useState } from "react";

import type {
  DashboardArchiveJob,
  DashboardCatalogReviewItem,
  DashboardDetectedDisc,
  DashboardEncodeJob,
  DashboardOpticalDrive,
  DashboardSectionResult,
  DashboardStatus,
} from "../lib/dashboard";
import {
  watchDashboardActivity,
  type DashboardStreamStatus,
} from "../lib/dashboard-activity";
import { displayTerm } from "../lib/display-term";
import { CatalogReviewEditor } from "./catalog-review-editor";
import { EncodingProfilesManager } from "./encoding-profiles";

export type DashboardSectionLoadState<T> =
  | { status: "loading" }
  | DashboardSectionResult<T>;

export interface DashboardLoadState {
  generatedAt?: string;
  opticalDrives: DashboardSectionLoadState<DashboardOpticalDrive>;
  detectedDiscs: DashboardSectionLoadState<DashboardDetectedDisc>;
  archiveJobs: DashboardSectionLoadState<DashboardArchiveJob>;
  encodeJobs: DashboardSectionLoadState<DashboardEncodeJob>;
  catalogReview: DashboardSectionLoadState<DashboardCatalogReviewItem>;
}

function dashboardState(
  status: "loading" | "error",
): DashboardLoadState {
  return {
    opticalDrives: { status },
    detectedDiscs: { status },
    archiveJobs: { status },
    encodeJobs: { status },
    catalogReview: { status },
  };
}

interface SectionProps<T> {
  title: string;
  eyebrow: string;
  state: DashboardSectionLoadState<T>;
  emptyMessage: string;
  renderItem: (item: T) => React.ReactNode;
  className?: string;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    `${seconds}s`,
  ].join(" ");
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatStreamId(id: number): string {
  return `0x${id.toString(16)}`;
}

function streamLanguage(stream: {
  language?: string;
  languageCode?: string;
}): string {
  return stream.language ?? stream.languageCode ?? "Unknown language";
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress" aria-label={`${value}% complete`}>
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function StatusBadge({ value }: { value: DashboardStatus }) {
  return <span className={`status status-${value}`}>{displayTerm(value)}</span>;
}

interface DashboardJobItemProps {
  title: React.ReactNode;
  subtitle: string;
  status: DashboardArchiveJob["status"];
  progressPercent: number;
  action?: React.ReactNode;
}

function DashboardJobItem({
  title,
  subtitle,
  status,
  progressPercent,
  action,
}: DashboardJobItemProps) {
  return (
    <article className="operation-item">
      <div className="item-heading">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <StatusBadge value={status} />
      </div>
      <div className="progress-row">
        <Progress value={progressPercent} />
        <strong>{progressPercent}%</strong>
      </div>
      {status === "failed" ? (
        <p className="job-error">Worker reported a failure.</p>
      ) : null}
      {action}
    </article>
  );
}

function DashboardSection<T>({
  title,
  eyebrow,
  state,
  emptyMessage,
  renderItem,
  className = "",
}: SectionProps<T>) {
  let content: React.ReactNode;
  let sectionState: "loading" | "error" | "empty" | "populated";

  if (state.status === "loading") {
    sectionState = "loading";
    content = (
      <div className="section-message" aria-live="polite">
        <span className="loading-dot" aria-hidden="true" />
        Loading current state…
      </div>
    );
  } else if (state.status === "error") {
    sectionState = "error";
    content = (
      <div className="section-message section-error" role="status">
        Current state is unavailable.
      </div>
    );
  } else {
    if (state.items.length === 0) {
      sectionState = "empty";
      content = <div className="section-message">{emptyMessage}</div>;
    } else {
      sectionState = "populated";
      content = <div className="item-list">{state.items.map(renderItem)}</div>;
    }
  }

  return (
    <section
      className={`dashboard-section ${className}`.trim()}
      data-state={sectionState}
    >
      <header className="section-header">
        <div>
          <p className="section-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </header>
      {content}
    </section>
  );
}

export function DashboardView({
  state,
  onApproveDetectedDisc = () => undefined,
  approvingDetectedDiscId = null,
  onOpenCatalogReview = () => undefined,
  onCatalogReviewPage = () => undefined,
}: {
  state: DashboardLoadState;
  onApproveDetectedDisc?: (id: string) => void;
  approvingDetectedDiscId?: string | null;
  onOpenCatalogReview?: (id: string) => void;
  onCatalogReviewPage?: (offset: number) => void;
}) {
  const catalogReviewPage =
    state.catalogReview.status === "loaded"
      ? state.catalogReview.page
      : undefined;
  return (
    <div className="dashboard-grid">
      <DashboardSection
        title="Optical Drives"
        eyebrow="Hardware"
        state={state.opticalDrives}
        emptyMessage="No Optical Drives have been discovered."
        renderItem={(drive) => (
          <article className="operation-item" key={drive.id}>
            <div className="item-heading">
              <div>
                <h3>{drive.displayName}</h3>
                <p>{drive.hardwareName ?? "Hardware details unavailable"}</p>
              </div>
              <StatusBadge value={drive.state} />
            </div>
            <p className="item-time">
              Last seen {formatTimestamp(drive.lastSeenAt)}
            </p>
          </article>
        )}
      />

      <DashboardSection
        title="Detected Discs"
        eyebrow="Intake"
        state={state.detectedDiscs}
        emptyMessage="No Detected Discs are currently known."
        renderItem={(disc) => (
          <article className="operation-item" key={disc.id}>
            <div className="item-heading">
              <div>
                <h3>{disc.volumeLabel}</h3>
                <p>{disc.opticalDriveName}</p>
              </div>
              <StatusBadge value={disc.status} />
            </div>
            <div className="item-footer">
              <span>{displayTerm(disc.discKind)}</span>
              <span>{formatTimestamp(disc.detectedAt)}</span>
            </div>
            <div className="disc-scan">
              <p className="disc-fingerprint">
                <span>Fingerprint</span>
                <code>{disc.fingerprint}</code>
              </p>
              {disc.titles.length > 0 ? (
                <ol className="dvd-title-map" aria-label="DVD title map">
                  {disc.titles.map((title) => (
                    <li key={title.number}>
                      <div>
                        <strong>Title {title.number}</strong>
                        <span>{formatDuration(title.durationSeconds)}</span>
                      </div>
                      <p>
                        {countLabel(title.chapters, "chapter")} ·{" "}
                        {countLabel(
                          title.audioStreams.length,
                          "audio",
                          "audio",
                        )} ·{" "}
                        {countLabel(title.subtitles.length, "subtitle")}
                      </p>
                      {title.audioStreams.length > 0 ? (
                        <ul className="dvd-stream-list" aria-label="Audio streams">
                          {title.audioStreams.map((stream) => (
                            <li key={stream.id}>
                              {[
                                streamLanguage(stream),
                                stream.format,
                                stream.channels
                                  ? countLabel(stream.channels, "channel")
                                  : undefined,
                                formatStreamId(stream.id),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {title.subtitles.length > 0 ? (
                        <ul
                          className="dvd-stream-list"
                          aria-label="Subtitle streams"
                        >
                          {title.subtitles.map((stream) => (
                            <li key={stream.id}>
                              {[
                                streamLanguage(stream),
                                stream.content,
                                formatStreamId(stream.id),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
            {disc.status === "scanned" ? (
              <button
                type="button"
                disabled={approvingDetectedDiscId !== null}
                onClick={() => onApproveDetectedDisc(disc.id)}
              >
                {approvingDetectedDiscId === disc.id
                  ? "Approving…"
                  : "Approve archive"}
              </button>
            ) : null}
          </article>
        )}
      />

      <DashboardSection
        title="Archive Jobs"
        eyebrow="Preservation queue"
        state={state.archiveJobs}
        emptyMessage="No Archive Jobs are recorded."
        renderItem={(job) => (
          <DashboardJobItem
            key={job.id}
            title={job.discLabel}
            subtitle={job.opticalDriveName}
            status={job.status}
            progressPercent={job.progressPercent}
            action={
              job.status === "failed" ? (
                <button
                  type="button"
                  disabled={approvingDetectedDiscId !== null}
                  onClick={() => onApproveDetectedDisc(job.detectedDiscId)}
                >
                  {approvingDetectedDiscId === job.detectedDiscId
                    ? "Retrying…"
                    : "Retry archive"}
                </button>
              ) : null
            }
          />
        )}
      />

      <DashboardSection
        title="Encode Jobs"
        eyebrow="Media queue"
        className="wide-section"
        state={state.encodeJobs}
        emptyMessage="No Encode Jobs are recorded."
        renderItem={(job) => (
          <DashboardJobItem
            key={job.id}
            title={`${job.mediaTitle}${job.mediaYear ? ` (${job.mediaYear})` : ""}`}
            subtitle={job.encodingProfileName}
            status={job.status}
            progressPercent={job.progressPercent}
          />
        )}
      />

      <DashboardSection
        title="Catalog Review"
        eyebrow="Needs attention"
        className="wide-section"
        state={state.catalogReview}
        emptyMessage="No Original Disc Archives need catalog review."
        renderItem={(archive) => (
          <article className="operation-item review-item" key={archive.id}>
            <div className="item-heading">
              <div>
                <h3>{archive.discLabel}</h3>
                <p>
                  {displayTerm(archive.discKind)} ·{" "}
                  {archive.archiveFormat.toUpperCase()}
                </p>
              </div>
              <span className="attention-mark" aria-label="Needs review">
                Review
              </span>
            </div>
            <p className="item-time">
              Archived {formatTimestamp(archive.archivedAt)}
            </p>
            <button
              type="button"
              onClick={() => onOpenCatalogReview(archive.id)}
            >
              Review catalog
            </button>
          </article>
        )}
      />
      {catalogReviewPage ? (
        <nav
          className="profile-actions wide-section"
          aria-label="Catalog review pages"
        >
          <button
            type="button"
            disabled={!catalogReviewPage.hasPrevious}
            onClick={() =>
              onCatalogReviewPage(
                Math.max(0, catalogReviewPage.offset - catalogReviewPage.limit),
              )}
          >
            Previous pending reviews
          </button>
          <button
            type="button"
            disabled={!catalogReviewPage.hasNext}
            onClick={() =>
              onCatalogReviewPage(
                catalogReviewPage.offset + catalogReviewPage.limit,
              )}
          >
            Next pending reviews
          </button>
        </nav>
      ) : null}
    </div>
  );
}

type DashboardConnection = "loading" | "error" | "loaded";

type DashboardFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestArchiveApproval(
  detectedDiscId: string,
  fetcher: DashboardFetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/archive-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ detectedDiscId }),
  });
  if (!response.ok) {
    throw new Error("Archive approval request failed");
  }
}

export function DashboardConnectionStatus({
  connectionStatus,
  streamStatus,
}: {
  connectionStatus: DashboardConnection;
  streamStatus: DashboardStreamStatus;
}) {
  const label =
    connectionStatus === "loading"
      ? "Refreshing state"
      : connectionStatus === "error"
        ? "Some data unavailable"
        : streamStatus === "live"
          ? "Live updates connected"
          : streamStatus === "reconnecting"
            ? "Live updates reconnecting"
            : "Database connected";

  return (
    <span
      className={`connection-state connection-${connectionStatus}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function OperationsDashboard() {
  const [state, setState] = useState<DashboardLoadState>(
    () => dashboardState("loading"),
  );
  const [requestNumber, setRequestNumber] = useState(0);
  const [streamStatus, setStreamStatus] =
    useState<DashboardStreamStatus>("connecting");
  const [approvingDetectedDiscId, setApprovingDetectedDiscId] = useState<
    string | null
  >(null);
  const [archiveApprovalFailed, setArchiveApprovalFailed] = useState(false);
  const [catalogReviewArchiveId, setCatalogReviewArchiveId] = useState<
    string | null
  >(null);
  const [catalogReviewOffset, setCatalogReviewOffset] = useState(0);

  useEffect(() => {
    setState(dashboardState("loading"));
    setStreamStatus("connecting");
    return watchDashboardActivity({
      catalogReviewOffset,
      onSnapshot: setState,
      onInitialLoadError: () => setState(dashboardState("error")),
      onStreamStatus: setStreamStatus,
    });
  }, [requestNumber, catalogReviewOffset]);

  const sectionStates = [
    state.opticalDrives.status,
    state.detectedDiscs.status,
    state.archiveJobs.status,
    state.encodeJobs.status,
    state.catalogReview.status,
  ];
  const connectionStatus = sectionStates.includes("loading")
    ? "loading"
    : sectionStates.includes("error")
      ? "error"
      : "loaded";

  const approveDetectedDisc = async (detectedDiscId: string) => {
    if (approvingDetectedDiscId !== null) {
      return;
    }
    setApprovingDetectedDiscId(detectedDiscId);
    setArchiveApprovalFailed(false);
    try {
      await requestArchiveApproval(detectedDiscId);
      setRequestNumber((value) => value + 1);
    } catch {
      setArchiveApprovalFailed(true);
    } finally {
      setApprovingDetectedDiscId(null);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="brand">rip-dvd</p>
          <p className="kicker">Operations dashboard</p>
          <h1>Disc operations, at a glance.</h1>
          <p className="dashboard-summary">
            Monitor physical drives, preservation work, encoding, and catalog
            review from one local control plane.
          </p>
        </div>
        <div className="dashboard-controls">
          <DashboardConnectionStatus
            connectionStatus={connectionStatus}
            streamStatus={streamStatus}
          />
          <button
            type="button"
            onClick={() => setRequestNumber((value) => value + 1)}
          >
            {connectionStatus === "error" ? "Try again" : "Refresh"}
          </button>
        </div>
      </header>

      <EncodingProfilesManager />

      {catalogReviewArchiveId ? (
        <CatalogReviewEditor
          key={catalogReviewArchiveId}
          archiveId={catalogReviewArchiveId}
          onClose={() => setCatalogReviewArchiveId(null)}
          onCompleted={() => {
            setCatalogReviewArchiveId(null);
            setRequestNumber((value) => value + 1);
          }}
        />
      ) : null}

      {archiveApprovalFailed ? (
        <p className="job-error" role="status">
          Archive approval failed. Try again.
        </p>
      ) : null}

      <DashboardView
        state={state}
        onApproveDetectedDisc={(id) => void approveDetectedDisc(id)}
        approvingDetectedDiscId={approvingDetectedDiscId}
        onOpenCatalogReview={setCatalogReviewArchiveId}
        onCatalogReviewPage={setCatalogReviewOffset}
      />

      <footer className="dashboard-footer">
        <span>Local control plane</span>
        {state.generatedAt ? (
          <span>Updated {formatTimestamp(state.generatedAt)}</span>
        ) : null}
      </footer>
    </main>
  );
}
