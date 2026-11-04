"use client";

import { useId, useRef, useState } from "react";
import type { PrototypeDrive } from "./model";
import styles from "./shelf-actions.module.css";

export function ShelfActions({ drive, onRetry, onCancel }: {
  drive: PrototypeDrive;
  onRetry: () => void;
  onCancel: (driveId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState<"cancel" | "investigate" | "activity" | "details">("activity");
  const titleId = useId();
  const descriptionId = useId();
  const hasArchiveRequest = drive.progress !== null && (drive.state === "active" || drive.state === "error");
  const retryLabel = drive.phase === "Drive not detected" ? "Retry detection" : drive.title ? "Retry archive" : "Retry inspection";
  const failureType = drive.phase === "Drive not detected" ? "Drive connection" : drive.title ? "Archive read" : "Disc Inspection";
  const failureCode = drive.phase === "Drive not detected" ? "DRIVE_UNAVAILABLE" : drive.title ? "ARCHIVE_READ_FAILED" : "METADATA_READ_FAILED";
  const checks = drive.phase === "Drive not detected"
    ? ["Check the drive's power and connection.", "Reconnect the drive, then retry detection."]
    : drive.title
      ? ["Check the disc surface and the drive connection.", "Clean and reinsert the disc, then retry archiving."]
      : ["Check that a readable DVD is inserted.", "Clean and reinsert the disc, then retry Disc Inspection."];

  function open(next: typeof panel) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
    dialog.current?.showModal();
  }

  function close() { dialog.current?.close(); }

  return <>
    <div ref={toolbar} className={styles.toolbar} role="group" aria-label={`Actions for ${drive.name}`}>
      <div className={styles.context}><span>SELECTED DRIVE</span><strong>{drive.name}<small>{drive.phase}</small></strong></div>
      <div className={styles.buttons}>
        {drive.state === "error" ? <>
          <button type="button" className={styles.primary} onClick={() => open("investigate")}>Investigate problem <span aria-hidden="true">↗</span></button>
          <button type="button" onClick={onRetry}>{retryLabel}</button>
        </> : drive.state === "cancelled" ? <>
          <button type="button" className={styles.primary} onClick={onRetry}>Start new archive</button>
          <button type="button" onClick={() => open("activity")}>View activity</button>
        </> : drive.state === "complete" ? (
          <button type="button" className={styles.primary} onClick={() => open("details")}>View archive details <span aria-hidden="true">↗</span></button>
        ) : drive.state === "idle" ? (
          <button type="button" onClick={() => open("details")}>View drive details</button>
        ) : (
          <button type="button" onClick={() => open("activity")}>View activity</button>
        )}
        {hasArchiveRequest && <button type="button" className={styles.destructive} onClick={() => open("cancel")}>{drive.state === "error" ? "Cancel request" : "Cancel archive"}</button>}
      </div>
    </div>

    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId} onClose={() => {
      const target = returnFocus.current?.isConnected ? returnFocus.current : toolbar.current?.querySelector("button");
      target?.focus();
    }}>
      <header className={styles.dialogHeader}>
        <div><p>{panel === "investigate" ? "FAILURE INVESTIGATION" : panel === "cancel" ? "ARCHIVE REQUEST" : "DRIVE DETAILS"}</p><h2 id={titleId}>{panel === "cancel" ? `Cancel archive in ${drive.name}?` : panel === "investigate" ? `${failureType} problem` : panel === "activity" ? "Current activity" : drive.state === "complete" ? "Archive details" : "Optical Drive details"}</h2></div>
        <button type="button" aria-label="Close drive actions" onClick={close}>×</button>
      </header>
      <p className={styles.scope}>{drive.name}<span> / </span>{drive.title ?? (drive.state === "idle" ? "No disc inserted" : "Unidentified disc")}</p>
      {panel === "cancel" ? <>
        <p id={descriptionId} className={styles.explanation}>{hasArchiveRequest ? "Stop this Archive Request. The disc will not be marked complete. Other drives will continue." : "This Archive Request is no longer running, so there is nothing to cancel."}</p>
        <div className={styles.cancelSummary}><span>Last reported read progress</span><strong>{drive.progress ?? 0}%</strong><small>{drive.read} of {drive.capacity}</small></div>
        <p className={styles.demoNote}>This confirmation changes only the sample drive.</p>
        <footer className={styles.dialogFooter}>
          <button type="button" autoFocus onClick={close}>{hasArchiveRequest ? "Keep current request" : "Close"}</button>
          {hasArchiveRequest && <button type="button" className={styles.confirmCancel} onClick={() => { onCancel(drive.id); close(); }}>Confirm cancellation</button>}
        </footer>
      </> : panel === "investigate" ? <>
        <p id={descriptionId} className={styles.failure}>{drive.error ?? "No current failure is reported for this sample drive."}</p>
        <dl className={styles.facts}><div><dt>Operation</dt><dd>{drive.phase}</dd></div><div><dt>Sample error code</dt><dd><code>{failureCode}</code></dd></div><div><dt>Last reported progress</dt><dd>{drive.progress === null ? "Unavailable" : `${drive.progress}% read`}</dd></div><div><dt>Next action</dt><dd>{retryLabel}</dd></div></dl>
        <section className={styles.nextSteps}><h3>What to check</h3><ol>{checks.map((check) => <li key={check}>{check}</li>)}</ol></section>
        <details className={styles.evidence}><summary>Sample diagnostic details</summary><pre>{JSON.stringify({ drive: drive.name, operation: drive.phase, status: drive.state, error: failureCode, progress: drive.progress, read: drive.read, capacity: drive.capacity }, null, 2)}</pre></details>
        <p className={styles.demoNote}>Sample diagnosis for this design preview.</p>
        <footer className={styles.dialogFooter}><button type="button" onClick={close}>Close investigation</button><button type="button" className={styles.primary} onClick={() => { close(); onRetry(); }}>{retryLabel}</button></footer>
      </> : <>
        <p id={descriptionId} className={styles.explanation}>{drive.state === "complete" ? "The sample Original Disc Archive has been saved." : drive.state === "cancelled" ? "The sample Archive Request was cancelled. The disc is not marked complete." : drive.state === "idle" ? "This drive is connected and waiting for a disc." : "The selected drive's current operation and read progress."}</p>
        <dl className={styles.facts}><div><dt>Optical Drive</dt><dd>{drive.model}</dd></div><div><dt>Status</dt><dd>{drive.phase}</dd></div><div><dt>Read so far</dt><dd>{drive.read} / {drive.capacity}</dd></div><div><dt>Elapsed</dt><dd>{drive.elapsed}</dd></div><div><dt>Read speed</dt><dd>{drive.speed}</dd></div><div><dt>Progress</dt><dd>{drive.progress === null ? "Unavailable" : `${drive.progress}%`}</dd></div></dl>
        {panel === "activity" && <section className={styles.nextSteps}><h3>Activity</h3><ol><li>Disc detected in {drive.name}.</li><li>{drive.title ? `Identified as ${drive.title}.` : "Reading disc metadata."}</li>{drive.progress !== null && <li>{drive.state === "cancelled" ? `Archive cancelled at ${drive.progress}% read.` : `${drive.progress}% of the disc read.`}</li>}</ol></section>}
        <p className={styles.demoNote}>Sample activity. No live drive operations.</p>
        <footer className={styles.dialogFooter}><button type="button" onClick={close}>Close details</button></footer>
      </>}
    </dialog>
  </>;
}
