"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import type {
  CatalogReviewArchiveView,
  CompletedCatalogReviewOutcome,
} from "@rip-dvd/data-access";

import type {
  ActionOverviewCategory,
  ActionOverviewSnapshot,
} from "../lib/action-overview";
import type {
  DashboardArchiveJob,
  DashboardArchiveRequest,
  DashboardCatalogReviewItem,
  DashboardDetectedDisc,
  DashboardEncodeJob,
  DashboardOpticalDrive,
  DashboardSectionResult,
  DashboardStatus,
} from "../lib/dashboard";
import { assessArchiveProgress } from "../lib/archive-progress-health";
import {
  watchDashboardActivity,
  type DashboardStreamStatus,
} from "../lib/dashboard-activity";
import { archiveIntegrityLabel } from "../lib/archive-integrity";
import { displayTerm } from "../lib/display-term";
import { isTerminalEncodeJobStatus } from "../lib/encode-job-status";
import { ArchiveIntegrityDescription } from "./archive-integrity-description";
import { ArchiveBoundaryDescription } from "./archive-boundary-description";
import { CatalogReviewEditor } from "./catalog-review-editor";
import { InvestigationPanel } from "./investigation-panel";
import {
  cancelEncodeJob,
  EncodeJobsManager,
  retryEncodeJob,
} from "./encode-jobs";
import { EncodingProfilesManager } from "./encoding-profiles";
import { FilesystemVerificationInventory } from "./filesystem-verification-inventory";
import {
  FilesystemVerificationResult,
  type FilesystemVerificationDisplay,
} from "./filesystem-verification-result";

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

export type FilesystemVerificationTarget =
  | "original_disc_archive"
  | "encode_job_output";

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

export function catalogReviewActivityRevision(
  state: DashboardLoadState,
  archiveId: string,
): string {
  const archiveRevision = state.catalogReview.status === "loaded"
    ? state.catalogReview.items.find(({ id }) => id === archiveId)
        ?.activityRevision ?? null
    : state.catalogReview.status;
  const correctedJobRevisions = state.encodeJobs.status === "loaded"
    ? state.encodeJobs.items
      .filter((job) =>
        job.discSelectionCorrection !== undefined ||
        job.correctedReplacement !== undefined
      )
      .map((job) => [
        job.id,
        job.activityRevision ?? null,
        job.status,
        job.correctedReplacement?.predecessorReady ?? null,
      ])
    : state.encodeJobs.status;
  return JSON.stringify([archiveRevision, correctedJobRevisions]);
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

function Progress({ value, label = `${value}% complete` }: { value: number; label?: string }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function IndeterminateProgress({ label }: { label: string }) {
  return (
    <div className="progress progress-indeterminate" role="progressbar" aria-label={label}>
      <span />
    </div>
  );
}

function StatusBadge({ value }: { value: DashboardStatus }) {
  return <span className={`status status-${value}`}>{displayTerm(value)}</span>;
}

function toFilesystemVerificationDisplay({
  verificationStatus,
  verificationMessage,
  verifiedAt,
}: Pick<
  DashboardEncodeJob,
  "verificationStatus" | "verificationMessage" | "verifiedAt"
>): FilesystemVerificationDisplay {
  return {
    status: verificationStatus ?? null,
    message: verificationMessage ?? null,
    verifiedAt: verifiedAt ?? null,
  };
}

interface DashboardJobItemProps {
  title: React.ReactNode;
  subtitle: string;
  status: DashboardStatus;
  progressPercent: number;
  progressDetail?: string | null;
  failureDetail?: string | null;
  failureAction?: React.ReactNode;
  annotation?: React.ReactNode;
  action?: React.ReactNode;
  verification?: FilesystemVerificationDisplay;
}

function DashboardJobItem({
  title,
  subtitle,
  status,
  progressPercent,
  progressDetail,
  failureDetail,
  failureAction,
  annotation,
  action,
  verification,
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
      {progressDetail ? (
        <p className="job-progress-detail" aria-live="polite">
          {progressDetail}
        </p>
      ) : null}
      {status === "failed" ? (
        failureAction ?? (
          <details className="job-failure">
            <summary>Worker reported a failure.</summary>
            <div className="job-failure-detail">
              <strong>Failure details</strong>
              <p>{failureDetail ?? "No additional details were recorded."}</p>
            </div>
          </details>
        )
      ) : null}
      {annotation}
      {verification ? <FilesystemVerificationResult {...verification} /> : null}
      {action}
    </article>
  );
}

function encodeProgressDetail(job: DashboardEncodeJob): string | null {
  if (
    job.status === "queued" &&
    job.correctedReplacement?.predecessorStatus !== undefined &&
    job.correctedReplacement.predecessorReady !== true
  ) {
    return "Waiting for previous encode to stop";
  }
  if (
    job.status === "queued" &&
    job.correctedReplacement?.predecessorReady === true
  ) {
    return "Ready for encode";
  }
  if (job.status === "cancellation_requested") {
    return "Waiting for HandBrake to stop safely";
  }
  if (job.status !== "running" || job.progressPhase === null) {
    return null;
  }
  const phase = {
    scanning: "Scanning titles",
    previewing: "Scanning previews",
    encoding: "Encoding",
  }[job.progressPhase];
  if (job.progressEtaSeconds === null) {
    return phase;
  }
  const hours = Math.floor(job.progressEtaSeconds / 3_600);
  const minutes = Math.floor((job.progressEtaSeconds % 3_600) / 60);
  const seconds = job.progressEtaSeconds % 60;
  const eta = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    hours === 0 && seconds > 0 ? `${seconds}s` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `${phase} · ETA ${eta || "0s"}`;
}

function archiveProgressDetail(job: DashboardArchiveJob): string | null {
  if (job.status !== "running") {
    return null;
  }
  const phase = {
    preparing: "Preparing the disc for archiving",
    copying: "Copying the disc image",
    verifying: "Verifying the disc image",
    finalizing: "Saving the archive",
  }[job.progressPhase];
  if (job.progressPhase === "preparing") {
    return `${phase} · Estimate available once copying starts`;
  }
  if (job.progressPhase === "verifying") {
    return `${phase} · Copy complete; finishing time varies`;
  }
  if (job.progressPhase === "finalizing") {
    return `${phase} · Copy complete; nearly done`;
  }
  if (job.progressEtaSeconds == null) {
    return `${phase} · Calculating time remaining…`;
  }
  return `${phase} · about ${formatDuration(job.progressEtaSeconds)} of copying remaining`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function inspectionReason(reason: DashboardOpticalDrive["currentInspection"] extends infer T
  ? T extends { reasonCode: infer R } ? R : never
  : never): string {
  return ({
    no_medium: "No disc is present",
    media_changed: "The disc was removed or replaced",
    drive_identity_changed: "The Optical Drive changed",
    drive_unavailable: "The Optical Drive is unavailable",
    drive_not_ready: "The Optical Drive is not ready",
    metadata_read_failed: "Disc metadata could not be read",
    invalid_metadata: "The disc metadata is invalid",
    content_size_failed: "The disc size could not be read",
    content_read_failed: "The disc content could not be read",
    invalid_content: "The disc content is invalid",
    worker_interrupted: "The inspection worker was interrupted",
    operator_cancelled: "Inspection was cancelled",
    unknown: "Inspection failed",
  } as Record<string, string>)[reason ?? "unknown"] ?? "Inspection failed";
}

function useCurrentTime(intervalMs: number): number {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => setCurrentTime(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return currentTime;
}

function formatProgressAge(durationSeconds: number): string {
  const totalMinutes = Math.floor(durationSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function ArchiveJobItem({
  job,
  busy,
  onCancel,
  onInvestigate,
}: {
  job: DashboardArchiveJob;
  busy: boolean;
  onCancel: (archiveRequestId: string) => void;
  onInvestigate: (
    archiveJobId: DashboardArchiveJob["id"],
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const currentTime = useCurrentTime(job.status === "running" ? 5_000 : 0);
  const progressHealth = job.status === "running"
    ? assessArchiveProgress(job, currentTime)
    : null;
  const investigation = job.investigation;

  return (
    <DashboardJobItem
      title={job.discLabel}
      subtitle={job.opticalDriveName}
      status={job.status}
      progressPercent={job.progressPercent}
      progressDetail={archiveProgressDetail(job)}
      failureAction={investigation ? (
        <button
          className="investigate-action"
          type="button"
          onClick={(event) =>
            onInvestigate(job.id, event.currentTarget)}
        >
          Investigate
        </button>
      ) : null}
      annotation={
        progressHealth?.status === "not_advancing" ? (
          <div className="archive-progress-warning" role="alert">
            <strong>Not advancing</strong>
            <p>
              No data copied for {formatProgressAge(progressHealth.durationSeconds)}
            </p>
            <p>The Optical Drive may be retrying an unreadable area.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => onCancel(job.archiveRequestId)}
            >
              {busy ? "Cancelling…" : "Cancel archive"}
            </button>
          </div>
        ) : null
      }
      action={
        <p className="item-time">
          Attempt {job.attemptOrdinal} · {job.attemptOrdinal} total
        </p>
      }
    />
  );
}

function DiscInspectionItem({
  inspection,
  onRetry,
  onInvestigate,
  busy,
}: {
  inspection: NonNullable<DashboardOpticalDrive["currentInspection"]>;
  onRetry(id: string): void;
  onInvestigate(
    inspectionId: string,
    trigger: HTMLButtonElement,
    fallback: HTMLElement | null,
  ): void;
  busy: boolean;
}) {
  const now = useCurrentTime(
    inspection.status !== "running"
      ? 0
      : inspection.phase === "retry_wait"
        ? 1_000
        : 5_000,
  );
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(inspection.phaseStartedAt).getTime()) / 5_000) * 5,
  );
  const percent = inspection.totalBytes && inspection.bytesHashed !== null
    ? Math.min(
        100,
        Math.floor(inspection.bytesHashed * 100 / inspection.totalBytes),
      )
    : 0;
  const hashDetail = inspection.bytesPerSecond === null
    ? "Calculating speed and time remaining…"
    : `${formatBytes(inspection.bytesPerSecond)}/s · about ${formatDuration(inspection.etaSeconds ?? 0)} remaining`;
  const retryAttempt = inspection.consecutiveFailureCount === 0
    ? "Manual retry queued"
    : `Attempt ${inspection.consecutiveFailureCount + 1} of 5`;
  const retrySeconds = Math.max(
    0,
    Math.ceil(
      ((inspection.retryAt
        ? new Date(inspection.retryAt).getTime()
        : now) - now) / 1_000,
    ),
  );
  const findings =
    inspection.archiveWorkFulfilled || inspection.titleCount === null
      ? null
      : [
          inspection.volumeLabel,
          countLabel(inspection.titleCount, "title"),
          countLabel(inspection.chapterCount ?? 0, "chapter"),
          `${inspection.audioStreamCount ?? 0} audio`,
          countLabel(inspection.subtitleStreamCount ?? 0, "subtitle"),
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <section
      className="nested-operation disc-inspection"
      aria-label="Disc Inspection"
    >
      <div className="item-heading">
        <div>
          <strong>Disc Inspection</strong>
          {findings ? <p>{findings}</p> : null}
        </div>
        <StatusBadge value={inspection.status} />
      </div>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">
        Disc Inspection {displayTerm(inspection.status)} ·{" "}
        {displayTerm(inspection.phase)}
      </span>
      <div>
        {inspection.status === "running" && inspection.phase === "settling" ? (
          <p>
            Settling inserted DVD · {formatDuration(elapsedSeconds)} elapsed
          </p>
        ) : inspection.status === "running" && inspection.phase === "reading_metadata" ? (
          <>
            <IndeterminateProgress label="Reading DVD metadata" />
            <p>
              Reading titles, chapters, audio, and subtitles ·{" "}
              {formatDuration(elapsedSeconds)} elapsed
            </p>
          </>
        ) : inspection.status === "running" && inspection.phase === "hashing_content" ? (
          <>
            <div className="progress-row">
              <Progress value={percent} label="Hashing DVD content" />
              <strong>{percent}%</strong>
            </div>
            <p>
              {formatBytes(inspection.bytesHashed ?? 0)} of{" "}
              {formatBytes(inspection.totalBytes ?? 0)} · {hashDetail}
            </p>
          </>
        ) : inspection.status === "running" && inspection.phase === "retry_wait" ? (
          <p>
            {inspectionReason(inspection.reasonCode)} · {retryAttempt} ·
            retrying in {retrySeconds}s
          </p>
        ) : inspection.status === "running" ? (
          <p>Confirming the inserted disc…</p>
        ) : inspection.status === "completed" &&
          !inspection.archiveWorkFulfilled ? (
          <>
            <div className="progress-row">
              <Progress value={100} label="DVD content inspected" />
              <strong>100%</strong>
            </div>
            <p>Inspection complete · ready for archive work</p>
          </>
        ) : inspection.status === "completed" ? (
          <p>Inspection complete</p>
        ) : inspection.status === "failed" &&
          inspection.manualRetryRequested ? (
          <p>Retry requested · waiting for the worker to verify this insertion</p>
        ) : (
          <p>{inspectionReason(inspection.reasonCode)}</p>
        )}
      </div>
      {inspection.status === "failed" ? (
        <div className="operation-actions">
          {inspection.investigation ? (
            <button
              className="investigate-action"
              type="button"
              onClick={(event) =>
                onInvestigate(
                  inspection.id,
                  event.currentTarget,
                  event.currentTarget.closest<HTMLElement>(
                    "article.operation-item",
                  ),
                )}
            >
              Investigate
            </button>
          ) : null}
          {!inspection.manualRetryRequested ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRetry(inspection.id)}
            >
              {busy ? "Retrying…" : "Retry inspection"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ArchiveRequestItem({
  request,
  onCancel,
  onRetry,
  busy,
}: {
  request: DashboardArchiveRequest;
  onCancel(id: string): void;
  onRetry(id: string): void;
  busy: boolean;
}) {
  const detail = {
    pending: "Waiting for this disc to be inserted and inspected",
    running: "Archiving now",
    needs_attention:
      request.latestFailureDetail ?? "The latest attempt needs attention",
    cancellation_requested: "Cancellation in progress",
    fulfilled: "Archive request fulfilled",
    cancelled: "Archive request cancelled",
  }[request.status];
  return (
    <section
      className="nested-operation archive-request"
      aria-label="Archive Request"
    >
      <div className="item-heading">
        <div>
          <strong>Archive Request</strong>
          <p>{detail}</p>
        </div>
        <StatusBadge value={request.status} />
      </div>
      {request.status === "pending" ||
      request.status === "running" ||
      request.status === "needs_attention" ? (
        <div className="operation-actions">
          {request.status === "needs_attention" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRetry(request.id)}
            >
              {busy ? "Retrying…" : "Retry archive"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(request.id)}
          >
            {busy
              ? "Working…"
              : request.status === "running"
                ? "Cancel archive"
                : "Cancel request"}
          </button>
        </div>
      ) : null}
    </section>
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

function archivedOrCancelledRequestDiscsLast(
  state: DashboardSectionLoadState<DashboardDetectedDisc>,
): DashboardSectionLoadState<DashboardDetectedDisc> {
  if (state.status !== "loaded") {
    return state;
  }
  const shouldMoveToEnd = (disc: DashboardDetectedDisc) =>
    disc.status === "archived" || disc.archiveRequest?.status === "cancelled";
  return {
    ...state,
    items: [
      ...state.items.filter((disc) => !shouldMoveToEnd(disc)),
      ...state.items.filter(shouldMoveToEnd),
    ],
  };
}

function DetectedDiscDetails({
  disc,
  collapseInspection = true,
}: {
  disc: DashboardDetectedDisc;
  collapseInspection?: boolean;
}) {
  const inspectionDetails = (
    <>
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
                {countLabel(title.audioStreams.length, "audio", "audio")} ·{" "}
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
                <ul className="dvd-stream-list" aria-label="Subtitle streams">
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
    </>
  );

  return (
    <>
      <div className="item-footer">
        <span>{displayTerm(disc.discKind)}</span>
        <span>{formatTimestamp(disc.detectedAt)}</span>
      </div>
      {collapseInspection ? (
        <details className="disc-inspection">
          <summary className="disc-inspection-summary">
            <span>Disc Inspection details</span>
            <span>{countLabel(disc.titles.length, "title")}</span>
          </summary>
          <div className="disc-inspection-details">{inspectionDetails}</div>
        </details>
      ) : (
        <div className="disc-inspection">{inspectionDetails}</div>
      )}
    </>
  );
}

function DetectedDiscItem({
  disc,
  approvingDetectedDiscId,
  busyWorkflowId,
  onCancelArchiveRequest,
  onApproveDetectedDisc,
  onRetryArchiveRequest,
}: {
  disc: DashboardDetectedDisc;
  approvingDetectedDiscId: string | null;
  busyWorkflowId: string | null;
  onCancelArchiveRequest: (id: string) => void;
  onApproveDetectedDisc: (id: string) => void;
  onRetryArchiveRequest: (id: string) => void;
}) {
  if (disc.status === "archived") {
    return (
      <article className="operation-item archived-disc-item">
        <details className="archived-disc">
          <summary className="archived-disc-summary">
            <span className="archived-disc-identity">
              <strong>{disc.volumeLabel}</strong>
              <span>{disc.opticalDriveName}</span>
            </span>
            <StatusBadge value={disc.status} />
          </summary>
          <div className="archived-disc-details">
            <DetectedDiscDetails disc={disc} collapseInspection={false} />
          </div>
        </details>
      </article>
    );
  }

  const canRequestArchive =
    disc.status === "scanned" ||
    (disc.status === "approved" &&
      disc.archiveRequest?.status === "cancelled");
  const isReplacementRequest = disc.archiveRequest?.status === "cancelled";

  return (
    <article className="operation-item">
      <div className="item-heading">
        <div>
          <h3>{disc.volumeLabel}</h3>
          <p>{disc.opticalDriveName}</p>
        </div>
        <StatusBadge value={disc.status} />
      </div>
      <DetectedDiscDetails disc={disc} />
      {canRequestArchive ? (
        <button
          type="button"
          disabled={approvingDetectedDiscId !== null}
          onClick={() => onApproveDetectedDisc(disc.id)}
        >
          {approvingDetectedDiscId === disc.id
            ? "Requesting…"
            : isReplacementRequest
              ? "Request archive again"
              : "Request archive"}
        </button>
      ) : null}
      {disc.archiveRequest ? (
        <ArchiveRequestItem
          request={disc.archiveRequest}
          onCancel={onCancelArchiveRequest}
          onRetry={onRetryArchiveRequest}
          busy={busyWorkflowId === disc.archiveRequest.id}
        />
      ) : null}
    </article>
  );
}

type AttentionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; count: number; items: ActionOverviewCategory["items"] };

export type ActionOverviewLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; snapshot: ActionOverviewSnapshot };

const ACTION_OVERVIEW_REFRESH_INTERVAL_MS = 30_000;

export async function requestActionOverview(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ActionOverviewSnapshot> {
  const response = await fetcher("/api/action-overview", {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error("Action overview request failed");
  }
  return (await response.json()) as ActionOverviewSnapshot;
}

function attentionState(
  state: ActionOverviewLoadState,
  category: keyof Omit<ActionOverviewSnapshot, "generatedAt">,
): AttentionState {
  return state.status === "loaded"
    ? { status: "loaded", ...state.snapshot[category] }
    : state;
}

function AttentionCard({
  eyebrow,
  title,
  description,
  href,
  linkLabel,
  state,
}: {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  state: AttentionState;
}) {
  const hasAttention = state.status === "loaded" && state.count > 0;
  return (
    <article
      className={`attention-card${hasAttention ? " attention-card-active" : ""}`}
      data-state={
        state.status === "loaded"
          ? hasAttention
            ? "attention"
            : "clear"
          : state.status
      }
    >
      <div className="attention-card-heading">
        <div>
          <p className="section-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        {state.status === "loaded" ? (
          <strong className="attention-count">{state.count}</strong>
        ) : null}
      </div>
      <p className="attention-description">{description}</p>
      {state.status === "loading" ? (
        <p className="attention-state">
          <span className="loading-dot" aria-hidden="true" />
          Checking current state…
        </p>
      ) : state.status === "error" ? (
        <p className="attention-state attention-unavailable">
          Current state unavailable
        </p>
      ) : state.count === 0 ? (
        <p className="attention-state attention-clear">No action needed</p>
      ) : (
        <ul className="attention-items">
          {state.items.map((item) => (
            <li key={item.id}>{item.label}</li>
          ))}
          {state.count > state.items.length ? (
            <li>+{state.count - state.items.length} more</li>
          ) : null}
        </ul>
      )}
      <Link className="attention-link" href={href}>
        {linkLabel}
        <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function ActionOverview({ state }: { state: ActionOverviewLoadState }) {
  const detectedDiscs = attentionState(state, "discApprovals");
  const archiveRequests = attentionState(
    state,
    "archiveRequestsNeedingAttention",
  );
  const encodeJobs = attentionState(state, "failedEncodes");
  const catalogReview = attentionState(state, "catalogReviews");
  const filesystemProblems = attentionState(state, "filesystemProblems");

  return (
    <section className="attention-overview" aria-labelledby="attention-title">
      <header className="attention-overview-header">
        <div>
          <p className="section-eyebrow">Operator attention</p>
          <h2 id="attention-title">What needs action</h2>
        </div>
        <p>Only work that needs a decision, retry, review, or repair appears here.</p>
      </header>
      <div className="attention-grid">
        <AttentionCard
          eyebrow="Disc intake"
          title="Discs awaiting approval"
          description="Scanned discs that are ready for an archive decision."
          href="/discs"
          linkLabel="Open disc intake"
          state={detectedDiscs}
        />
        <AttentionCard
          eyebrow="Preservation"
          title="Archive requests"
          description="Requests whose latest attempt needs a retry or has stopped advancing."
          href="/discs"
          linkLabel="Open archive requests"
          state={archiveRequests}
        />
        <AttentionCard
          eyebrow="Media queue"
          title="Failed encodes"
          description="Encoding jobs that require an operator retry."
          href="/encoding"
          linkLabel="Open encoding"
          state={encodeJobs}
        />
        <AttentionCard
          eyebrow="Library metadata"
          title="Catalog reviews"
          description="Archived discs waiting for title and selection review."
          href="/catalog"
          linkLabel="Open catalog review"
          state={catalogReview}
        />
        <AttentionCard
          eyebrow="Recorded files"
          title="Filesystem problems"
          description="Recorded checks that found a missing or inaccessible file."
          href="/verification"
          linkLabel="Open verification"
          state={filesystemProblems}
        />
      </div>
    </section>
  );
}

export function DashboardView({
  state,
  section = "all",
  catalogReviewView = "needs_review",
  catalogReviewQuery = "",
  catalogReviewOutcome,
  onApproveDetectedDisc = () => undefined,
  approvingDetectedDiscId = null,
  onCancelArchiveRequest = () => undefined,
  onRetryArchiveRequest = () => undefined,
  onRetryDiscInspection = () => undefined,
  busyWorkflowId = null,
  onRequeueEncodeJob = () => undefined,
  requeueingEncodeJobId = null,
  onCancelEncodeJob = () => undefined,
  cancellingEncodeJobId = null,
  onOpenCatalogReview = () => undefined,
  onCatalogReviewPage = () => undefined,
  onCatalogReviewView = () => undefined,
  onCatalogReviewSearch = () => undefined,
  onVerifyFilesystem = () => undefined,
  verifyingFilesystemTarget = null,
}: {
  state: DashboardLoadState;
  section?: "all" | "discs" | "encoding" | "catalog";
  catalogReviewView?: CatalogReviewArchiveView;
  catalogReviewQuery?: string;
  catalogReviewOutcome?: CompletedCatalogReviewOutcome;
  onApproveDetectedDisc?: (id: string) => void;
  approvingDetectedDiscId?: string | null;
  onCancelArchiveRequest?: (id: string) => void;
  onRetryArchiveRequest?: (id: string) => void;
  onRetryDiscInspection?: (id: string) => void;
  busyWorkflowId?: string | null;
  onRequeueEncodeJob?: (id: DashboardEncodeJob["id"]) => void;
  requeueingEncodeJobId?: DashboardEncodeJob["id"] | null;
  onCancelEncodeJob?: (id: DashboardEncodeJob["id"]) => void;
  cancellingEncodeJobId?: DashboardEncodeJob["id"] | null;
  onOpenCatalogReview?: (id: string) => void;
  onCatalogReviewPage?: (cursor: string | null) => void;
  onCatalogReviewView?: (view: CatalogReviewArchiveView) => void;
  onCatalogReviewSearch?: (
    query: string,
    outcome?: CompletedCatalogReviewOutcome,
  ) => void;
  onVerifyFilesystem?: (target: FilesystemVerificationTarget, id: string) => void;
  verifyingFilesystemTarget?: string | null;
}) {
  const [activeInvestigation, setActiveInvestigation] = useState<
    | {
        kind: "archive-job" | "disc-inspection";
        subjectId: string;
        trigger: HTMLButtonElement;
        fallback: HTMLElement | null;
      }
    | {
        kind: "encode-job";
        subjectId: DashboardEncodeJob["id"];
        trigger: HTMLButtonElement;
        fallback: null;
      }
    | null
  >(null);
  const catalogReviewPage =
    state.catalogReview.status === "loaded"
      ? state.catalogReview.page
      : undefined;
  const archiveJobGroups = state.archiveJobs.status !== "loaded"
    ? state.archiveJobs
    : {
        status: "loaded" as const,
        items: [...state.archiveJobs.items.reduce((groups, job) => {
          const attempts = groups.get(job.archiveRequestId) ?? [];
          attempts.push(job);
          groups.set(job.archiveRequestId, attempts);
          return groups;
        }, new Map<string, DashboardArchiveJob[]>()).entries()].map(
          ([archiveRequestId, attempts]) => {
            const ordered = attempts.toSorted(
              (left, right) => right.attemptOrdinal - left.attemptOrdinal,
            );
            return {
              archiveRequestId,
              latest: ordered[0]!,
              older: ordered.slice(1),
            };
          },
        ),
      };
  const activeInvestigationResolution = activeInvestigation === null
    ? { investigations: undefined, sourceLoaded: true }
    : activeInvestigation.kind === "archive-job"
      ? {
          investigations: state.archiveJobs.status === "loaded"
            ? [state.archiveJobs.items.find(
                (job) => job.id === activeInvestigation.subjectId,
              )?.investigation].filter(
                (investigation) => investigation !== undefined,
              )
            : undefined,
          sourceLoaded: state.archiveJobs.status === "loaded",
        }
      : activeInvestigation.kind === "disc-inspection"
        ? {
            investigations: state.opticalDrives.status === "loaded"
              ? [state.opticalDrives.items
                  .find(
                    (drive) =>
                      drive.currentInspection?.id ===
                        activeInvestigation.subjectId,
                  )
                  ?.currentInspection?.investigation].filter(
                    (investigation) => investigation !== undefined,
                  )
              : undefined,
            sourceLoaded: state.opticalDrives.status === "loaded",
          }
        : {
            investigations: state.encodeJobs.status === "loaded"
              ? state.encodeJobs.items.find(
                  (job) => job.id === activeInvestigation.subjectId,
                )?.investigations
              : undefined,
            sourceLoaded: state.encodeJobs.status === "loaded",
          };
  const activeInvestigations = activeInvestigationResolution.investigations;
  const activeInvestigationDetails = activeInvestigations?.[0];
  useEffect(() => {
    if (
      activeInvestigation !== null &&
      activeInvestigationResolution.sourceLoaded &&
      activeInvestigationDetails === undefined
    ) {
      setActiveInvestigation(null);
    }
  }, [
    activeInvestigation,
    activeInvestigationDetails,
    activeInvestigationResolution.sourceLoaded,
  ]);
  return (
    <>
      <div className={`dashboard-grid dashboard-grid-${section}`}>
      {section === "all" || section === "discs" ? (
        <>
          <DashboardSection
        title="Optical Drives"
        eyebrow="Hardware"
        state={state.opticalDrives}
        emptyMessage="No Optical Drives have been discovered."
        renderItem={(drive) => (
          <article className="operation-item" key={drive.id} tabIndex={-1}>
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
            {drive.currentInspection ? (
              <DiscInspectionItem
                inspection={drive.currentInspection}
                onRetry={onRetryDiscInspection}
                onInvestigate={(subjectId, trigger, fallback) =>
                  setActiveInvestigation({
                    kind: "disc-inspection",
                    subjectId,
                    trigger,
                    fallback,
                  })}
                busy={busyWorkflowId === drive.currentInspection.id}
              />
            ) : drive.state === "ready" ? (
              <p className="nested-operation">Ready for a disc</p>
            ) : null}
          </article>
        )}
      />

          <DashboardSection
            title="Detected Discs"
            eyebrow="Intake"
            state={archivedOrCancelledRequestDiscsLast(state.detectedDiscs)}
            emptyMessage="No discs are currently in an Optical Drive."
            renderItem={(disc) => (
              <DetectedDiscItem
                key={disc.id}
                disc={disc}
                approvingDetectedDiscId={approvingDetectedDiscId}
                busyWorkflowId={busyWorkflowId}
                onCancelArchiveRequest={onCancelArchiveRequest}
                onApproveDetectedDisc={onApproveDetectedDisc}
                onRetryArchiveRequest={onRetryArchiveRequest}
              />
            )}
          />

          <DashboardSection
        title="Archive Jobs"
        eyebrow="Preservation queue"
        state={archiveJobGroups}
        emptyMessage="No Archive Jobs exist for discs currently in a drive."
        renderItem={(group) => (
          <div key={group.archiveRequestId} className="archive-attempt-group">
            <ArchiveJobItem
              job={group.latest}
              busy={busyWorkflowId === group.archiveRequestId}
              onCancel={onCancelArchiveRequest}
              onInvestigate={(archiveJobId, trigger) =>
                setActiveInvestigation({
                  kind: "archive-job",
                  subjectId: archiveJobId,
                  trigger,
                  fallback: null,
                })}
            />
            {group.older.length > 0 ? (
              <details className="archive-attempt-history">
                <summary>
                  {group.older.length} older{" "}
                  {group.older.length === 1 ? "attempt" : "attempts"}
                </summary>
                <ol>
                  {group.older.map((attempt) => {
                    const investigation = attempt.investigation;
                    return (
                      <li key={attempt.id}>
                        <span>
                          Attempt {attempt.attemptOrdinal} ·{" "}
                          {displayTerm(attempt.status)}
                        </span>
                        {investigation ? (
                          <button
                            type="button"
                            onClick={(event) =>
                              setActiveInvestigation({
                                kind: "archive-job",
                                subjectId: attempt.id,
                                trigger: event.currentTarget,
                                fallback: null,
                              })}
                          >
                            Investigate
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </details>
            ) : null}
          </div>
        )}
      />

        </>
      ) : null}

      {section === "all" || section === "encoding" ? (
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
            progressDetail={encodeProgressDetail(job)}
            failureDetail={job.failureDetail}
            failureAction={job.investigations?.[0] ? (
              <button
                className="investigate-action"
                type="button"
                onClick={(event) =>
                  setActiveInvestigation({
                    kind: "encode-job",
                    subjectId: job.id,
                    trigger: event.currentTarget,
                    fallback: null,
                  })}
              >
                Investigate
              </button>
            ) : undefined}
            annotation={job.discSelectionCorrection || job.correctedReplacement ? (
              <div className="selection-correction-history">
                {job.correctedReplacement?.predecessorId ? (
                  <>
                    <strong>Corrected replacement encode</strong>
                    <p>Replaces Encode Job {job.correctedReplacement.predecessorId}</p>
                  </>
                ) : null}
                {job.correctedReplacement?.successorId ? (
                  <>
                    <strong>Superseded by corrected encode</strong>
                    <p>Replacement Encode Job {job.correctedReplacement.successorId}</p>
                  </>
                ) : null}
                {job.discSelectionCorrection ? <>
                <strong>Disc Selection corrected</strong>
                <p>
                  Superseded by {job.discSelectionCorrection.correctedMediaTitle}
                </p>
                {job.discSelectionCorrection.reason ? (
                  <p>{job.discSelectionCorrection.reason}</p>
                ) : null}
                </> : null}
                {job.correctedReplacement?.priorOutput?.state === "protected" ? (
                  <p>Prior final remains published while correction runs.</p>
                ) : null}
                {job.correctedReplacement?.priorOutput?.state === "retained" ? (
                  <p>
                    Prior final retained · {job.correctedReplacement.priorOutput
                      .cleanupEligible ? "Cleanup eligible" : "Not cleanup eligible"}
                  </p>
                ) : null}
              </div>
            ) : null}
            verification={toFilesystemVerificationDisplay(job)}
            action={
              <div className="operation-actions">
                {job.status !== "failed" && job.investigations?.[0] ? (
                  <button
                    type="button"
                    onClick={(event) =>
                      setActiveInvestigation({
                        kind: "encode-job",
                        subjectId: job.id,
                        trigger: event.currentTarget,
                        fallback: null,
                      })}
                  >
                    Investigate prior failures
                  </button>
                ) : null}
                {job.status === "queued" || job.status === "running" ? (
                  <button
                    type="button"
                    disabled={
                      cancellingEncodeJobId !== null ||
                      requeueingEncodeJobId !== null
                    }
                    onClick={() => onCancelEncodeJob(job.id)}
                  >
                    {cancellingEncodeJobId === job.id
                      ? "Cancelling…"
                      : job.status === "running"
                        ? "Request cancellation"
                        : "Cancel queued encode"}
                  </button>
                ) : null}
                {isTerminalEncodeJobStatus(job.status) &&
                    job.requeueable !== false ? (
                  <button
                    type="button"
                    disabled={
                      requeueingEncodeJobId !== null ||
                      cancellingEncodeJobId !== null
                    }
                    onClick={() => onRequeueEncodeJob(job.id)}
                  >
                    {requeueingEncodeJobId === job.id
                      ? job.status === "failed"
                        ? "Retrying…"
                        : job.status === "completed"
                          ? "Re-encoding…"
                          : "Requeueing…"
                      : job.status === "failed"
                        ? "Retry encode"
                        : job.status === "completed"
                          ? "Re-encode"
                          : "Requeue encode"}
                  </button>
                ) : null}
                {isTerminalEncodeJobStatus(job.status) &&
                    job.requeueable === false ? (
                  <p className="job-progress-detail">
                    Requeue requires an active Disc Selection with completed
                    Catalog Review.
                  </p>
                ) : null}
                <button
                  type="button"
                  disabled={verifyingFilesystemTarget !== null}
                  onClick={() =>
                    onVerifyFilesystem("encode_job_output", job.id)
                  }
                >
                  {verifyingFilesystemTarget === `encode_job_output:${job.id}`
                    ? "Verifying output…"
                    : "Verify output file"}
                </button>
              </div>
            }
          />
        )}
        />
      ) : null}

      {section === "all" || section === "catalog" ? (
        <>
          <div className="catalog-review-browse-controls wide-section">
            <div
              className="profile-actions"
              role="group"
              aria-label="Catalog Review view"
            >
              <button
                type="button"
                aria-pressed={catalogReviewView === "needs_review"}
                onClick={() => onCatalogReviewView("needs_review")}
              >
                Needs review
              </button>
              <button
                type="button"
                aria-pressed={catalogReviewView === "reviewed"}
                onClick={() => onCatalogReviewView("reviewed")}
              >
                Reviewed
              </button>
            </div>
            {catalogReviewView === "reviewed" ? (
              <form
                className="catalog-review-search"
                aria-label="Search reviewed archives"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const query = String(form.get("query") ?? "").trim();
                  const outcome = String(form.get("outcome") ?? "");
                  onCatalogReviewSearch(
                    query,
                    outcome === "reviewed_with_selections" ||
                        outcome === "archive_only"
                      ? outcome
                      : undefined,
                  );
                }}
              >
                <label>
                  Disc label or mapped Media Item title
                  <input
                    type="search"
                    name="query"
                    maxLength={256}
                    defaultValue={catalogReviewQuery}
                  />
                </label>
                <label>
                  Outcome
                  <select
                    name="outcome"
                    defaultValue={catalogReviewOutcome ?? ""}
                  >
                    <option value="">All reviewed outcomes</option>
                    <option value="reviewed_with_selections">
                      Reviewed with selections
                    </option>
                    <option value="archive_only">Archive only</option>
                  </select>
                </label>
                <button type="submit">Search reviewed archives</button>
              </form>
            ) : null}
          </div>
          <DashboardSection
            title={catalogReviewView === "reviewed"
              ? "Reviewed Catalog Reviews"
              : "Catalog Review"}
        eyebrow={catalogReviewView === "reviewed" ? "History" : "Needs attention"}
        className="wide-section"
        state={state.catalogReview}
        emptyMessage={catalogReviewView === "reviewed"
          ? "No reviewed Original Disc Archives match these filters."
          : "No Original Disc Archives need catalog review."}
        renderItem={(archive) => (
          <article className="operation-item review-item" key={archive.id}>
            <div className="item-heading">
              <div>
                <h3>{archive.discLabel}</h3>
                <p>
                  {displayTerm(archive.discKind)} ·{" "}
                  {archive.archiveFormat.toUpperCase()}
                </p>
                <p>
                  Archive integrity: {archiveIntegrityLabel(archive.integrity)}
                </p>
                <ArchiveIntegrityDescription {...archive} />
                <ArchiveBoundaryDescription
                  boundaryEvidence={archive.boundaryEvidence}
                />
              </div>
              <span
                className="attention-mark"
                aria-label={catalogReviewView === "reviewed"
                  ? displayTerm(archive.catalogReviewOutcome)
                  : "Needs review"}
              >
                {catalogReviewView === "reviewed"
                  ? displayTerm(archive.catalogReviewOutcome)
                  : "Review"}
              </span>
            </div>
            <p className="item-time">
              {catalogReviewView === "reviewed" && archive.catalogReviewedAt
                ? `Reviewed ${formatTimestamp(archive.catalogReviewedAt)}`
                : `Archived ${formatTimestamp(archive.archivedAt)}`}
            </p>
            {catalogReviewView === "reviewed" ? (
              <p className="catalog-review-summary">
                {archive.mappedMediaItemTitles.length === 0
                  ? "No mapped Media Items"
                  : archive.mappedMediaItemTitles.join(" · ")}
                {archive.mappedMediaItemCount >
                    archive.mappedMediaItemTitles.length
                  ? ` · ${archive.mappedMediaItemCount -
                    archive.mappedMediaItemTitles.length} more`
                  : ""}
              </p>
            ) : null}
            <FilesystemVerificationResult
              {...toFilesystemVerificationDisplay(archive)}
            />
            <div className="operation-actions">
              <button
                type="button"
                onClick={() => onOpenCatalogReview(archive.id)}
              >
                {catalogReviewView === "reviewed" ? "Open review" : "Review catalog"}
              </button>
              <button
                type="button"
                disabled={verifyingFilesystemTarget !== null}
                onClick={() =>
                  onVerifyFilesystem("original_disc_archive", archive.id)
                }
              >
                {verifyingFilesystemTarget ===
                `original_disc_archive:${archive.id}`
                  ? "Verifying archive…"
                  : "Verify archive file"}
              </button>
            </div>
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
            disabled={catalogReviewPage.previousCursor === null}
            onClick={() =>
              onCatalogReviewPage(catalogReviewPage.previousCursor)}
          >
            {catalogReviewView === "reviewed"
              ? "Previous reviewed archives"
              : "Previous pending reviews"}
          </button>
          <button
            type="button"
            disabled={catalogReviewPage.nextCursor === null}
            onClick={() => onCatalogReviewPage(catalogReviewPage.nextCursor)}
          >
            {catalogReviewView === "reviewed"
              ? "Next reviewed archives"
              : "Next pending reviews"}
          </button>
        </nav>
          ) : null}
        </>
      ) : null}
      </div>
      {activeInvestigation && activeInvestigationDetails ? (
        <InvestigationPanel
          investigation={activeInvestigationDetails}
          investigations={activeInvestigations}
          returnFocusTo={activeInvestigation.trigger}
          returnFocusFallback={activeInvestigation.fallback}
          onClose={() => setActiveInvestigation(null)}
        />
      ) : null}
    </>
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
  const response = await fetcher("/api/archive-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ detectedDiscId }),
  });
  if (!response.ok) {
    throw new Error("Archive Request creation failed");
  }
}

async function requestWorkflowMutation(
  path: string,
  method: "POST" | "DELETE",
  fetcher: DashboardFetch = fetch,
): Promise<void> {
  const response = await fetcher(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("Workflow mutation failed");
}

export const requestArchiveRequestCancellation = (id: string) =>
  requestWorkflowMutation(`/api/archive-requests/${encodeURIComponent(id)}`, "DELETE");
export const requestArchiveRequestRetry = (id: string) =>
  requestWorkflowMutation(`/api/archive-requests/${encodeURIComponent(id)}/retry`, "POST");
export const requestDiscInspectionRetry = (id: string) =>
  requestWorkflowMutation(`/api/disc-inspections/${encodeURIComponent(id)}/retry`, "POST");

export async function requestFilesystemVerification(
  target: FilesystemVerificationTarget,
  id: string,
  fetcher: DashboardFetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/filesystem-verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, id }),
  });
  if (!response.ok) {
    throw new Error("Filesystem verification request failed");
  }
}

interface DashboardMutationRunnerOptions<Id extends string> {
  request(id: Id): Promise<void>;
  setBusyId(id: Id | null): void;
  setFailed(failed: boolean): void;
  refresh(): void;
}

function createDashboardMutationRunner<Id extends string>({
  request,
  setBusyId,
  setFailed,
  refresh,
}: DashboardMutationRunnerOptions<Id>): (id: Id) => Promise<void> {
  let inFlight = false;

  return async (id) => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    setBusyId(id);
    setFailed(false);
    try {
      await request(id);
      refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusyId(null);
      inFlight = false;
    }
  };
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

export type OperationsDashboardPage =
  | "overview"
  | "discs"
  | "catalog"
  | "encoding"
  | "verification";

export type EncodingPageTab = "current" | "queue" | "settings";
export type EncodeJobFilter = "in_progress" | "completed";

const encodingPageTabs: ReadonlyArray<{
  id: EncodingPageTab;
  label: string;
}> = [
  { id: "current", label: "Current jobs" },
  { id: "queue", label: "Queue new jobs" },
  { id: "settings", label: "Settings" },
];

function encodeJobFilterForStatus(
  status: DashboardEncodeJob["status"],
): EncodeJobFilter {
  return status === "completed" ? "completed" : "in_progress";
}

export function filterEncodeJobs(
  state: DashboardSectionLoadState<DashboardEncodeJob>,
  filter: EncodeJobFilter,
): DashboardSectionLoadState<DashboardEncodeJob> {
  if (state.status !== "loaded") {
    return state;
  }
  return {
    ...state,
    items: state.items.filter(
      (job) => encodeJobFilterForStatus(job.status) === filter,
    ),
  };
}

function countEncodeJobsByFilter(
  state: DashboardSectionLoadState<DashboardEncodeJob>,
): Record<EncodeJobFilter, number> {
  const counts: Record<EncodeJobFilter, number> = {
    in_progress: 0,
    completed: 0,
  };
  if (state.status === "loaded") {
    for (const job of state.items) {
      counts[encodeJobFilterForStatus(job.status)] += 1;
    }
  }
  return counts;
}

const pageCopy: Record<
  OperationsDashboardPage,
  { kicker: string; title: string; summary: string }
> = {
  overview: {
    kicker: "Operations overview",
    title: "What needs your attention.",
    summary:
      "A focused view of decisions, retries, reviews, and repairs across the local media workflow.",
  },
  discs: {
    kicker: "Disc intake",
    title: "Preserve every disc with confidence.",
    summary:
      "Monitor optical drives, inspect detected titles, approve archives, and recover failed preservation jobs.",
  },
  catalog: {
    kicker: "Catalog review",
    title: "Turn archives into a clean media catalog.",
    summary:
      "Review archived discs, connect titles to media items, and prepare selections for encoding.",
  },
  encoding: {
    kicker: "Encoding",
    title: "Manage the path to the media library.",
    summary:
      "Maintain encoding profiles, queue reviewed selections, and follow each encode through publication.",
  },
  verification: {
    kicker: "Filesystem verification",
    title: "Confirm the files behind the catalog.",
    summary:
      "Run explicit checks for original archives and encoded outputs without turning routine reads into filesystem probes.",
  },
};

export function OperationsDashboard({
  page = "overview",
}: {
  page?: OperationsDashboardPage;
}) {
  const [state, setState] = useState<DashboardLoadState>(
    () => dashboardState("loading"),
  );
  const [actionOverview, setActionOverview] =
    useState<ActionOverviewLoadState>({ status: "loading" });
  const [requestNumber, setRequestNumber] = useState(0);
  const [streamStatus, setStreamStatus] =
    useState<DashboardStreamStatus>("connecting");
  const [approvingDetectedDiscId, setApprovingDetectedDiscId] = useState<
    string | null
  >(null);
  const [archiveApprovalFailed, setArchiveApprovalFailed] = useState(false);
  const [busyWorkflowId, setBusyWorkflowId] = useState<string | null>(null);
  const [workflowMutationFailed, setWorkflowMutationFailed] = useState(false);
  const workflowMutationInFlight = React.useRef(false);
  const [requeueingEncodeJobId, setRequeueingEncodeJobId] = useState<
    DashboardEncodeJob["id"] | null
  >(null);
  const [encodeRetryFailed, setEncodeRetryFailed] = useState(false);
  const [cancellingEncodeJobId, setCancellingEncodeJobId] = useState<
    DashboardEncodeJob["id"] | null
  >(null);
  const [encodeCancellationFailed, setEncodeCancellationFailed] =
    useState(false);
  const [catalogReviewArchiveId, setCatalogReviewArchiveId] = useState<
    string | null
  >(null);
  const [catalogReviewCursor, setCatalogReviewCursor] = useState<string | null>(
    null,
  );
  const [catalogReviewView, setCatalogReviewView] =
    useState<CatalogReviewArchiveView>("needs_review");
  const [catalogReviewQuery, setCatalogReviewQuery] = useState("");
  const [catalogReviewOutcome, setCatalogReviewOutcome] =
    useState<CompletedCatalogReviewOutcome | undefined>(undefined);
  const [encodingTab, setEncodingTab] =
    useState<EncodingPageTab>("current");
  const [encodeJobFilter, setEncodeJobFilter] =
    useState<EncodeJobFilter>("in_progress");
  const encodingTabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [verifyingFilesystemTarget, setVerifyingFilesystemTarget] = useState<
    string | null
  >(null);
  const [filesystemVerificationFailed, setFilesystemVerificationFailed] =
    useState(false);
  const [approveDetectedDisc] = useState(() =>
    createDashboardMutationRunner({
      request: requestArchiveApproval,
      setBusyId: setApprovingDetectedDiscId,
      setFailed: setArchiveApprovalFailed,
      refresh: () => setRequestNumber((value) => value + 1),
    }),
  );
  const [requeueEncodeJob] = useState(() =>
    createDashboardMutationRunner<DashboardEncodeJob["id"]>({
      request: retryEncodeJob,
      setBusyId: setRequeueingEncodeJobId,
      setFailed: setEncodeRetryFailed,
      refresh: () => setRequestNumber((value) => value + 1),
    }),
  );
  const [requestEncodeCancellation] = useState(() =>
    createDashboardMutationRunner<DashboardEncodeJob["id"]>({
      request: cancelEncodeJob,
      setBusyId: setCancellingEncodeJobId,
      setFailed: setEncodeCancellationFailed,
      refresh: () => setRequestNumber((value) => value + 1),
    }),
  );
  const runWorkflowMutation = async (
    id: string,
    request: (id: string) => Promise<void>,
  ) => {
    if (workflowMutationInFlight.current) return;
    workflowMutationInFlight.current = true;
    setBusyWorkflowId(id);
    setWorkflowMutationFailed(false);
    try {
      await request(id);
      setRequestNumber((value) => value + 1);
    } catch {
      setWorkflowMutationFailed(true);
    } finally {
      setBusyWorkflowId(null);
      workflowMutationInFlight.current = false;
    }
  };

  useEffect(() => {
    if (page === "overview") {
      return;
    }
    setState(dashboardState("loading"));
    setStreamStatus("connecting");
    return watchDashboardActivity({
      catalogReviewCursor,
      catalogReviewView,
      ...(catalogReviewView === "reviewed" && catalogReviewQuery !== ""
        ? { catalogReviewQuery }
        : {}),
      ...(catalogReviewView === "reviewed" && catalogReviewOutcome !== undefined
        ? { catalogReviewOutcome }
        : {}),
      onSnapshot: setState,
      onInitialLoadError: () => setState(dashboardState("error")),
      onStreamStatus: setStreamStatus,
    });
  }, [
    page,
    requestNumber,
    catalogReviewCursor,
    catalogReviewView,
    catalogReviewQuery,
    catalogReviewOutcome,
  ]);

  useEffect(() => {
    if (page !== "overview") {
      return;
    }
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | undefined;
    setActionOverview({ status: "loading" });
    const load = async () => {
      try {
        requestController = new AbortController();
        const snapshot = await requestActionOverview(
          fetch,
          requestController.signal,
        );
        if (active) {
          setActionOverview({ status: "loaded", snapshot });
        }
      } catch {
        if (active) {
          setActionOverview({ status: "error" });
        }
      } finally {
        if (active) {
          refreshTimer = setTimeout(
            () => void load(),
            ACTION_OVERVIEW_REFRESH_INTERVAL_MS,
          );
        }
      }
    };
    void load();
    return () => {
      active = false;
      requestController?.abort();
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
    };
  }, [page, requestNumber]);

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
  const pageConnectionStatus: DashboardConnection =
    page === "overview"
      ? actionOverview.status === "loaded"
        ? "loaded"
        : actionOverview.status
      : connectionStatus;
  const copy = pageCopy[page];
  const encodeJobCounts = countEncodeJobsByFilter(state.encodeJobs);

  const selectEncodingTab = (index: number) => {
    const tab = encodingPageTabs[index];
    if (!tab) {
      return;
    }
    setEncodingTab(tab.id);
    encodingTabRefs.current[index]?.focus();
  };

  const handleEncodingTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % encodingPageTabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + encodingPageTabs.length) %
        encodingPageTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = encodingPageTabs.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    selectEncodingTab(nextIndex);
  };

  const verifyFilesystem = async (
    target: FilesystemVerificationTarget,
    id: string,
  ) => {
    if (verifyingFilesystemTarget !== null) {
      return;
    }
    setVerifyingFilesystemTarget(`${target}:${id}`);
    setFilesystemVerificationFailed(false);
    try {
      await requestFilesystemVerification(target, id);
      setRequestNumber((value) => value + 1);
    } catch {
      setFilesystemVerificationFailed(true);
    } finally {
      setVerifyingFilesystemTarget(null);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="kicker">{copy.kicker}</p>
          <h1>{copy.title}</h1>
          <p className="dashboard-summary">{copy.summary}</p>
        </div>
        <div className="dashboard-controls">
          <DashboardConnectionStatus
            connectionStatus={pageConnectionStatus}
            streamStatus={streamStatus}
          />
          <button
            type="button"
            onClick={() => setRequestNumber((value) => value + 1)}
          >
            {pageConnectionStatus === "error" ? "Try again" : "Refresh"}
          </button>
        </div>
      </header>

      {page === "encoding" ? (
        <section className="encoding-workspace" aria-label="Encoding workspace">
          <div
            className="encoding-page-tabs"
            role="tablist"
            aria-label="Encoding views"
          >
            {encodingPageTabs.map((tab, index) => (
              <button
                key={tab.id}
                id={`encoding-tab-${tab.id}`}
                ref={(element) => {
                  encodingTabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                aria-selected={encodingTab === tab.id}
                aria-controls={`encoding-panel-${tab.id}`}
                tabIndex={encodingTab === tab.id ? 0 : -1}
                onClick={() => setEncodingTab(tab.id)}
                onKeyDown={(event) => handleEncodingTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id="encoding-panel-current"
            role="tabpanel"
            aria-labelledby="encoding-tab-current"
            hidden={encodingTab !== "current"}
          >
            <div
              className="encoding-job-filters"
              role="group"
              aria-label="Current job status filters"
            >
              <button
                type="button"
                aria-pressed={encodeJobFilter === "in_progress"}
                onClick={() => setEncodeJobFilter("in_progress")}
              >
                <span>In progress</span>
                <span>{encodeJobCounts.in_progress}</span>
              </button>
              <button
                type="button"
                aria-pressed={encodeJobFilter === "completed"}
                onClick={() => setEncodeJobFilter("completed")}
              >
                <span>Completed</span>
                <span>{encodeJobCounts.completed}</span>
              </button>
            </div>
            <DashboardView
              state={{
                ...state,
                encodeJobs: filterEncodeJobs(state.encodeJobs, encodeJobFilter),
              }}
              section="encoding"
              onRequeueEncodeJob={(id) => void requeueEncodeJob(id)}
              requeueingEncodeJobId={requeueingEncodeJobId}
              onCancelEncodeJob={(id) => void requestEncodeCancellation(id)}
              cancellingEncodeJobId={cancellingEncodeJobId}
              onVerifyFilesystem={(target, id) =>
                void verifyFilesystem(target, id)
              }
              verifyingFilesystemTarget={verifyingFilesystemTarget}
            />
          </div>

          <div
            id="encoding-panel-queue"
            role="tabpanel"
            aria-labelledby="encoding-tab-queue"
            hidden={encodingTab !== "queue"}
          >
            <EncodeJobsManager
              revision={requestNumber}
              onChanged={() => setRequestNumber((value) => value + 1)}
            />
          </div>

          <div
            id="encoding-panel-settings"
            role="tabpanel"
            aria-labelledby="encoding-tab-settings"
            hidden={encodingTab !== "settings"}
          >
            <EncodingProfilesManager
              onChanged={() => setRequestNumber((value) => value + 1)}
            />
          </div>
        </section>
      ) : null}

      {page === "catalog" && catalogReviewArchiveId ? (
          <CatalogReviewEditor
            key={catalogReviewArchiveId}
            archiveId={catalogReviewArchiveId}
            activityRevision={catalogReviewActivityRevision(
              state,
              catalogReviewArchiveId,
            )}
          onClose={() => setCatalogReviewArchiveId(null)}
          onCompleted={() => {
            setCatalogReviewArchiveId(null);
            setRequestNumber((value) => value + 1);
          }}
        />
      ) : null}

      {archiveApprovalFailed ? (
        <p className="job-error" role="status">
          Archive Request creation failed. Try again.
        </p>
      ) : null}

      {workflowMutationFailed ? (
        <p className="job-error" role="status">
          The requested workflow change failed. Refresh the state and try again.
        </p>
      ) : null}

      {encodeRetryFailed ? (
        <p className="job-error" role="status">
          Encode Job retry failed. Confirm its catalog review, then try again.
        </p>
      ) : null}

      {encodeCancellationFailed ? (
        <p className="job-error" role="status">
          Encode Job cancellation failed. Refresh the queue and try again.
        </p>
      ) : null}

      {filesystemVerificationFailed ? (
        <p className="job-error" role="status">
          Filesystem verification could not be recorded. Try again.
        </p>
      ) : null}

      {page === "verification" ? (
        <FilesystemVerificationInventory
          refreshKey={requestNumber}
          onVerify={(target, id) => void verifyFilesystem(target, id)}
          verifyingTarget={verifyingFilesystemTarget}
        />
      ) : page === "overview" ? (
        <ActionOverview state={actionOverview} />
      ) : page === "encoding" ? null : (
        <DashboardView
          state={state}
          section={page}
          onApproveDetectedDisc={(id) => void approveDetectedDisc(id)}
          approvingDetectedDiscId={approvingDetectedDiscId}
          busyWorkflowId={busyWorkflowId}
          onCancelArchiveRequest={(id) =>
            void runWorkflowMutation(id, requestArchiveRequestCancellation)
          }
          onRetryArchiveRequest={(id) =>
            void runWorkflowMutation(id, requestArchiveRequestRetry)
          }
          onRetryDiscInspection={(id) =>
            void runWorkflowMutation(id, requestDiscInspectionRetry)
          }
          onRequeueEncodeJob={(id) => void requeueEncodeJob(id)}
          requeueingEncodeJobId={requeueingEncodeJobId}
          onCancelEncodeJob={(id) => void requestEncodeCancellation(id)}
          cancellingEncodeJobId={cancellingEncodeJobId}
          onOpenCatalogReview={setCatalogReviewArchiveId}
          onCatalogReviewPage={setCatalogReviewCursor}
          catalogReviewView={catalogReviewView}
          catalogReviewQuery={catalogReviewQuery}
          catalogReviewOutcome={catalogReviewOutcome}
          onCatalogReviewView={(view) => {
            setCatalogReviewCursor(null);
            setCatalogReviewView(view);
          }}
          onCatalogReviewSearch={(query, outcome) => {
            setCatalogReviewCursor(null);
            setCatalogReviewQuery(query);
            setCatalogReviewOutcome(outcome);
          }}
          onVerifyFilesystem={(target, id) =>
            void verifyFilesystem(target, id)
          }
          verifyingFilesystemTarget={verifyingFilesystemTarget}
        />
      )}

      <footer className="dashboard-footer">
        <span>Local control plane</span>
        {(page === "overview" && actionOverview.status === "loaded"
          ? actionOverview.snapshot.generatedAt
          : state.generatedAt) ? (
          <span>
            Updated{" "}
            {formatTimestamp(
              page === "overview" && actionOverview.status === "loaded"
                ? actionOverview.snapshot.generatedAt
                : state.generatedAt!,
            )}
          </span>
        ) : null}
      </footer>
    </main>
  );
}
