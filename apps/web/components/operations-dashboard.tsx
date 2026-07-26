"use client";

import React, { useEffect, useState } from "react";

import type {
  DashboardArchiveJob,
  DashboardCatalogReviewItem,
  DashboardDetectedDisc,
  DashboardEncodeJob,
  DashboardOpticalDrive,
  DashboardSectionResult,
  DashboardSnapshot,
  DashboardStatus,
} from "../lib/dashboard";

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

function displayTerm(value: string): string {
  const domainTerms: Record<string, string> = {
    audio_cd: "Audio CD",
    blu_ray: "Blu-ray",
    dvd: "DVD",
    dvd_video: "DVD video",
  };

  if (domainTerms[value]) {
    return domainTerms[value];
  }

  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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
}

function DashboardJobItem({
  title,
  subtitle,
  status,
  progressPercent,
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

export function DashboardView({ state }: { state: DashboardLoadState }) {
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
          </article>
        )}
      />
    </div>
  );
}

export function OperationsDashboard() {
  const [state, setState] = useState<DashboardLoadState>(
    () => dashboardState("loading"),
  );
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(dashboardState("loading"));

    fetch("/api/dashboard", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Dashboard request failed");
        }
        return (await response.json()) as DashboardSnapshot;
      })
      .then((data) => {
        if (!cancelled) {
          setState(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(dashboardState("error"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestNumber]);

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
          <span className={`connection-state connection-${connectionStatus}`}>
            <span aria-hidden="true" />
            {connectionStatus === "loaded"
              ? "Database connected"
              : connectionStatus === "error"
                ? "Some data unavailable"
                : "Refreshing state"}
          </span>
          <button
            type="button"
            onClick={() => setRequestNumber((value) => value + 1)}
          >
            {connectionStatus === "error" ? "Try again" : "Refresh"}
          </button>
        </div>
      </header>

      <DashboardView state={state} />

      <footer className="dashboard-footer">
        <span>Local control plane</span>
        {state.generatedAt ? (
          <span>Updated {formatTimestamp(state.generatedAt)}</span>
        ) : null}
      </footer>
    </main>
  );
}
