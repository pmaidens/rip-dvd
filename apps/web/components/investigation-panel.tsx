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
  investigations?: readonly DashboardInvestigation[];
  returnFocusTo: HTMLButtonElement | null;
  returnFocusFallback?: HTMLElement | null;
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
  investigations,
  returnFocusTo,
  returnFocusFallback = null,
  onClose,
}: InvestigationPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reportRef = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "denied">(
    "idle",
  );
  const availableInvestigations = investigations?.length
    ? investigations
    : [investigation];
  const [selectedIncidentId, setSelectedIncidentId] = useState(
    investigation.incidentId,
  );
  const selectedInvestigation =
    availableInvestigations.find(
      ({ incidentId }) => incidentId === selectedIncidentId,
    ) ?? investigation;
  const report = investigationReport(selectedInvestigation);

  useEffect(() => {
    if (
      !availableInvestigations.some(
        ({ incidentId }) => incidentId === selectedIncidentId,
      )
    ) {
      setSelectedIncidentId(investigation.incidentId);
    }
  }, [
    availableInvestigations,
    investigation.incidentId,
    selectedIncidentId,
  ]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => {
      const focusTarget = returnFocusTo?.isConnected
        ? returnFocusTo
        : returnFocusFallback?.isConnected
          ? returnFocusFallback
          : null;
      focusTarget?.focus();
    };
  }, [returnFocusFallback, returnFocusTo]);

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
              {selectedInvestigation.subjectType}
              {selectedInvestigation.attempt === null
                ? ""
                : ` attempt ${selectedInvestigation.attempt}`}
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
          {availableInvestigations.length > 1 ? (
            <label className="investigation-report-selector">
              Failure report
              <select
                value={selectedInvestigation.incidentId}
                onChange={(event) => {
                  setSelectedIncidentId(event.currentTarget.value);
                  setCopyStatus("idle");
                }}
              >
                {availableInvestigations.map((candidate, index) => (
                  <option key={candidate.incidentId} value={candidate.incidentId}>
                    {index === 0 ? "Latest" : `Older ${index}`} ·{" "}
                    {formatInvestigationTimestamp(candidate.occurredAt)} ·{" "}
                    {candidate.reasonCode}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <dl className="investigation-summary">
            <div>
              <dt>Incident identifier</dt>
              <dd>{selectedInvestigation.incidentId}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{selectedInvestigation.worker}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>
                {selectedInvestigation.subjectType}{" "}
                {selectedInvestigation.subjectId}
              </dd>
            </div>
            <div>
              <dt>Reason code</dt>
              <dd>{selectedInvestigation.reasonCode}</dd>
            </div>
            <div>
              <dt>Failed phase</dt>
              <dd>{selectedInvestigation.failedPhase}</dd>
            </div>
            <div>
              <dt>Occurred</dt>
              <dd>
                <time dateTime={selectedInvestigation.occurredAt}>
                  {formatInvestigationTimestamp(
                    selectedInvestigation.occurredAt,
                  )}
                </time>
              </dd>
            </div>
            <div className="investigation-summary-wide">
              <dt>Retryability</dt>
              <dd>
                <strong>
                  {investigationRetryabilityLabel(
                    selectedInvestigation.retryability,
                  )}
                </strong>
                {". "}
                {selectedInvestigation.retryabilityDetail}
              </dd>
            </div>
          </dl>

          <section className="investigation-guidance">
            <h3>What happened</h3>
            <p id="investigation-explanation">
              {selectedInvestigation.explanation}
            </p>
            <h3>Suggested action</h3>
            <p>{selectedInvestigation.suggestedAction}</p>
          </section>

          <section className="investigation-evidence">
            <h3>Technical evidence</h3>
            {selectedInvestigation.technicalEvidence.length === 0 ? (
              <p>No structured technical evidence was recorded.</p>
            ) : (
              <dl>
                {selectedInvestigation.technicalEvidence.map(
                  ({ label, value }) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ),
                )}
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
