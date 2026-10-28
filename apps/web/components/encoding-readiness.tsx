"use client";

import { useEffect, useState } from "react";
import type { EncodingReadiness } from "@rip-dvd/application";

interface ArchivePage {
  archives: { id: string; label: string }[];
  page: { offset: number; limit: number; hasNext: boolean };
}

export function EncodingReadinessPanel({ revision }: { revision: number }) {
  const [offset, setOffset] = useState(0);
  const [archives, setArchives] = useState<ArchivePage | null>(null);
  const [archiveId, setArchiveId] = useState("");
  const [loaded, setLoaded] = useState<{
    archiveId: string; revision: number; refresh: number; value: EncodingReadiness;
  } | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const readiness = loaded?.archiveId === archiveId && loaded.revision === revision && loaded.refresh === refresh
    ? loaded.value : null;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/encode-readiness?offset=${offset}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json() as ArchivePage;
        if (!controller.signal.aborted) { setArchives(value); setArchiveError(null); }
      }).catch(() => {
        if (!controller.signal.aborted) setArchiveError("Archive choices are unavailable.");
      });
    return () => controller.abort();
  }, [offset, revision]);
  useEffect(() => {
    if (!archiveId) return;
    const controller = new AbortController();
    void fetch(`/api/encode-readiness?archiveId=${encodeURIComponent(archiveId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json() as EncodingReadiness;
        if (!controller.signal.aborted) { setLoaded({ archiveId, revision, refresh, value }); setReadinessError(null); }
      }).catch(() => {
        if (!controller.signal.aborted) { setLoaded(null); setReadinessError("Encoding readiness is unavailable. Refresh to try again."); }
      });
    return () => controller.abort();
  }, [archiveId, revision, refresh]);
  return <section className="encoding-readiness" aria-labelledby="encoding-readiness-title">
    <h2 id="encoding-readiness-title">Source readiness</h2>
    <p>Inspect the current source and decisions before encoding. New-format encode admission remains closed.</p>
    <label>Original Disc Archive
      <select value={archiveId} onChange={(event) => {
        setArchiveId(event.target.value); setLoaded(null); setReadinessError(null);
      }}>
        <option value="">Select an archive</option>
        {archiveId && !archives?.archives.some(({ id }) => id === archiveId)
          ? <option value={archiveId}>{archiveId}</option> : null}
        {archives?.archives.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous archives</button>
    <button type="button" disabled={!archives?.page.hasNext} onClick={() => setOffset(offset + 50)}>Next archives</button>
    <button type="button" disabled={!archiveId} onClick={() => { setLoaded(null); setReadinessError(null); setRefresh(refresh + 1); }}>Refresh readiness</button>
    {archiveError ? <p role="alert">{archiveError}</p> : null}
    {readinessError ? <p role="alert">{readinessError}</p> : null}
    {archiveId && readiness === null && readinessError === null ? <p role="status">Loading readiness...</p> : null}
    {readiness === null ? null : !readiness.applicable ? <p>{readiness.message}</p> : <div>
      <p role="status">{readiness.sourceReady ? "Source ready" : "Source blocked"}. Encode admission is closed.</p>
      <p>Archive Integrity: {readiness.recordedIntegrity}. Recovery: {readiness.current.recovery?.state ?? "unavailable"}.
        Assessment: {readiness.assessment.state}.</p>
      <details><summary>Current evidence identities</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(readiness.current, null, 2)}</pre></details>
      <ol>{readiness.blockingReasons.map((reason, index) => <li key={`${reason.code}-${index}`}>
        <code>{reason.code}</code>: {reason.message}
        {typeof reason.details.discSelectionId === "string" ? <small> Selection {reason.details.discSelectionId}</small> : null}
      </li>)}</ol>
      <ul>{readiness.selections.map((selection) => <li key={selection.discSelectionId}>
        <strong>{selection.mediaTitle ?? `Selection ${selection.discSelectionId}`}</strong>
        {selection.label ? <p>{selection.label}</p> : null}
        <p>Impact: {selection.assessment.impact}. Source-continuity risk: {selection.assessment.sourceContinuityRisk ? "present" : "none recorded"}.
          Acceptance: {selection.acceptanceRequired === null ? "awaiting assessment" : !selection.acceptanceRequired ? "not required" : selection.acceptanceSatisfied ? "current" : "required"}.</p>
        <details><summary>Concrete source and identities</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({
          selectionIdentity: selection.selectionIdentity, titleIdentityId: selection.titleIdentityId,
          titleIdentityObservationId: selection.titleIdentityObservationId, resolvedSource: selection.resolvedSource,
        }, null, 2)}</pre></details>
      </li>)}</ul>
    </div>}
  </section>;
}
