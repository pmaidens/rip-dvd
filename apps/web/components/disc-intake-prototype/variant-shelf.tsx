"use client";

import { DiscVisual, StatusDot } from "./disc-visual";
import { ShelfActions } from "./shelf-actions";
import type { PrototypeDrive, PrototypeVariantProps } from "./model";
import styles from "./variant-shelf.module.css";

function stateLabel(state: PrototypeDrive["state"]) {
  return {
    complete: "Archive complete",
    active: "In progress",
    error: "Needs attention",
    idle: "No disc inserted",
    cancelled: "Archive cancelled",
  }[state];
}

export function VariantShelf({
  drives,
  selectedIndex,
  onSelect,
  onPrevious,
  onNext,
  onRetry,
  onCancel,
}: PrototypeVariantProps) {
  const selected = drives[selectedIndex];
  const previousIndex = (selectedIndex - 1 + drives.length) % drives.length;
  const nextIndex = (selectedIndex + 1) % drives.length;
  const previous = drives[previousIndex];
  const next = drives[nextIndex];
  const completedCount = drives.filter((drive) => drive.state === "complete").length;
  const activeCount = drives.filter((drive) => drive.state === "active").length;

  return (
    <main className={styles.shell}>
      <div className={styles.heading}>
        <div>
          <p className={styles.headerEyebrow}>DISC INTAKE</p>
          <h1>Every disc, preserved.</h1>
          <p className={styles.intro}>A clear view of what each drive is doing.</p>
        </div>
        <div className={styles.summary}>
          <span><strong>{activeCount}</strong> in progress</span>
          <span><strong>{completedCount}</strong> complete</span>
        </div>
      </div>
      <div className={styles.driveStrip} aria-label="Optical Drive status">
        {drives.map((drive, index) => (
          <button
            key={drive.id}
            className={`${styles.driveChip} ${index === selectedIndex ? styles.driveSelected : ""}`}
            type="button"
            aria-pressed={index === selectedIndex}
            aria-label={`${drive.name}, ${stateLabel(drive.state)}${drive.state === "active" && drive.progress !== null ? `, ${Math.round(drive.progress)}% copied` : ""}`}
            onClick={() => onSelect(index)}
          >
            <StatusDot state={drive.state} />
            <span className={styles.chipName}>{drive.name}</span>
            <span className={styles.chipStatus}>{stateLabel(drive.state)}</span>
            {drive.state === "active" && drive.progress !== null && (
              <span className={styles.chipPercent}>{Math.round(drive.progress)}%</span>
            )}
          </button>
        ))}
      </div>

      <div className={styles.carouselToolbar}>
        <ShelfActions key={selected.id} drive={selected} onRetry={onRetry} onCancel={onCancel} />
        <div className={styles.pagination}>
          <span className={styles.pageNumber}>{String(selectedIndex + 1).padStart(2, "0")}</span>
          <span className={styles.pageTotal}>/ {String(drives.length).padStart(2, "0")}</span>
          <button type="button" onClick={onPrevious} aria-label="Previous drive">←</button>
          <button type="button" onClick={onNext} aria-label="Next drive">→</button>
        </div>
      </div>

      <section className={styles.carousel} aria-label="Drive carousel" aria-roledescription="carousel">
        <div className={styles.shelfLine} />
        <button
          type="button"
          className={`${styles.neighbor} ${styles.previous}`}
          onClick={() => onSelect(previousIndex)}
          aria-label={`Select ${previous.name}, ${stateLabel(previous.state)}`}
        >
          <div className={styles.neighborDisc}><DiscVisual drive={previous} size={230} compact /></div>
          <div className={styles.neighborText}>
            <span><StatusDot state={previous.state} /> {previous.name}</span>
            <strong>{previous.title ?? (previous.state === "idle" ? "No disc inserted" : "Unidentified disc")}</strong>
            <small>{previous.phase}</small>
          </div>
        </button>

        <div className={styles.current} aria-label={`${selected.name}, selected drive`}>
          <div className={styles.selectedTag}><StatusDot state={selected.state} /> {selected.name}</div>
          <div className={styles.disc}><DiscVisual drive={selected} size={375} /></div>
          <div className={`${styles.phase} ${styles[selected.state]}`}>
            {selected.phase}
            {selected.progress !== null && <span>{Math.round(selected.progress)}%</span>}
          </div>
        </div>

        <button
          type="button"
          className={`${styles.neighbor} ${styles.next}`}
          onClick={() => onSelect(nextIndex)}
          aria-label={`Select ${next.name}, ${stateLabel(next.state)}`}
        >
          <div className={styles.neighborDisc}><DiscVisual drive={next} size={230} compact /></div>
          <div className={styles.neighborText}>
            <span><StatusDot state={next.state} /> {next.name}</span>
            <strong>{next.title ?? (next.state === "idle" ? "No disc inserted" : "Unidentified disc")}</strong>
            <small>{next.phase}</small>
          </div>
        </button>
      </section>

      <div className={styles.positionDots} aria-label="Select drive">
        {drives.map((drive, index) => (
          <button
            key={drive.id}
            type="button"
            aria-label={`Select ${drive.name}`}
            aria-pressed={index === selectedIndex}
            className={index === selectedIndex ? styles.currentDot : ""}
            onClick={() => onSelect(index)}
          ><span /></button>
        ))}
      </div>

      <section className={styles.details} aria-live="polite" aria-label="Selected drive details">
        <div className={styles.identity}>
          <p className={styles.eyebrow}>{selected.model}</p>
          <h2>{selected.title ?? (selected.state === "idle" ? "Ready for your next disc" : selected.state === "error" ? "Unidentified disc" : "Identifying disc")}</h2>
          <p>{selected.subtitle}</p>
        </div>
        <dl className={styles.metrics}>
          <div><dt>Read so far</dt><dd>{selected.read}<span> / {selected.capacity}</span></dd></div>
          <div><dt>Read speed</dt><dd>{selected.speed}</dd></div>
          <div><dt>{selected.state === "complete" ? "Finished in" : "Time remaining"}</dt><dd>{selected.state === "complete" ? selected.elapsed : selected.eta}</dd></div>
        </dl>
      </section>

      {selected.error && (
        <div className={styles.attentionBanner} role="status">
          <div><strong>This drive needs attention</strong><p>{selected.error}</p></div>
        </div>
      )}
      {selected.state === "idle" && <p className={styles.helper}>Insert a disc to identify it and begin archiving.</p>}
      {selected.state === "cancelled" && <p className={styles.helper}>Archive Request cancelled. This disc has not been marked complete.</p>}
    </main>
  );
}
