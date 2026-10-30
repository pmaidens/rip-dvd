"use client";
import { useEffect, useRef, useState } from "react";
import type { DamagePreviewInspection, DamagePreviewRenditionAvailability, presentBrowserRendition } from "@rip-dvd/application";
import { createMutationKey } from "../lib/mutation-key";
import { ConversionDetails, readRenditionResponse, streamLabel } from "./browser-rendition-details";

type Rendition = ReturnType<typeof presentBrowserRendition>;
type PreviewContext = Pick<DamagePreviewInspection, "generationStatus" | "outdated"> & {
  provenance: { checkpoint?: { manifestRevision: number } | null };
  artifacts: Pick<DamagePreviewInspection["artifacts"][number], "identity" | "coverage" | "coverageMethod">[];
};
export function DamagePreviewBrowserViewing({ artifactIdentity, preview }: { artifactIdentity: string; preview: PreviewContext }) {
  const [availability, setAvailability] = useState<DamagePreviewRenditionAvailability | null>(null);
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [burnSubtitleIndex, setBurnSubtitleIndex] = useState("");
  const [busy, setBusy] = useState(false);
  const submission = useRef<{ mutationKey: string; reviewToken: string; burnSubtitleIndex?: number } | null>(null);
  const selectedRequestId = useRef<string | null>(null);
  const latestRead = useRef(0);
  const storageKey = `damage-preview-browser-rendition:${artifactIdentity}`;
  const endpoint = `/api/damage-preview-media/${encodeURIComponent(artifactIdentity)}/renditions`;
  async function inspect(id: string) {
    if (selectedRequestId.current !== id) return;
    const sequence = ++latestRead.current;
    const current = () => selectedRequestId.current === id && latestRead.current === sequence;
    try {
      const result: Rendition = await readRenditionResponse(await fetch(`/api/browser-renditions/${encodeURIComponent(id)}`, { cache: "no-store" }));
      if (result.id !== id || result.source.identity !== artifactIdentity || !("kind" in result.source) || result.source.kind !== "damage_preview") throw new Error("The saved rendition belongs to a different request or sample.");
      if (current()) setRendition(result);
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : "Sample conditions could not be refreshed."); }
  }
  useEffect(() => {
    const id = sessionStorage.getItem(storageKey);
    if (id) { selectedRequestId.current = id; void inspect(id); }
    return () => { selectedRequestId.current = null; latestRead.current += 1; };
  }, [storageKey, artifactIdentity]);
  const inspectedId = rendition?.id;
  useEffect(() => {
    if (!inspectedId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await inspect(inspectedId);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [inspectedId, artifactIdentity]);
  function review(selected: string) {
    setBusy(true); setError(null); submission.current = null;
    const query = selected === "" ? "" : `?burnSubtitleIndex=${encodeURIComponent(selected)}`;
    void fetch(`${endpoint}${query}`, { cache: "no-store" }).then(readRenditionResponse).then(setAvailability)
      .catch((failure: Error) => { setAvailability(null); setError(failure.message); }).finally(() => setBusy(false));
  }
  const source = rendition && "kind" in rendition.source && rendition.source.kind === "damage_preview" ? rendition.source : availability?.source;
  const condition = rendition?.previewCondition;
  const outdated = condition?.outdated || preview.outdated;
  const generationStatus = source?.generationStatus ?? preview.generationStatus;
  const artifact = preview.artifacts.find((item) => item.identity === artifactIdentity);
  const coverage = source?.coverage ?? artifact?.coverage;
  return <section aria-label="Damage Preview browser viewing">
    <h5>Damage Preview Browser Viewing Rendition</h5>
    <p>This sample illustrates decoding from the recorded source revision. It is not finished Encode Output or a watchability verdict.</p>
    <p>Sample generation: {generationStatus}. {outdated ? "Outdated sample. The source, selection, streams or intended settings changed." : "Sample currency follows the latest inspection."}</p>
    {generationStatus === "partial" ? <p role="alert">Partial sample. Only the recorded actual coverage is available.</p> : null}
    {generationStatus === "interrupted" || generationStatus === "failed" || generationStatus === "cancelled" ? <p role="alert">Sample generation {generationStatus}. Retained media does not imply complete coverage or absence of damage.</p> : null}
    {outdated ? <p role="alert">Outdated labels apply throughout playback. Original provenance is preserved.</p> : null}
    <p>Canonical MKV: {artifactIdentity}. Source revision: {(source?.provenance ?? preview.provenance).checkpoint?.manifestRevision ?? "unknown"}.</p>
    {coverage ? <p>Actual sample coverage: {coverage.startMilliseconds / 1000} s to {coverage.endMilliseconds / 1000} s. Coverage method: {source?.coverageMethod ?? artifact?.coverageMethod ?? "not recorded"}.</p> : null}
    <a href="/viewing-access" target="_blank" rel="noreferrer">Sign in for browser playback</a>
    <button type="button" disabled={busy} onClick={() => review(burnSubtitleIndex)}>Check sample browser playback</button>
    {availability ? <>
      {availability.reasons.map((reason) => <p key={reason.code}>{reason.message} [{reason.code}]</p>)}
      <ConversionDetails source={availability.source} conversion={availability.conversion} />
      <label>Burn one sample subtitle into a separate rendition
        <select value={burnSubtitleIndex} disabled={busy} onChange={(event) => { const selected = event.target.value; setBurnSubtitleIndex(selected); review(selected); }}>
          <option value="">No burned subtitles</option>
          {availability.source.media.streams?.filter((stream) => stream.kind === "subtitle").map((stream) => <option key={stream.index} value={stream.index}>{streamLabel(stream)}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !availability.available} onClick={() => {
        setBusy(true); setError(null); selectedRequestId.current = null; latestRead.current += 1; setRendition(null);
        submission.current ??= { mutationKey: createMutationKey(), reviewToken: availability.reviewToken, ...(burnSubtitleIndex === "" ? {} : { burnSubtitleIndex: Number(burnSubtitleIndex) }) };
        void fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission.current) })
          .then(readRenditionResponse).then((result: Rendition) => { sessionStorage.setItem(storageKey, result.id); selectedRequestId.current = result.id; setRendition(result); })
          .catch((failure: Error) => setError(failure.message)).finally(() => setBusy(false));
      }}>Create sample browser rendition</button>
    </> : null}
    {rendition ? <>
      <p>Rendition {rendition.id}: {rendition.status}{rendition.progress.percent === null ? "" : `, ${Math.floor(rendition.progress.percent)}%`}. This is a separate MP4 derived from the canonical sample MKV.</p>
      <ConversionDetails source={rendition.source} conversion={rendition.conversion} actualMedia={rendition.actualMedia} />
      {rendition.reason ? <p role="alert">{rendition.reason.message} [{rendition.reason.code}]</p> : null}
      <button type="button" onClick={() => { setError(null); void inspect(rendition.id); }}>Refresh sample rendition status</button>
      {rendition.media?.availability.available === false ? <p role="alert">Sample rendition media is unavailable. [{rendition.media.availability.reasonCode}]</p> : null}
      {condition?.canonicalMedia.reasonCode ? <p role="alert">Canonical sample media is unavailable. [{condition.canonicalMedia.reasonCode}]</p> : null}
      {rendition.status === "complete" && rendition.media?.availability.available ? <video aria-label="Damage Preview sample browser rendition" controls playsInline preload="metadata" src={`/api/browser-renditions/${encodeURIComponent(rendition.id)}/media`} onPlay={() => void inspect(rendition.id)} onError={() => setError("The browser could not play this sample rendition. Sample conditions and provenance still apply.")} style={{ width: "100%", maxWidth: "60rem" }} /> : null}
      {source ? <details><summary>Sample source provenance</summary><pre>{JSON.stringify(source.provenance, null, 2)}</pre></details> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
