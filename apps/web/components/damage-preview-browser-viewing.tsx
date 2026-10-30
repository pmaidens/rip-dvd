"use client";
import type { DamagePreviewInspection } from "@rip-dvd/application";
import { useBrowserRendition } from "./use-browser-rendition";
import { ConversionDetails, streamLabel } from "./browser-rendition-details";

type PreviewContext = Pick<DamagePreviewInspection, "generationStatus" | "outdated"> & {
  provenance: { checkpoint?: { manifestRevision: number } | null };
  artifacts: Pick<DamagePreviewInspection["artifacts"][number], "identity" | "coverage" | "coverageMethod">[];
};
export function DamagePreviewBrowserViewing({ artifactIdentity, preview }: { artifactIdentity: string; preview: PreviewContext }) {
  const { availability, rendition, error, busy, burnSubtitleIndex, review, selectSubtitle, create, refresh, reportPlaybackError } = useBrowserRendition({ artifactIdentity, sourceKind: "damage_preview", pollTerminal: true });
  const candidate = rendition?.source ?? availability?.source;
  const source = candidate && "kind" in candidate && candidate.kind === "damage_preview" ? candidate : undefined;
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
    <button type="button" disabled={busy} onClick={() => review()}>Check sample browser playback</button>
    {availability ? <>
      {availability.reasons.map((reason) => <p key={reason.code}>{reason.message} [{reason.code}]</p>)}
      <ConversionDetails source={availability.source} conversion={availability.conversion} />
      <label>Burn one sample subtitle into a separate rendition
        <select value={burnSubtitleIndex} disabled={busy} onChange={(event) => selectSubtitle(event.target.value)}>
          <option value="">No burned subtitles</option>
          {availability.source.media.streams?.filter((stream) => stream.kind === "subtitle").map((stream) => <option key={stream.index} value={stream.index}>{streamLabel(stream)}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !availability.available} onClick={create}>Create sample browser rendition</button>
    </> : null}
    {rendition ? <>
      <p>Rendition {rendition.id}: {rendition.status}{rendition.progress.percent === null ? "" : `, ${Math.floor(rendition.progress.percent)}%`}. This is a separate MP4 derived from the canonical sample MKV.</p>
      <ConversionDetails source={rendition.source} conversion={rendition.conversion} actualMedia={rendition.actualMedia} />
      {rendition.reason ? <p role="alert">{rendition.reason.message} [{rendition.reason.code}]</p> : null}
      <button type="button" onClick={refresh}>Refresh sample rendition status</button>
      {rendition.media?.availability.available === false ? <p role="alert">Sample rendition media is unavailable. [{rendition.media.availability.reasonCode}]</p> : null}
      {condition?.canonicalMedia.reasonCode ? <p role="alert">Canonical sample media is unavailable. [{condition.canonicalMedia.reasonCode}]</p> : null}
      {rendition.status === "complete" && rendition.media?.availability.available ? <video aria-label="Damage Preview sample browser rendition" controls playsInline preload="metadata" src={`/api/browser-renditions/${encodeURIComponent(rendition.id)}/media`} onPlay={refresh} onError={() => reportPlaybackError("The browser could not play this sample rendition. Sample conditions and provenance still apply.")} style={{ width: "100%", maxWidth: "60rem" }} /> : null}
      {source ? <details><summary>Sample source provenance</summary><pre>{JSON.stringify(source.provenance, null, 2)}</pre></details> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
