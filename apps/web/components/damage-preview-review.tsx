"use client";

import { useRef, useState, type FormEvent } from "react";
import { DamagePreviewBrowserViewing } from "./damage-preview-browser-viewing";
import { createMutationKey } from "../lib/mutation-key";
import type { DamagePreviewAvailability, DamagePreviewInspection, DamagePreviewRecreationReview } from "@rip-dvd/application";

function seconds(milliseconds: number): string {
  return `${milliseconds / 1_000} s`;
}

function streamIds(value: string): number[] {
  return value.trim() === "" ? [] : value.split(",").map((item) => item.trim() === "" ? NaN : Number(item.trim()));
}

export function DamagePreviewReview({ archiveId }: { archiveId: string }) {
  const [availability, setAvailability] = useState<DamagePreviewAvailability | null>(null);
  const [review, setReview] = useState<DamagePreviewAvailability | null>(null);
  const [preview, setPreview] = useState<DamagePreviewInspection | null>(null);
  const [recreation, setRecreation] = useState<DamagePreviewRecreationReview | null>(null);
  const recreationKey = useRef<{ token: string; key: string } | null>(null);
  const removalKey = useRef<{ token: string; key: string } | null>(null);
  const requestKey = useRef<{ token: string; key: string } | null>(null);
  const cancelKey = useRef<{ id: string; key: string } | null>(null);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleId, setTitleId] = useState("");
  const [mode, setMode] = useState<"damage" | "ordinary_playback">("damage");
  const [selected, setSelected] = useState<number[]>([]);
  const endpoint = `/api/damage-previews/${encodeURIComponent(archiveId)}/availability`;
  const title = availability?.titles.find((item) => item.observationId === titleId);

  async function load(): Promise<void> {
    if (recreation) { await reviewRecreation(); return; }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Damage Preview availability could not be loaded.");
      const result: DamagePreviewAvailability = await response.json();
      setAvailability(result); setReview(null); setRecreation(null); setSelected([]);
      setTitleId(result.titles[0]?.observationId ?? "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Damage Preview availability could not be loaded.");
    } finally { setBusy(false); }
  }

  async function preflight(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const milliseconds = (name: string) => Math.round(Number(values.get(name)) * 1_000);
    const hasWindowStart = String(values.get("sampling-start") ?? "").trim() !== "";
    const hasWindowEnd = String(values.get("sampling-end") ?? "").trim() !== "";
    if (mode === "damage" && hasWindowStart !== hasWindowEnd) {
      setError("Enter both sampling window boundaries.");
      return;
    }
    const hasWindow = hasWindowStart && hasWindowEnd;
    requestKey.current = null;
    const input = {
      mode,
      titleIdentityObservationId: titleId,
      playbackRange: { startMilliseconds: milliseconds("range-start"), endMilliseconds: milliseconds("range-end") },
      intervalIndexes: mode === "damage" ? selected : [],
      assessmentIdentity: availability?.current.assessmentIdentity ?? null,
      ...(mode === "damage" && hasWindow ? { samplingWindow: { startMilliseconds: milliseconds("sampling-start"), endMilliseconds: milliseconds("sampling-end") } } : {}),
      streams: { audio: streamIds(String(values.get("audio"))), subtitles: streamIds(String(values.get("subtitles"))) },
      context: { beforeMilliseconds: milliseconds("context-before"), afterMilliseconds: milliseconds("context-after") },
      encodingProfileId: String(values.get("profile")),
    };
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(response.status === 400 ? "Check the playback range, sampling window, streams and context." : "Damage Preview review could not be loaded.");
      const currentReview: DamagePreviewAvailability = await response.json();
      if (recreation) {
        const compared = await fetch(`/api/damage-previews/${encodeURIComponent(recreation.sourceRequestId)}/recreate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "review", selection: input }) });
        const result = await compared.json();
        if (!compared.ok) throw new Error(result.error?.message ?? "Recreation differences could not be reviewed.");
        setRecreation(result); setReview(result.preflight);
      } else setReview(currentReview);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Damage Preview review could not be loaded.");
    } finally { setBusy(false); }
  }

  async function requestPreview() {
    if (!review?.available || !review.reviewedRequest) return;
    setBusy(true); setError(null);
    try {
      const selection = review.reviewedRequest;
      if (requestKey.current?.token !== review.preflightToken) requestKey.current = { token: review.preflightToken!, key: createMutationKey() };
      const response = await fetch(`/api/damage-previews/${encodeURIComponent(recreation?.sourceRequestId ?? archiveId)}${recreation ? "/recreate" : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(recreation ? { mode: "current_revision", recreationToken: recreation.recreationToken } : {}), mutationKey: requestKey.current.key, preflightToken: review.preflightToken, selection: {
          mode: selection.mode, titleIdentityObservationId: selection.titleIdentityObservationId,
          playbackRange: selection.playbackRange, intervalIndexes: selection.intervalIndexes,
          assessmentIdentity: selection.requestedAssessmentIdentity, samplingWindow: selection.samplingWindow,
          streams: selection.streams, context: selection.context, encodingProfileId: selection.encodingProfileId,
        } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Damage Preview could not be requested.");
      setPreview(result); setRequestId(result.id); setReview(null); setRecreation(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Damage Preview could not be requested."); }
    finally { setBusy(false); }
  }
  async function inspectPreview(action: "inspect" | "wait" | "cancel") {
    if (!requestId) return;
    setBusy(true); setError(null);
    try {
      if (cancelKey.current?.id !== requestId) cancelKey.current = { id: requestId, key: createMutationKey() };
      const url = `/api/damage-previews/${encodeURIComponent(requestId)}${action === "wait" ? "?timeoutMs=10000" : ""}`;
      const response = await fetch(url, action === "cancel" ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutationKey: cancelKey.current.key }) } : { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Damage Preview could not be inspected.");
      setPreview(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Damage Preview could not be inspected."); }
    finally { setBusy(false); }
  }
  async function reviewRecreation() {
    if (!requestId) return;
    setBusy(true); setError(null); setReview(null);
    try {
      const response = await fetch(`/api/damage-previews/${encodeURIComponent(requestId)}/recreate`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Recreation could not be reviewed.");
      const refreshed: DamagePreviewRecreationReview = result;
      setRecreation(refreshed); setAvailability(refreshed.preflight);
      if (!refreshed.preflight.titles.some((item) => item.observationId === titleId)) { setTitleId(""); setSelected([]); }
      else if (availability?.current.assessmentIdentity !== refreshed.preflight.current.assessmentIdentity) setSelected([]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Recreation could not be reviewed."); }
    finally { setBusy(false); }
  }
  async function requestExactRecreation() {
    if (!recreation?.exact.available) return;
    setBusy(true); setError(null);
    if (recreationKey.current?.token !== recreation.recreationToken) recreationKey.current = { token: recreation.recreationToken, key: createMutationKey() };
    try {
      const response = await fetch(`/api/damage-previews/${encodeURIComponent(recreation.sourceRequestId)}/recreate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "exact", recreationToken: recreation.recreationToken, preflightToken: recreation.preflight.preflightToken, mutationKey: recreationKey.current.key }),
      });
      const result = await response.json();
      if (!response.ok) { setRecreation(null); throw new Error(result.error?.message ?? "Exact recreation could not be requested."); }
      setPreview(result); setRequestId(result.id); setRecreation(null); setReview(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Exact recreation could not be requested."); }
    finally { setBusy(false); }
  }
  async function deleteMedia() {
    if (!preview?.media.deletion.available) return;
    setBusy(true); setError(null);
    if (removalKey.current?.token !== preview.media.token) removalKey.current = { token: preview.media.token, key: createMutationKey() };
    try {
      const response = await fetch(`/api/damage-previews/${encodeURIComponent(preview.id)}/media`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutationKey: removalKey.current.key, mediaToken: preview.media.token }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error?.current) setPreview(result.error.current);
        throw new Error(result.error?.message ?? "Preview media could not be deleted.");
      }
      setPreview(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Preview media could not be deleted."); }
    finally { setBusy(false); }
  }

  return (
    <section className="catalog-pane" aria-label="Damage Preview">
      <h3>Damage Preview</h3>
      <p>Generate a canonical MKV sample from one saved checkpoint, including before catalog mapping. During active Recovery, the request waits for a planned pause. Reviewing does not request work or accept damage.</p>
      <button type="button" disabled={busy} onClick={() => void load()}>{availability === null ? "Review preview availability" : "Refresh preview availability"}</button>
      {error ? <p role="alert">{error}</p> : null}
      {availability !== null ? <>
        <ul>{availability.blockingReasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reason.message}</li>)}</ul>
        {availability.titles.length > 0 ? <form onSubmit={(event) => void preflight(event)} onChange={() => setReview(null)}>
          <fieldset disabled={busy}>
            <legend>Preview selection</legend>
            <label>Identified title
              <select value={titleId} required onChange={(event) => { setTitleId(event.target.value); setSelected([]); }}>
                <option value="" disabled>Choose a current identified title</option>
                {availability.titles.map((item) => <option key={item.observationId} value={item.observationId}>DVD title {item.displayTitleNumber}, angle {item.angleNumber}, chapters {item.chapterStart} to {item.chapterEnd}</option>)}
              </select>
            </label>
            <label>Playback mode
              <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
                <option value="damage">Selected damage intervals</option>
                <option value="ordinary_playback">Ordinary title playback, without a damage seek</option>
              </select>
            </label>
            {mode === "damage" ? <>
              <p>Select individual Estimated Affected Playback markers. Gaps of at most 30 seconds form one group. There is no clip-length cap.</p>
              {title?.estimatedAffectedPlayback?.intervals.map((interval, index) => <label key={index}>
                <input type="checkbox" checked={selected.includes(index)} onChange={(event) => setSelected(event.target.checked ? [...selected, index] : selected.filter((item) => item !== index))} />
                Interval {index + 1}: {seconds(interval.startMilliseconds)} to {seconds(interval.endMilliseconds)}, occurrence {interval.playbackOccurrence}, {interval.coverage === "whole_cell" ? "coarse whole-cell timing" : "source-span timing"}. Methods: {interval.timingMethods.join(", ")}.
              </label>)}
              {(title?.estimatedAffectedPlayback?.unknownCoverage.length ?? 0) > 0 || title?.estimatedAffectedPlayback == null ? <p>Some damage timing is unknown. Ordinary title playback is offered without inventing a damage seek.</p> : null}
              <label>Sampling window start in seconds<input name="sampling-start" type="number" min="0" step="0.001" /></label>
              <label>Sampling window end in seconds<input name="sampling-end" type="number" min="0" step="0.001" /></label>
              <p>A bounded sampling window is required for coarse timing. The review keeps the full uncertain span visible.</p>
            </> : null}
            <label>Playback range start in seconds<input name="range-start" type="number" min="0" step="0.001" defaultValue="0" required /></label>
            <label>Playback range end in seconds<input name="range-end" type="number" min="0" step="0.001" required /></label>
            <p>Choose a range within this title path. Context is clipped only to this range. Actual decoded coverage is not yet verified.</p>
            <label>Context before in seconds<input name="context-before" type="number" min="0" step="0.001" defaultValue="5" required /></label>
            <label>Context after in seconds<input name="context-after" type="number" min="0" step="0.001" defaultValue="5" required /></label>
            <p>Available audio stream IDs: {title?.audioStreams.map((stream) => stream.id).join(", ") || "none"}. Subtitle stream IDs: {title?.subtitles.map((stream) => stream.id).join(", ") || "none"}.</p>
            <label>Audio stream IDs, separated by commas<input name="audio" placeholder="128" /></label>
            <label>Subtitle stream IDs, separated by commas<input name="subtitles" /></label>
            <p>Selected streams are rechecked against the saved title when generation starts. Unsupported streams or settings fail explicitly.</p>
            <label>Intended Encoding Profile
              <select name="profile" required>
                {availability.encodingProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}, version {profile.version}</option>)}
              </select>
            </label>
            <button type="submit">Review preview selections</button>
          </fieldset>
        </form> : null}
      </> : null}
      {review !== null ? <div role="status" aria-live="polite">
        <h4>Reviewed preview</h4>
        <p>Checkpoint {review.current.checkpoint?.manifestRevision ?? "unknown"}. DVD title {review.reviewedRequest?.title?.displayTitleNumber ?? "unavailable"}, angle {review.reviewedRequest?.title?.angleNumber ?? "unknown"}.</p>
        <p>Estimated duration: {review.estimatedDurationMilliseconds === null ? "unknown" : seconds(review.estimatedDurationMilliseconds)}. Estimated storage: unknown.</p>
        <ul>{review.groups.map((group, index) => <li key={index}>Group {index + 1}: {seconds(group.startMilliseconds)} to {seconds(group.endMilliseconds)}. Markers {group.markerIndexes.map((item) => item + 1).join(", ")}.</li>)}</ul>
        <ul>{review.clips.map((clip, index) => <li key={index}>Planned clip {index + 1}: {seconds(clip.startMilliseconds)} to {seconds(clip.endMilliseconds)}.</li>)}</ul>
        {review.uncertainSpans.length > 0 ? <ul>{review.uncertainSpans.map((span) => <li key={span.intervalIndex}>Uncertain span: {seconds(span.startMilliseconds)} to {seconds(span.endMilliseconds)}.</li>)}</ul> : null}
        <ul>{review.knownUnknowns.map((reason) => <li key={reason.code}>{reason.message}</li>)}</ul>
        <ul>{review.blockingReasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reason.code}: {reason.message}</li>)}</ul>
      </div> : null}
      <button type="button" disabled={busy || !review?.available} onClick={() => void requestPreview()}>{recreation ? "Request linked current-revision sample" : "Generate Damage Preview"}</button>
      <label>Damage Preview request identity<input disabled={busy} value={requestId} onChange={(event) => { setRequestId(event.target.value); setRecreation(null); setReview(null); }} /></label>
      <button type="button" disabled={busy || !requestId} onClick={() => void inspectPreview("inspect")}>Refresh preview status</button>
      <button type="button" disabled={busy || !requestId} onClick={() => void inspectPreview("wait")}>Wait for preview</button>
      <button type="button" disabled={busy || !requestId || (preview !== null && !["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(preview.generationStatus))} onClick={() => void inspectPreview("cancel")}>Cancel preview request</button>
      <button type="button" disabled={busy || !requestId} onClick={() => void reviewRecreation()}>Review recreation</button>
      {recreation ? <div aria-label="Damage Preview recreation">
        <p>Original request {recreation.sourceRequestId}. Exact recreation: {recreation.exact.available ? "available" : "unavailable"}.</p>
        {recreation.exact.reasons.map((reason, index) => <p key={`${reason.code}-${index}`}>{reason.code}: {reason.message}</p>)}
        <p>{recreation.warning}</p>
        <details open><summary>Input differences</summary><pre>{JSON.stringify(recreation.differences, null, 2)}</pre></details>
        <button type="button" disabled={busy || !recreation.exact.available} onClick={() => void requestExactRecreation()}>Request exact recreation</button>
        <p>For a current-revision sample, review availability and choose current title, intervals, streams and settings in the form above. Review preview selections again, inspect these differences, then explicitly request the linked current-revision sample.</p>
        <button type="button" disabled={busy} onClick={() => { setRecreation(null); setReview(null); }}>Leave recreation review</button>
      </div> : null}
      {preview ? <div aria-label="Damage Preview request" role="status">
        <p>Request {preview.id}. Status: {preview.status}. Generation: {preview.generationStatus}.</p>
        <p>Reviewed checkpoint verification: {preview.checkpointVerified ? "verified" : ["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(preview.generationStatus) ? "waiting for Recovery and a consistent read" : "not verified"}.</p>
        {preview.recoveryPause ? <p>Planned Recovery pause: {preview.recoveryPause.state}. {preview.recoveryPause.reason.message}</p> : null}
        {preview.reason ? <p>{preview.reason.code}: {preview.reason.message}</p> : null}
        {preview.outdatedReasons.map((reason) => <p key={reason.code}>{reason.message}</p>)}
        <p>{preview.progress.completedClips} of {preview.progress.totalClips} clips. Progress: {preview.progress.percent === null ? "unknown" : `${preview.progress.percent}%`}.</p>
        <p>{preview.warning}</p>
        {preview.recreation ? <div><p>Recreated from request {preview.recreation.sourceRequestId}. Mode: {preview.recreation.mode}. Generation comparison: {preview.recreation.generationComparison}.</p><pre>{JSON.stringify(preview.recreation.generationDifferences, null, 2)}</pre><p>Exact inputs do not promise byte-identical output or watchability.</p></div> : null}
        <p>Media: {preview.media.state}. Deletion preserves the request, selections, generation result, coverage and provenance.</p>
        {preview.media.retention?.protectedForReview ? <p>Current media is protected from routine cleanup while review or finished-output inspection still needs it.</p> : null}
        {preview.media.retention?.awaitingFinishedOutputInspection ? <p>This sample remains protected until inspection of a related finished output is proved.</p> : null}
        {preview.finishedOutputInspection?.outputs.some((output) => output.acknowledgementStatus === "acknowledged") ? <p>{preview.finishedOutputInspection.retentionSatisfied ? "An applicable normal output inspection acknowledgement proves the recorded source relationship. Active Catalog Review still protects current media." : "An output inspection acknowledgement is recorded. Its source relationship or passing validation proof is unavailable, so it does not release retention."}</p> : null}
        {preview.media.removal ? <p>Removal: {preview.media.removal.cause}, {preview.media.removal.state}. Request {preview.media.removal.requestId}.</p> : null}
        {preview.media.removal?.state === "pending" ? <p>Removal is queued for the Encode worker. Refresh preview status to see completion or failure.</p> : null}
        <button type="button" disabled={busy || !preview.media.deletion.available} onClick={() => void deleteMedia()}>Delete preview media</button>
        {preview.media.deletion.reasons.map((reason) => <p key={reason.code}>{reason.message}</p>)}
        {preview.artifacts.map((artifact) => <div key={artifact.identity}><p>
          {artifact.media.state === "retained" ? <a href={`/api/damage-preview-media/${encodeURIComponent(artifact.identity)}`}>Download canonical MKV, {artifact.sizeBytes} bytes</a> : <>Media unavailable: {artifact.media.reasonCode}</>}. Actual coverage: {seconds(artifact.coverage.startMilliseconds)} to {seconds(artifact.coverage.endMilliseconds)}. {preview.status}.
        </p><DamagePreviewBrowserViewing artifactIdentity={artifact.identity} preview={preview} /></div>)}
        <details><summary>Preview provenance</summary><pre>{JSON.stringify(preview.provenance, null, 2)}</pre></details>
      </div> : null}
    </section>
  );
}
