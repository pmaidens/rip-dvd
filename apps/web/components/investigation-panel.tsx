"use client";

import React, { useEffect, useRef, useState } from "react";

import type { DashboardInvestigation } from "../lib/investigation";
import {
  formatInvestigationTimestamp,
  investigationReport,
  investigationRetryabilityLabel,
} from "../lib/investigation";

interface InvestigationPanelProps {
  investigation: DashboardInvestigation;
  returnFocusTo: HTMLButtonElement | null;
  onClose(): void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function InvestigationPanel({
  investigation,
  returnFocusTo,
  onClose,
}: InvestigationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "denied">(
    "idle",
  );
  const report = investigationReport(investigation);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => returnFocusTo?.focus();
  }, [returnFocusTo]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
      FOCUSABLE_SELECTOR,
    ) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const copyReport = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access unavailable");
      }
      await navigator.clipboard.writeText(report);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("denied");
      reportRef.current?.focus();
      reportRef.current?.select();
    }
  };

  return (
    <div
      className="investigation-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className="investigation-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="investigation-title"
        aria-describedby="investigation-explanation"
        onKeyDown={handleKeyDown}
      >
        <header className="investigation-header">
          <div>
            <p className="section-eyebrow">Failure investigation</p>
            <h2 id="investigation-title">
              {investigation.subjectType}
              {investigation.attempt === null
                ? ""
                : ` attempt ${investigation.attempt}`}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close investigation"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <div className="investigation-content">
          <dl className="investigation-summary">
            <div>
              <dt>Incident identifier</dt>
              <dd>{investigation.incidentId}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{investigation.worker}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>
                {investigation.subjectType} {investigation.subjectId}
              </dd>
            </div>
            <div>
              <dt>Reason code</dt>
              <dd>{investigation.reasonCode}</dd>
            </div>
            <div>
              <dt>Failed phase</dt>
              <dd>{investigation.failedPhase}</dd>
            </div>
            <div>
              <dt>Occurred</dt>
              <dd>
                <time dateTime={investigation.occurredAt}>
                  {formatInvestigationTimestamp(investigation.occurredAt)}
                </time>
              </dd>
            </div>
            <div className="investigation-summary-wide">
              <dt>Retryability</dt>
              <dd>
                <strong>
                  {investigationRetryabilityLabel(
                    investigation.retryability,
                  )}
                </strong>
                {". "}
                {investigation.retryabilityDetail}
              </dd>
            </div>
          </dl>

          <section className="investigation-guidance">
            <h3>What happened</h3>
            <p id="investigation-explanation">{investigation.explanation}</p>
            <h3>Suggested action</h3>
            <p>{investigation.suggestedAction}</p>
          </section>

          <section className="investigation-evidence">
            <h3>Technical evidence</h3>
            {investigation.technicalEvidence.length === 0 ? (
              <p>No structured technical evidence was recorded.</p>
            ) : (
              <dl>
                {investigation.technicalEvidence.map(({ label, value }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <section className="investigation-report">
            <h3>Support report</h3>
            <p>
              This report contains the same path-free information shown above.
            </p>
            <textarea
              ref={reportRef}
              aria-label="Investigation report"
              readOnly
              rows={12}
              value={report}
            />
            <div className="investigation-report-actions">
              <button type="button" onClick={() => void copyReport()}>
                Copy report
              </button>
              <p role="status" aria-live="polite" aria-atomic="true">
                {copyStatus === "copied"
                  ? "Investigation report copied."
                  : copyStatus === "denied"
                    ? "Clipboard access was denied. The report is selected; press Ctrl+C or Command+C to copy it."
                    : ""}
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
