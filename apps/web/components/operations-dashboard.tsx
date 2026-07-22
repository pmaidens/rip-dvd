"use client";

import React, { useEffect, useState } from "react";

import type { DashboardSnapshot } from "../lib/dashboard";

export type DashboardLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; data: DashboardSnapshot };

interface SectionProps<T> {
  title: string;
  eyebrow: string;
  state: DashboardLoadState;
  selectItems: (dashboard: DashboardSnapshot) => T[];
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

function StatusBadge({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{displayTerm(value)}</span>;
}

function DashboardSection<T>({
  title,
  eyebrow,
  state,
  selectItems,
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
    const items = selectItems(state.data);
    if (items.length === 0) {
      sectionState = "empty";
      content = <div className="section-message">{emptyMessage}</div>;
    } else {
      sectionState = "populated";
      content = <div className="item-list">{items.map(renderItem)}</div>;
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
        state={state}
        selectItems={(dashboard) => dashboard.opticalDrives}
        emptyMessage="No Optical Drives have been discovered."
        renderItem={(drive) => (
          <article className="operation-item" key={drive.id}>
            <div className="item-heading">
              <div>
                <h3>{drive.displayName}</h3>
                <p className="mono">{drive.devicePath}</p>
              </div>
              <StatusBadge value={drive.state} />
            </div>
            <p className="item-meta">
              {drive.hardwareName ?? "Hardware details unavailable"}
            </p>
            <p className="item-time">
              Last seen {formatTimestamp(drive.lastSeenAt)}
            </p>
          </article>
        )}
      />

      <DashboardSection
        title="Detected Discs"
        eyebrow="Intake"
        state={state}
        selectItems={(dashboard) => dashboard.detectedDiscs}
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
        state={state}
        selectItems={(dashboard) => dashboard.archiveJobs}
        emptyMessage="No Archive Jobs are recorded."
        renderItem={(job) => (
          <article className="operation-item" key={job.id}>
            <div className="item-heading">
              <div>
                <h3>{job.discLabel}</h3>
                <p>{job.opticalDriveName}</p>
              </div>
              <StatusBadge value={job.status} />
            </div>
            <div className="progress-row">
              <Progress value={job.progressPercent} />
              <strong>{job.progressPercent}%</strong>
            </div>
            {job.errorMessage ? (
              <p className="job-error">{job.errorMessage}</p>
            ) : null}
          </article>
        )}
      />

      <DashboardSection
        title="Encode Jobs"
        eyebrow="Media queue"
        className="wide-section"
        state={state}
        selectItems={(dashboard) => dashboard.encodeJobs}
        emptyMessage="No Encode Jobs are recorded."
        renderItem={(job) => (
          <article className="operation-item" key={job.id}>
            <div className="item-heading">
              <div>
                <h3>
                  {job.mediaTitle}
                  {job.mediaYear ? ` (${job.mediaYear})` : ""}
                </h3>
                <p>{job.encodingProfileName}</p>
              </div>
              <StatusBadge value={job.status} />
            </div>
            <div className="progress-row">
              <Progress value={job.progressPercent} />
              <strong>{job.progressPercent}%</strong>
            </div>
            <p className="mono path">{job.outputPath}</p>
            {job.errorMessage ? (
              <p className="job-error">{job.errorMessage}</p>
            ) : null}
          </article>
        )}
      />

      <DashboardSection
        title="Catalog Review"
        eyebrow="Needs attention"
        className="wide-section"
        state={state}
        selectItems={(dashboard) => dashboard.catalogReview}
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
            <p className="mono path">{archive.archivePath}</p>
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
  const [state, setState] = useState<DashboardLoadState>({ status: "loading" });
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

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
          setState({ status: "loaded", data });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestNumber]);

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
          <span className={`connection-state connection-${state.status}`}>
            <span aria-hidden="true" />
            {state.status === "loaded"
              ? "Database connected"
              : state.status === "error"
                ? "Database unavailable"
                : "Refreshing state"}
          </span>
          <button
            type="button"
            onClick={() => setRequestNumber((value) => value + 1)}
          >
            {state.status === "error" ? "Try again" : "Refresh"}
          </button>
        </div>
      </header>

      <DashboardView state={state} />

      <footer className="dashboard-footer">
        <span>Local control plane</span>
        {state.status === "loaded" ? (
          <span>Updated {formatTimestamp(state.data.generatedAt)}</span>
        ) : null}
      </footer>
    </main>
  );
}
