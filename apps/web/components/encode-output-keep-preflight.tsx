"use client";

import { useState } from "react";
import type { EncodeOutputKeepPreflight } from "@rip-dvd/application";
import { displayTerm } from "../lib/display-term";

export function EncodeOutputKeepPreflightPanel({ artifactIdentity }: { artifactIdentity: string }) {
  const [preview, setPreview] = useState<EncodeOutputKeepPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    try {
      const query = preview?.previewToken === null || preview === null
        ? ""
        : `?preview-token=${encodeURIComponent(preview.previewToken)}`;
      const response = await fetch(`/api/encode-outputs/${encodeURIComponent(artifactIdentity)}/keep-preflight${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Keep preflight unavailable");
      setPreview(await response.json() as EncodeOutputKeepPreflight);
    } catch {
      setPreview(null);
      setError("Keep preflight is unavailable. Retry to review current evidence.");
    } finally {
      setLoading(false);
    }
  }

  return <section aria-label="Keep preflight">
    <h5>Keep preflight</h5>
    <p>Review the failed output before a separate Keep decision. Keep preserves a failed artifact separately from normal library outputs.</p>
    <button type="button" disabled={loading} onClick={() => { void loadPreview(); }}>
      {loading ? "Checking Keep evidence..." : preview === null ? "Preview Keep" : "Refresh Keep preflight"}
    </button>
    {error === null ? null : <p role="alert">{error}</p>}
    {preview === null ? null : <div>
      <p role="status">{preview.eligible ? "Complete stable output available for a Keep decision." : "Keep is unavailable for the current evidence."}</p>
      {preview.review.status === "stale" ? <p role="alert">The earlier Keep preview is stale. Review the current evidence below. {preview.review.reasonCode}</p> : null}
      <dl>
        <div><dt>Reviewed artifact</dt><dd>{preview.artifact.identity}</dd></div>
        <div><dt>Reviewed validation</dt><dd>{preview.current.validationIdentity ?? "Not recorded"}</dd></div>
        <div><dt>Complete write</dt><dd>{displayTerm(preview.artifact.file.completeness)}</dd></div>
        <div><dt>Complete-write proof</dt><dd>{displayTerm(preview.completeWrite.status)} · {preview.completeWrite.recordedFileIdentity ?? "No recorded file identity"}</dd></div>
        <div><dt>Complete-file SHA-256</dt><dd>{preview.completeWrite.sha256 ?? "Unknown"}</dd></div>
        <div><dt>Reviewed file identity</dt><dd>{preview.current.fileIdentity ?? "Unknown"}</dd></div>
        <div><dt>Reviewed file revision</dt><dd>{preview.current.fileRevision ?? "Unknown"}</dd></div>
        <div><dt>Reviewed authority</dt><dd>{preview.current.authorityRevision}</dd></div>
        <div><dt>Failure details</dt><dd>{preview.artifact.validation.failure === undefined ? "Not recorded" : JSON.stringify(preview.artifact.validation.failure)}</dd></div>
        <div><dt>Immutable source snapshot</dt><dd>{preview.artifact.provenance.sourceSnapshot === null ? "Not recorded" : JSON.stringify(preview.artifact.provenance.sourceSnapshot)}</dd></div>
        <div><dt>Source snapshot identity</dt><dd>{preview.current.sourceSnapshotIdentity ?? "Not recorded"}</dd></div>
        <div><dt>Current inspectability</dt><dd>{displayTerm(preview.artifact.inspectability.status)}{preview.artifact.inspectability.reason === null ? "" : ` · ${preview.artifact.inspectability.reason}`}</dd></div>
        <div><dt>Normal destination</dt><dd>{displayTerm(preview.normalDestination.status)} · {preview.normalDestination.fileIdentity ?? "No file identity available"}</dd></div>
        <div><dt>Existing normal output</dt><dd>{preview.normalDestination.normalOutput === null ? "None recorded" : JSON.stringify(preview.normalDestination.normalOutput)}</dd></div>
        <div><dt>Destination evidence revision</dt><dd>{preview.current.destinationRevision}</dd></div>
        <div><dt>Required acknowledgement</dt><dd>{preview.requiredAcknowledgement.message}</dd></div>
      </dl>
      {preview.blockers.length === 0 ? null : <ul aria-label="Keep blockers">{preview.blockers.map((blocker) => <li key={blocker.code}>{blocker.code} · {blocker.message}</li>)}</ul>}
      <p>Playability remains unassessed. A media probe failure can leave inspectability unknown for a complete stable file.</p>
      {preview.previewToken === null ? null : <details><summary>Keep preview token</summary><p>{preview.previewToken}</p></details>}
    </div>}
  </section>;
}
