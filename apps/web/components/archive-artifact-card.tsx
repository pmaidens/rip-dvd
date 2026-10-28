"use client";

import type {
  ArchiveArtifact,
  ArchiveArtifactAction,
} from "@rip-dvd/application";
import React, { useEffect, useState } from "react";

import type { DashboardArchiveJob } from "../lib/dashboard";
import { displayTerm } from "../lib/display-term";
import { countLabel, formatDuration } from "../lib/display-value";
import { createMutationKey } from "../lib/mutation-key";
import {
  requestArchiveArtifact,
  requestArchiveArtifactAction,
} from "../lib/archive-artifact-client";

type ArchiveArtifactLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; artifact: ArchiveArtifact };

function StatusBadge({
  value,
}: {
  value: ArchiveArtifact["recovery"]["state"] | string;
}) {
  return <span className={`status status-${value}`}>{displayTerm(value)}</span>;
}

function ArchiveArtifactReasons({
  reasons,
}: {
  reasons: readonly { code: string; message: string }[];
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className="archive-artifact-reasons">
      {reasons.map((reason) => (
        <li key={reason.code}>
          <code>{reason.code}</code>
          <span>{reason.message}</span>
        </li>
      ))}
    </ul>
  );
}

const SIMPLE_ACTIONS = [
  {
    name: "stop",
    label: "Stop and keep archive",
    busyLabel: "Stopping…",
  },
  {
    name: "verify-disc",
    label: "Run DVD Disc Verification",
    busyLabel: "Starting verification…",
  },
  {
    name: "confirm-disc",
    label: "Record Operator Disc Confirmation",
    busyLabel: "Confirming…",
  },
  {
    name: "reconcile",
    label: "Reconcile checkpoint",
    busyLabel: "Reconciling…",
  },
] as const satisfies readonly {
  name: ArchiveArtifactAction["name"];
  label: string;
  busyLabel: string;
}[];

function actionLabel(name: ArchiveArtifactAction["name"]): string {
  if (name === "verify-disc") return "DVD Disc Verification";
  if (name === "confirm-disc") return "Operator Disc Confirmation";
  return displayTerm(name);
}

export function ArchiveArtifactCard({
  job,
  busy,
  onRefresh,
  onInvestigate,
}: {
  job: DashboardArchiveJob & { originalDiscArchiveId: string };
  busy: boolean;
  onRefresh(): void;
  onInvestigate(
    archiveJobId: DashboardArchiveJob["id"],
    trigger: HTMLButtonElement,
  ): void;
}) {
  const [state, setState] = useState<ArchiveArtifactLoadState>({
    status: "loading",
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const mutationKeys = React.useRef(new Map<string, string>());

  const load = React.useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setState({ status: "loading" });
      setState({
        status: "loaded",
        artifact: await requestArchiveArtifact(job.originalDiscArchiveId),
      });
    } catch {
      setState({ status: "error" });
    }
  }, [job.originalDiscArchiveId]);

  useEffect(() => {
    void load();
  }, [load, job.activityRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const run = async (
    name: ArchiveArtifactAction["name"],
    speedMode?: "normal" | "low",
  ) => {
    if (state.status !== "loaded" || busyAction !== null) return;
    if (
      name === "confirm-disc" &&
      !window.confirm(
        "Confirm that you reviewed the DVD Disc Verification result and want to record Operator Disc Confirmation?",
      )
    ) {
      return;
    }
    const key = `${name}:${speedMode ?? "default"}`;
    const mutationKey = mutationKeys.current.get(key) ?? createMutationKey();
    mutationKeys.current.set(key, mutationKey);
    setBusyAction(key);
    setActionFailed(false);
    try {
      await requestArchiveArtifactAction(
        state.artifact,
        name,
        speedMode === undefined ? {} : { speedMode },
        fetch,
        mutationKey,
      );
      mutationKeys.current.delete(key);
      onRefresh();
      await load();
    } catch {
      setActionFailed(true);
    } finally {
      setBusyAction(null);
    }
  };

  if (state.status === "loading") {
    return (
      <article className="operation-item archive-artifact-card">
        <div className="section-message" aria-live="polite">
          <span className="loading-dot" aria-hidden="true" />
          Loading archive artifact state…
        </div>
      </article>
    );
  }
  if (state.status === "error") {
    return (
      <article className="operation-item archive-artifact-card">
        <div className="section-message section-error" role="status">
          Archive artifact state is unavailable.
        </div>
      </article>
    );
  }

  const artifact = state.artifact;
  const progress = artifact.recovery.progress;
  const currentPass = progress?.currentPass ?? null;
  const currentPassEstimate = currentPass === null ||
      currentPass.completionEstimate === "unknown"
    ? "Unknown"
    : `${formatDuration(Math.ceil(
        currentPass.completionEstimate.minimumRemainingMs / 1_000,
      ))} to ${formatDuration(Math.ceil(
        currentPass.completionEstimate.maximumRemainingMs / 1_000,
      ))}`;
  const verification = artifact.sourceIdentity.verification;
  const confirmation = artifact.sourceIdentity.confirmation;
  const reconciliation = artifact.recovery.reconciliation;
  const sourceReadiness = artifact.readiness.sourceStability;
  const assessmentReadiness = artifact.readiness.titleAssessment;
  const encodeReadiness = artifact.readiness.encodeEligibility;
  const recoveryWork = artifact.recovery.currentWork.recovery;
  const encodeWork = artifact.recovery.currentWork.encodeJobs;
  const actionAvailable = (name: ArchiveArtifactAction["name"]) =>
    artifact.actions.some((action) => action.name === name && action.available);

  return (
    <article
      className="operation-item archive-artifact-card"
      aria-label={`${job.discLabel} archive artifact`}
    >
      <div className="item-heading">
        <div>
          <p className="section-eyebrow">Saved archive artifact</p>
          <h3>{job.discLabel}</h3>
          <p>{job.opticalDriveName}</p>
        </div>
        <StatusBadge value={artifact.recovery.state} />
      </div>

      <section className="archive-artifact-stage" aria-label="Initial preservation">
        <div className="item-heading">
          <div>
            <strong>Initial preservation</strong>
            <p>Archive Request and initial Archive Job</p>
          </div>
          <StatusBadge value={artifact.initialPreservation.saved
            ? "completed"
            : job.status} />
        </div>
        <dl className="archive-artifact-facts">
          <div>
            <dt>Archive Request</dt>
            <dd>{artifact.initialPreservation.archiveRequest?.status ??
              "Unavailable"}</dd>
          </div>
          <div>
            <dt>Initial Archive Job</dt>
            <dd>{artifact.initialPreservation.archiveJob?.status ??
              "Unavailable"}</dd>
          </div>
        </dl>
      </section>

      <section className="archive-artifact-stage" aria-label="Archive Recovery">
        <div className="item-heading">
          <div>
            <strong>Archive Recovery</strong>
            <p>Further reads use the saved image and a separate lifecycle.</p>
          </div>
          <StatusBadge value={artifact.recovery.state} />
        </div>
        <dl className="archive-artifact-facts">
          <div>
            <dt>Recovery attempt</dt>
            <dd>{artifact.recovery.record === null
              ? "Unavailable"
              : <code>{artifact.recovery.record.attemptId}</code>}</dd>
          </div>
          <div>
            <dt>Checkpoint</dt>
            <dd>{artifact.recovery.checkpoint === null
              ? "Unavailable"
              : <>Revision {artifact.recovery.checkpoint.revision} · <code>{artifact.recovery.checkpoint.manifestDigest}</code></>}</dd>
          </div>
          <div>
            <dt>Accepted extent</dt>
            <dd>{artifact.recovery.checkpoint === null
              ? "Unavailable"
              : countLabel(
                  artifact.recovery.checkpoint.acceptedEndLbaExclusive,
                  "sector",
                )}</dd>
          </div>
          <div>
            <dt>Skipped, untested</dt>
            <dd>{progress === null
              ? "Unavailable"
              : countLabel(progress.skippedUntestedSectorCount, "sector")}</dd>
          </div>
          <div>
            <dt>Individually failed</dt>
            <dd>{progress === null
              ? "Unavailable"
              : countLabel(progress.individuallyFailedSectorCount, "sector")}</dd>
          </div>
          <div>
            <dt>Recovered</dt>
            <dd>{progress === null
              ? "Unavailable"
              : countLabel(progress.recoveredSectorCount, "sector")}</dd>
          </div>
          <div>
            <dt>Unresolved</dt>
            <dd>{progress === null
              ? "Unavailable"
              : countLabel(progress.unresolvedSectorCount, "sector")}</dd>
          </div>
          <div>
            <dt>Current pass</dt>
            <dd>{currentPass === null
              ? "Not active"
              : `Pass ${currentPass.number} · ${displayTerm(currentPass.direction)}`}</dd>
          </div>
          <div>
            <dt>Pass cursor</dt>
            <dd>{currentPass?.cursorLba === null || currentPass === null
              ? "Unavailable"
              : `LBA ${currentPass.cursorLba}`}</dd>
          </div>
          <div>
            <dt>Pass elapsed</dt>
            <dd>{currentPass?.elapsedMs === null || currentPass === null
              ? "Unavailable"
              : formatDuration(Math.floor(currentPass.elapsedMs / 1_000))}</dd>
          </div>
          <div>
            <dt>Current pass progress</dt>
            <dd>{currentPass?.initialUnrecoveredSectorCount === null ||
                currentPass?.initialUnrecoveredSectorCount === undefined ||
                currentPass.remainingSectorCount === null
              ? "Unknown"
              : `${countLabel(
                  currentPass.remainingSectorCount,
                  "sector",
                )} remain of ${countLabel(
                  currentPass.initialUnrecoveredSectorCount,
                  "sector",
                )}`}</dd>
          </div>
          <div>
            <dt>Current pass estimate</dt>
            <dd>{currentPassEstimate}</dd>
          </div>
          <div>
            <dt>Recovery work</dt>
            <dd>{recoveryWork === null
              ? "None"
              : <>{displayTerm(recoveryWork.status)} · <code>{recoveryWork.attemptId}</code></>}</dd>
          </div>
          <div>
            <dt>Encode work</dt>
            <dd>{encodeWork.length === 0
              ? "None"
              : encodeWork.map((job) => (
                  <span key={job.id}><code>{job.id}</code> · {displayTerm(job.status)}</span>
                ))}</dd>
          </div>
          <div>
            <dt>DVD Disc Verification</dt>
            <dd>{verification === null
              ? "Not run"
              : <>{[displayTerm(verification.status), verification.outcome === null
                  ? null
                  : displayTerm(verification.outcome)].filter(Boolean).join(" · ")} · <code>{verification.id}</code></>}</dd>
          </div>
          <div>
            <dt>Current insertion</dt>
            <dd>{verification === null
              ? "Unavailable"
              : <><code>{verification.discInspectionId}</code> · <code>{verification.detectedDiscId}</code> · <code>{verification.mediaGeneration}</code></>}</dd>
          </div>
          <div>
            <dt>Operator Disc Confirmation</dt>
            <dd>{confirmation === null
              ? "Not recorded"
              : confirmation.current
                ? <>Current · {displayTerm(confirmation.verificationOutcome)} · <code>{confirmation.id}</code></>
                : confirmation.expiryReason === null
                  ? "Expired"
                  : displayTerm(confirmation.expiryReason)}</dd>
          </div>
          <div>
            <dt>Reconciliation</dt>
            <dd>{reconciliation === null
              ? "Not run"
              : <>{displayTerm(reconciliation.outcome ?? reconciliation.status)} · <code>{reconciliation.id}</code></>}</dd>
          </div>
        </dl>
      </section>

      <section className="archive-artifact-readiness" aria-label="Archive readiness">
        <h4>Readiness</h4>
        <dl className="archive-artifact-facts">
          <div>
            <dt>Source stability</dt>
            <dd>{sourceReadiness.ready ? "Stable" : "Not stable"}</dd>
          </div>
          <div>
            <dt>Title assessment</dt>
            <dd>{assessmentReadiness.ready ? "Current" : displayTerm(
              assessmentReadiness.state,
            )}</dd>
          </div>
          <div>
            <dt>Encode eligibility</dt>
            <dd>{encodeReadiness.ready ? "Ready" : "Not ready"}</dd>
          </div>
        </dl>
        <ArchiveArtifactReasons reasons={sourceReadiness.reasons} />
        <ArchiveArtifactReasons reasons={assessmentReadiness.reasons} />
        <ArchiveArtifactReasons reasons={encodeReadiness.reasons} />
      </section>

      <details className="archive-artifact-actions">
        <summary>Recovery actions</summary>
        <div className="operation-actions">
          {SIMPLE_ACTIONS.map((action) =>
            actionAvailable(action.name) ? (
              <button
                key={action.name}
                type="button"
                disabled={busyAction !== null}
                onClick={() => void run(action.name)}
              >
                {busyAction === `${action.name}:default`
                  ? action.busyLabel
                  : action.label}
              </button>
            ) : null
          )}
          {actionAvailable("resume") ? (
            <>
              <button type="button" disabled={busyAction !== null} onClick={() => void run("resume", "normal")}>
                {busyAction === "resume:normal" ? "Resuming…" : "Resume at normal speed"}
              </button>
              <button type="button" disabled={busyAction !== null} onClick={() => void run("resume", "low")}>
                {busyAction === "resume:low" ? "Resuming…" : "Resume at low speed"}
              </button>
            </>
          ) : null}
        </div>
        {artifact.actions.map((action) => (
          <div className="archive-artifact-action" key={action.name}>
            <strong>{actionLabel(action.name)}</strong>
            <span>{action.available ? "Available" : "Unavailable"}</span>
            <ArchiveArtifactReasons reasons={action.blockingReasons} />
            <small>Expected inputs: {action.requiredInputs.join(", ")}</small>
            {action.expectedInputs === null ? null : (
              <code className="archive-artifact-expected-inputs">
                {JSON.stringify(action.expectedInputs)}
              </code>
            )}
          </div>
        ))}
      </details>
      {actionFailed ? (
        <p className="mutation-error" role="alert">
          The recovery action did not complete. Refresh the artifact state and try again.
        </p>
      ) : null}
      {job.investigation ? (
        <button
          className="investigate-action"
          type="button"
          disabled={busy}
          onClick={(event) => onInvestigate(job.id, event.currentTarget)}
        >
          Investigate initial job
        </button>
      ) : null}
    </article>
  );
}
