"use client";

import { useEffect, useRef, useState } from "react";
import type { EncodeOutputInspection, EncodeOutputIntervalInspection } from "@rip-dvd/application";

type Snapshot = EncodeOutputInspection["artifact"]["provenance"]["sourceSnapshot"];
type Target = NonNullable<EncodeOutputIntervalInspection["viewing"]>["targets"][number];
const intervalLabel = (interval: { startMilliseconds: number; endMilliseconds: number }) =>
  `${interval.startMilliseconds / 1000} to ${interval.endMilliseconds / 1000} seconds`;

export function EncodeOutputCorrespondence({ artifactIdentity, snapshot, renditionId, authorityRevision, fileMutationRevision, onSeek }: {
  artifactIdentity: string; snapshot: Snapshot; renditionId: string | null;
  authorityRevision: string; fileMutationRevision: string | null;
  onSeek(target: Target, mediaIdentity: string): void;
}) {
  const [selection, setSelection] = useState("");
  const [result, setResult] = useState<EncodeOutputIntervalInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, []);
  const choices = snapshot?.source.assessment.items.flatMap((item) => item.estimatedAffectedPlayback?.intervals.map((interval, index) => ({
    value: JSON.stringify({ assessmentIdentity: snapshot.source.assessment.id, titleIdentityObservationId: item.titleIdentityObservationId, intervalIndexes: [index] }),
    label: `Title identity ${item.titleIdentityObservationId}, interval ${index + 1}: ${intervalLabel(interval)}, ${interval.coverage}`,
  })) ?? []) ?? [];
  async function inspect(seek: boolean) {
    const requestSequence = ++sequence.current;
    setBusy(true); setError(null); setResult(null);
    try {
      const query = { ...JSON.parse(selection), ...(renditionId ? { renditionId } : {}) };
      const response = await fetch(`/api/encode-outputs/${encodeURIComponent(artifactIdentity)}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Output correspondence is unavailable.");
      const inspected = body as EncodeOutputIntervalInspection;
      if (sequence.current !== requestSequence) return;
      if (inspected.inspection.artifact.identity !== artifactIdentity || inspected.inspection.authorityRevision !== authorityRevision ||
          inspected.inspection.artifact.file.mutationRevision !== fileMutationRevision ||
          JSON.stringify(inspected.query) !== JSON.stringify(query)) throw new Error("Output evidence changed. Refresh the output inspection before checking correspondence.");
      setResult(inspected);
      if (seek) {
        const target = inspected.viewing?.targets[0];
        if (!target || inspected.viewing?.renditionId !== renditionId || !inspected.viewing.mediaIdentity) throw new Error("A proved seek into this rendition is no longer available. Ordinary playback remains available.");
        onSeek(target, inspected.viewing.mediaIdentity);
      }
    } catch (failure) {
      if (sequence.current === requestSequence) setError(failure instanceof Error ? failure.message : "Output correspondence is unavailable.");
    } finally { if (sequence.current === requestSequence) setBusy(false); }
  }
  return <section aria-label="Encode Output correspondence">
    <h6>Estimated Affected Playback in this Encode Output</h6>
    <p>Checks the output's immutable source assessment. Source estimates, Damage Previews and percentages do not establish an output location.</p>
    {choices.length ? <>
      <label>Estimated Affected Playback interval
        <select style={{ maxWidth: "100%" }} value={selection} onChange={(event) => { sequence.current += 1; setSelection(event.target.value); setResult(null); setError(null); setBusy(false); }}>
          <option value="">Choose a recorded interval</option>
          {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !selection} onClick={() => { void inspect(false); }}>Check output correspondence</button>
    </> : <p>Recorded affected intervals are unavailable. Correspondence is unknown; ordinary playback remains available.</p>}
    {result?.intervals.map((interval) => <div key={interval.intervalIndex}>
      <p>Correspondence: {interval.status}. {interval.reason} [{interval.reasonCode}]</p>
      {interval.status === "verified" && interval.outputInterval ? <p>Evidenced canonical output interval: {intervalLabel(interval.outputInterval)}. Canonical seek target: {interval.outputInterval.startMilliseconds / 1000} seconds.</p> : null}
    </div>)}
    {result?.viewing?.reason ? <p>{result.viewing.reason} [{result.viewing.reasonCode}]</p> : null}
    {result && !renditionId ? <p>Create or restore a complete Browser Viewing Rendition to check its seek target.</p> : null}
    {result?.viewing?.targets.map((target) => <div key={target.intervalIndex}>
      <p>Separate rendition interval: {intervalLabel(target.renditionInterval)}. Rendition seek target: {target.seekSeconds} seconds.</p>
      <button type="button" disabled={busy} onClick={() => { void inspect(true); }}>Seek to verified output interval</button>
    </div>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
