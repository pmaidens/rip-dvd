"use client";

// Three throwaway Disc intake designs on /discs?variant=A, B or C.
// All actions below change synthetic browser memory only.
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createDemoDrives, type PrototypeDrive, type PrototypeVariantProps } from "./model";
import { VariantFocus } from "./variant-focus";
import { VariantShelf } from "./variant-shelf";
import { VariantConsole } from "./variant-console";
import styles from "./prototype.module.css";

const variants = [
  { key: "A", name: "Focus", description: "One drive at a time, with a large centered disc." },
  { key: "B", name: "Carousel", description: "Neighboring discs stay visible as you browse." },
  { key: "C", name: "Console", description: "Disc artwork and drive details side by side." },
] as const;

type Scenario = "archiving" | "complete" | "metadata" | "read-error" | "detection" | "identifying" | "idle" | "cancelled";

function scenarioFor(drive: PrototypeDrive): Scenario {
  if (drive.state === "idle") return "idle";
  if (drive.state === "cancelled") return "cancelled";
  if (drive.state === "complete") return "complete";
  if (drive.state === "active") return drive.progress === null ? "identifying" : "archiving";
  if (drive.phase === "Drive not detected") return "detection";
  return drive.title ? "read-error" : "metadata";
}

function withScenario(drive: PrototypeDrive, scenario: Scenario): PrototypeDrive {
  const sample = { ...createDemoDrives()[0], id: drive.id, name: drive.name, model: drive.model };
  switch (scenario) {
    case "archiving": return { ...sample, title: drive.title ?? sample.title, artwork: drive.title ? drive.artwork : sample.artwork, progress: 64 };
    case "complete": return { ...sample, state: "complete", phase: "Archive complete", progress: 100, title: "A Quiet Tide", artwork: "tide", subtitle: "Drama · Sample DVD", speed: "Finished", eta: "Complete", elapsed: "21:08", read: sample.capacity };
    case "metadata": return { ...createDemoDrives()[2], id: drive.id, name: drive.name, model: drive.model };
    case "read-error": return { ...sample, state: "error", phase: "Archive Job failed", progress: 38, title: "The Hidden Grove", artwork: "grove", subtitle: "Adventure · Sample DVD", speed: "Stopped", eta: "Unavailable", read: "2.70 GB", error: "The drive stopped responding while reading the disc. Check the connection and disc surface, then retry archiving." };
    case "detection": return { ...sample, state: "error", phase: "Drive not detected", progress: null, title: null, artwork: null, subtitle: "Check the drive connection", speed: "Unavailable", eta: "Unavailable", elapsed: "00:00", read: "Unknown", capacity: "Unknown", error: "This Optical Drive is unavailable. Reconnect the drive or check its power, then try again." };
    case "identifying": return { ...sample, state: "active", phase: "Inspecting disc", progress: null, title: null, artwork: null, subtitle: "Reading disc identity and metadata", speed: "Inspecting", eta: "Calculating", elapsed: "00:09", read: "Unknown", capacity: "Unknown" };
    case "idle": return { ...createDemoDrives()[3], id: drive.id, name: drive.name, model: drive.model };
    case "cancelled": return { ...sample, state: "cancelled", phase: "Archive cancelled", speed: "Stopped", eta: "Cancelled" };
  }
}

export function DiscIntakePrototype({ variant }: { variant: "A" | "B" | "C" }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [drives, setDrives] = useState(createDemoDrives);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState("");
  const selected = drives[selectedIndex];
  const current = variants.find((item) => item.key === variant) ?? variants[0];

  const chooseVariant = useCallback((key: string) => {
    const query = new URLSearchParams(params.toString());
    query.set("variant", key);
    router.replace(`${pathname}?${query}`, { scroll: false });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [params, pathname, router]);
  const cycleVariant = useCallback((offset: number) => {
    const index = variants.findIndex((item) => item.key === variant);
    chooseVariant(variants[(index + offset + variants.length) % variants.length].key);
  }, [chooseVariant, variant]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycleVariant(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleVariant]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setDrives((previous) => previous.map((drive) => {
        if (drive.state !== "active") return drive;
        if (drive.progress === null) return withScenario(drive, "archiving");
        const progress = Math.min(100, drive.progress + 2);
        return { ...drive, progress, read: `${(7.1 * progress / 100).toFixed(2)} GB`, state: progress === 100 ? "complete" : "active", phase: progress === 100 ? "Archive complete" : "Archiving disc", eta: progress === 100 ? "Complete" : `About ${Math.max(1, Math.round((100 - progress) / 4.5))} min`, speed: progress === 100 ? "Finished" : "6.2×" };
      }));
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing]);

  function updateSelected(update: (drive: PrototypeDrive) => PrototypeDrive) {
    setDrives((previous) => previous.map((drive, index) => index === selectedIndex ? update(drive) : drive));
    setNotice("");
  }

  const props: PrototypeVariantProps = {
    drives, selectedIndex,
    onSelect: (index) => { setSelectedIndex(index); setNotice(""); },
    onPrevious: () => { setSelectedIndex((index) => (index - 1 + drives.length) % drives.length); setNotice(""); },
    onNext: () => { setSelectedIndex((index) => (index + 1) % drives.length); setNotice(""); },
    onRetry: () => {
      updateSelected((drive) => drive.state === "cancelled" ? { ...drive, state: "active", phase: "Archiving disc", progress: 0, read: "0 GB", elapsed: "00:00", error: null, speed: "6.2×", eta: "Calculating" } : drive.title ? { ...drive, state: "active", phase: "Archiving disc", error: null, speed: "6.2×", eta: "Calculating" } : withScenario(drive, "identifying"));
      setNotice("Sample archive activity started. Play progress to watch it continue.");
    },
    onCancel: (driveId) => {
      setDrives((previous) => previous.map((drive) => drive.id === driveId && (drive.state === "active" || drive.state === "error") && drive.progress !== null ? { ...drive, state: "cancelled", phase: "Archive cancelled", error: null, speed: "Stopped", eta: "Cancelled" } : drive));
      setNotice("Sample cancellation submitted. Other drives are unchanged.");
    },
  };

  return (
    <div className={styles.prototype}>
      <aside className={styles.demoBar} aria-label="Prototype controls">
        <div className={styles.demoLabel}><span>DESIGN STUDY</span><p>Sample drives. Changes stay in this preview.</p></div>
        <details className={styles.controls}>
          <summary>Try a state <span aria-hidden="true">⌄</span></summary>
          <div className={styles.controlPanel}>
            <div className={styles.controlHeading}><strong>Try the design with {selected.name}</strong><span>Use the drive chips or carousel to select another drive.</span></div>
            <label>Drive state<select value={scenarioFor(selected)} onChange={(event) => { setPlaying(false); updateSelected((drive) => withScenario(drive, event.target.value as Scenario)); }}>
              <option value="archiving">Archiving</option><option value="complete">Archive complete</option><option value="identifying">Inspecting disc</option><option value="metadata">Metadata problem</option><option value="read-error">Archive read error</option><option value="detection">Drive not detected</option><option value="idle">Empty drive</option><option value="cancelled">Archive cancelled</option>
            </select></label>
            <label>Archive progress <span>{selected.progress === null ? "Unavailable" : `${selected.progress}%`}</span><input aria-label="Sample archive progress" type="range" min="0" max="100" value={selected.progress ?? 0} disabled={selected.state !== "active" || selected.progress === null} onChange={(event) => {
              const progress = Number(event.target.value);
              updateSelected((drive) => ({ ...drive, progress, read: `${(7.1 * progress / 100).toFixed(2)} GB`, state: progress === 100 ? "complete" : "active", phase: progress === 100 ? "Archive complete" : "Archiving disc", eta: progress === 100 ? "Complete" : `About ${Math.max(1, Math.round((100 - progress) / 4.5))} min`, speed: progress === 100 ? "Finished" : "6.2×" }));
            }} /></label>
            <label className={styles.check}><input type="checkbox" checked={selected.artwork !== null} disabled={!selected.title} onChange={(event) => updateSelected((drive) => ({ ...drive, artwork: event.target.checked ? (drive.title === "A Quiet Tide" ? "tide" : drive.title === "The Hidden Grove" ? "grove" : "orbit") : null }))} /> Show cover art and title logo</label>
            <div className={styles.controlActions}><button type="button" aria-pressed={playing} onClick={() => setPlaying((value) => !value)}>{playing ? "Pause progress" : "Play progress"}</button><button type="button" onClick={() => { setDrives(createDemoDrives()); setSelectedIndex(0); setPlaying(false); setNotice(""); }}>Reset samples</button></div>
            <details className={styles.state}><summary>View sample state</summary><pre>{JSON.stringify({ variant, selectedDrive: selected.name, drives }, null, 2)}</pre></details>
          </div>
        </details>
      </aside>
      <div className={styles.variantDescription} aria-live="polite">{variant} / {current.name}<span>{current.description}</span></div>
      {variant === "A" ? <VariantFocus {...props} /> : variant === "B" ? <VariantShelf {...props} /> : <VariantConsole {...props} />}
      <div role="status" className={styles.notice}>{notice}</div>
      <nav className={styles.switcher} aria-label="Design variations">
        <button type="button" onClick={() => cycleVariant(-1)} aria-label="Previous design variation">←</button>
        <div className={styles.switcherLabel}><small>PROTOTYPE</small><span>{variant} · {current.name}</span></div>
        <div className={styles.variantButtons}>{variants.map((item) => <button key={item.key} type="button" aria-label={`Design ${item.key}: ${item.name}`} aria-pressed={variant === item.key} onClick={() => chooseVariant(item.key)}>{item.key}</button>)}</div>
        <button type="button" onClick={() => cycleVariant(1)} aria-label="Next design variation">→</button>
      </nav>
    </div>
  );
}
