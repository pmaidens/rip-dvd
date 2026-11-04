"use client";

import { DiscVisual, StatusDot } from "./disc-visual";
import type { PrototypeVariantProps } from "./model";
import styles from "./variant-focus.module.css";

const stateLabels = {
  complete: "Archive complete",
  active: "In progress",
  error: "Needs attention",
  idle: "No disc inserted",
  cancelled: "Archive cancelled",
};

function Arrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d={direction === "left" ? "m14 5-7 7 7 7" : "m10 5 7 7-7 7"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function VariantFocus({
  drives,
  selectedIndex,
  onSelect,
  onPrevious,
  onNext,
  onRetry,
}: PrototypeVariantProps) {
  const drive = drives[selectedIndex];
  const completedCount = drives.filter((item) => item.state === "complete").length;
  const activeCount = drives.filter((item) => item.state === "active").length;

  return (
    <section className={styles.focus} aria-label="Focused disc intake design">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>DISC INTAKE</p>
          <h1>Every disc, preserved.</h1>
          <p className={styles.intro}>A clear view of what each drive is doing.</p>
        </div>
        <div className={styles.summary}>
          <span><strong>{activeCount}</strong> in progress</span>
          <span><strong>{completedCount}</strong> complete</span>
        </div>
      </div>

      <div className={styles.driveStrip} aria-label="Optical Drive status">
        {drives.map((item, index) => (
          <button
            className={`${styles.driveChip} ${index === selectedIndex ? styles.selected : ""}`}
            key={item.id}
            type="button"
            onClick={() => onSelect(index)}
            aria-pressed={index === selectedIndex}
            aria-label={`${item.name}, ${stateLabels[item.state]}`}
          >
            <StatusDot state={item.state} />
            <span className={styles.chipName}>{item.name}</span>
            <span className={styles.chipStatus}>{stateLabels[item.state]}</span>
            {item.state === "active" && item.progress !== null && (
              <span className={styles.chipPercent}>{Math.round(item.progress)}%</span>
            )}
          </button>
        ))}
      </div>

      <section className={styles.stage} aria-roledescription="carousel" aria-label="Optical Drives">
        <div className={styles.selectedDrive}>
          <span className={styles.driveNumber}>DRIVE {String(selectedIndex + 1).padStart(2, "0")}</span>
          <h2>{drive.name}</h2>
          <p>{drive.model}</p>
        </div>

        <div className={styles.discRow}>
          <button className={styles.arrow} type="button" onClick={onPrevious} aria-label="Previous Optical Drive">
            <Arrow direction="left" />
          </button>
          <div className={styles.discSpotlight}>
            <div className={styles.spotlight} aria-hidden="true" />
            <DiscVisual drive={drive} size={380} className={styles.disc} />
          </div>
          <button className={styles.arrow} type="button" onClick={onNext} aria-label="Next Optical Drive">
            <Arrow direction="right" />
          </button>
        </div>

        <div className={styles.caption} aria-live="polite" aria-atomic="true">
          <p className={`${styles.phase} ${styles[drive.state]}`}>
            <StatusDot state={drive.state} />
            {drive.phase}
            {drive.progress !== null && <span className={styles.progress}>{Math.round(drive.progress)}%</span>}
          </p>
          <h3>{drive.title ?? (drive.state === "idle" ? "Ready for your next disc" : drive.state === "error" ? "Unidentified disc" : "Identifying disc")}</h3>
          <p className={styles.subtitle}>{drive.subtitle}</p>
          {drive.error && (
            <div className={styles.errorMessage}>
              <p>{drive.error}</p>
              <button type="button" onClick={onRetry}>Try again <span aria-hidden="true">↗</span></button>
            </div>
          )}
        </div>

        <div className={styles.pagination} aria-label="Choose Optical Drive">
          {drives.map((item, index) => (
            <button
              className={index === selectedIndex ? styles.currentDot : ""}
              key={item.id}
              type="button"
              aria-label={`Show ${item.name}`}
              aria-pressed={index === selectedIndex}
              onClick={() => onSelect(index)}
            ><span /></button>
          ))}
        </div>
      </section>

      <dl className={styles.metrics} aria-label="Selected drive details">
        <div><dt>Read so far</dt><dd>{drive.read}<small> / {drive.capacity}</small></dd></div>
        <div><dt>Read speed</dt><dd>{drive.speed}</dd></div>
        <div><dt>Time elapsed</dt><dd>{drive.elapsed}</dd></div>
        <div><dt>{drive.state === "complete" ? "Result" : "Time remaining"}</dt><dd>{drive.state === "complete" ? "Archive saved" : drive.eta}</dd></div>
      </dl>

      <p className={styles.footnote}>
        <span className={styles.footnoteLine} />
        {drive.state === "complete"
          ? "The Original Disc Archive has been saved. This drive is ready for another disc."
          : drive.state === "idle"
            ? "Insert a disc to begin identification."
            : drive.state === "cancelled"
              ? "This Archive Request was cancelled. The disc is not marked complete."
              : drive.state === "error"
              ? "This drive needs your attention. Other drives can continue."
              : "Preserving the disc image. You can switch drives while this continues."}
      </p>
    </section>
  );
}
