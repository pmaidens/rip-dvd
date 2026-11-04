"use client";

import { DiscVisual, StatusDot } from "./disc-visual";
import type { PrototypeDrive, PrototypeVariantProps } from "./model";
import styles from "./variant-console.module.css";

const stateLabels: Record<PrototypeDrive["state"], string> = {
  complete: "Completed",
  active: "In progress",
  error: "Needs attention",
  idle: "Empty",
  cancelled: "Cancelled",
};

function currentStep(drive: PrototypeDrive) {
  if (drive.state === "idle" || drive.state === "cancelled") return -1;
  if (drive.state === "complete") return 4;
  if (drive.phase === "Drive not detected") return 0;
  if (!drive.title) return 1;
  return 2;
}

export function VariantConsole({
  drives,
  selectedIndex,
  onSelect,
  onPrevious,
  onNext,
  onRetry,
}: PrototypeVariantProps) {
  const drive = drives[selectedIndex];
  const step = currentStep(drive);
  const activeCount = drives.filter((item) => item.state === "active").length;
  const attentionCount = drives.filter((item) => item.state === "error").length;

  return (
    <section className={styles.console} aria-label="Archive disc operator console">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Disc intake / drive monitor</p>
          <h1>Every drive. One workspace.</h1>
        </div>
        <div className={styles.fleetSummary}>
          <span><b>{activeCount}</b> in progress</span>
          <span className={attentionCount ? styles.attentionSummary : undefined}>
            <b>{attentionCount}</b> need attention
          </span>
        </div>
      </header>

      <div className={styles.quickStatus} aria-label="Optical drive status">
        {drives.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={`${styles.quickDrive} ${index === selectedIndex ? styles.quickDriveSelected : ""}`}
            onClick={() => onSelect(index)}
            aria-pressed={index === selectedIndex}
          >
            <span className={styles.quickDriveName}><StatusDot state={item.state} />{item.name}</span>
            <span className={styles.quickDriveState}>{stateLabels[item.state]}</span>
            <span className={styles.quickDriveIndex}>{String(index + 1).padStart(2, "0")}</span>
          </button>
        ))}
      </div>

      <div className={styles.workspace}>
        <section
          className={styles.stage}
          aria-roledescription="carousel"
          aria-label="Selected optical drive"
        >
          <div className={styles.stageHeader}>
            <div>
              <p className={styles.eyebrow}>Optical drive {String(selectedIndex + 1).padStart(2, "0")}</p>
              <h2>{drive.name}</h2>
              <p className={styles.model}>{drive.model}</p>
            </div>
            <div className={styles.carouselControls}>
              <span>{selectedIndex + 1} / {drives.length}</span>
              <button type="button" onClick={onPrevious} aria-label="Previous optical drive">←</button>
              <button type="button" onClick={onNext} aria-label="Next optical drive">→</button>
            </div>
          </div>

          <div className={styles.discWell}>
            <span className={styles.wellGuide} aria-hidden="true" />
            <DiscVisual drive={drive} size={380} className={styles.disc} />
          </div>

          <div className={styles.stageFooter} aria-live="polite">
            <div className={styles.stageStatus}>
              <StatusDot state={drive.state} />
              <div><strong>{drive.phase}</strong><span>{drive.subtitle}</span></div>
            </div>
            <div className={styles.percent}>
              <strong>{drive.progress === null ? "—" : `${Math.round(drive.progress)}%`}</strong>
              <span>{drive.progress === null ? "Progress unavailable" : "Disc read"}</span>
            </div>
          </div>
        </section>

        <aside className={styles.detailPane} aria-label="Current drive activity">
          <div className={styles.discIdentity}>
            <p className={styles.eyebrow}>Current disc</p>
            <h2>{drive.title ?? (drive.state === "idle" ? "Ready for a disc" : drive.state === "error" ? "Unidentified disc" : "Identifying disc")}</h2>
            <span className={styles.stateLabel} data-state={drive.state}>
              <StatusDot state={drive.state} />{stateLabels[drive.state]}
            </span>
          </div>

          <div className={styles.sequence} aria-label="Archive stages">
            {["Disc detected", "Metadata read", "Archiving disc", "Archive saved"].map((label, index) => {
              const isDone = step > index;
              const isCurrent = step === index;
              return (
                <div
                  key={label}
                  className={styles.sequenceRow}
                  data-done={isDone}
                  data-current={isCurrent}
                  data-error={isCurrent && drive.state === "error"}
                >
                  <span className={styles.stepNumber}>{isDone ? "✓" : String(index + 1).padStart(2, "0")}</span>
                  <span>{label}</span>
                  {isCurrent && <span className={styles.stepIndicator}>{drive.state === "error" ? "!" : "Current"}</span>}
                </div>
              );
            })}
          </div>

          <dl className={styles.metrics}>
            <div><dt>Read speed</dt><dd>{drive.speed}</dd></div>
            <div><dt>Time remaining</dt><dd>{drive.eta}</dd></div>
            <div><dt>Elapsed</dt><dd>{drive.elapsed}</dd></div>
            <div><dt>Data read</dt><dd>{drive.read}</dd></div>
          </dl>

          {drive.state === "error" ? (
            <div className={styles.issue}>
              <p>Drive needs attention</p>
              <span>{drive.error ?? "The current operation could not finish. Check the disc and try again."}</span>
              <button type="button" onClick={onRetry}>Retry in prototype <span aria-hidden="true">↗</span></button>
            </div>
          ) : drive.state === "complete" ? (
            <div className={styles.note} data-complete="true">
              <span aria-hidden="true">✓</span>
              <div><strong>Archive saved</strong><p>This drive is ready for the next disc.</p></div>
            </div>
          ) : drive.state === "cancelled" ? (
            <div className={styles.note}><div><strong>Archive cancelled</strong><p>The disc is not marked complete.</p></div></div>
          ) : drive.state === "idle" ? (
            <div className={styles.note}>
              <span aria-hidden="true">○</span>
              <div><strong>Waiting for a disc</strong><p>A newly inserted disc will appear here.</p></div>
            </div>
          ) : (
            <div className={styles.note}>
              <span aria-hidden="true">↗</span>
              <div><strong>{drive.progress === null ? "Reading disc information" : "Archive in progress"}</strong><p>{drive.progress === null ? "Progress appears when the disc read begins." : `${drive.read} of ${drive.capacity} read.`}</p></div>
            </div>
          )}
        </aside>
      </div>

      <section className={styles.worklist} aria-label="Drive worklist">
        <div className={styles.worklistHeader}><h2>Drive worklist</h2><span>{drives.length} optical drives</span></div>
        <div className={styles.worklistRows}>
          {drives.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={styles.worklistRow}
              data-selected={index === selectedIndex}
              onClick={() => onSelect(index)}
              aria-pressed={index === selectedIndex}
            >
              <span className={styles.rowName}><StatusDot state={item.state} />{item.name}</span>
              <span className={styles.rowTitle}>{item.title ?? (item.state === "idle" ? "No disc inserted" : "Unknown disc")}</span>
              <span className={styles.rowPhase}>{item.phase}</span>
              <span className={styles.rowProgress}>{item.progress === null ? "—" : `${Math.round(item.progress)}%`}</span>
              <span className={styles.rowArrow} aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
