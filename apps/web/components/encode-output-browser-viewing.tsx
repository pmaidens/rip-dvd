"use client";

import { createMutationKey } from "../lib/mutation-key";
import { useEffect, useRef, useState } from "react";
import type { BrowserRenditionAvailability, presentBrowserRendition } from "@rip-dvd/application";

type Rendition = ReturnType<typeof presentBrowserRendition>;
function audioInventoryLabel(streams: Rendition["source"]["media"]["streams"]) {
  return streams === null ? "unknown inventory" : streams.filter((stream) => stream.kind === "audio")
    .map((stream) => `${stream.codecName ?? "unknown"} ${stream.language ?? "language unknown"}`).join(", ") || "none";
}
async function readResponse(response: Response) {
  if (response.status === 401) throw new Error("Sign in for browser playback, then try again.");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error?.code ?? "Browser playback is unavailable.");
  return body;
}
export function EncodeOutputBrowserViewing({ artifactIdentity, validationFailed, sourceAuthorityRevision, sourceFileMutationRevision }: { artifactIdentity: string; validationFailed: boolean; sourceAuthorityRevision: string; sourceFileMutationRevision: string | null }) {
  const [availability, setAvailability] = useState<BrowserRenditionAvailability | null>(null);
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submission = useRef<{ mutationKey: string; reviewToken: string } | null>(null);
  const selectedRequestId = useRef<string | null>(null);
  const latestRead = useRef(0);
  const storageKey = `encode-output-browser-rendition:${artifactIdentity}`;
  const inspect = async (id: string) => {
    if (selectedRequestId.current !== id) return;
    const sequence = ++latestRead.current;
    const current = () => selectedRequestId.current === id && latestRead.current === sequence;
    try {
      const result: Rendition = await readResponse(await fetch(`/api/browser-renditions/${encodeURIComponent(id)}`, { cache: "no-store" }));
      if (result.id !== id || result.source.identity !== artifactIdentity) throw new Error("The saved rendition belongs to a different request or Encode Output.");
      if (current()) setRendition(result);
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : "Rendition inspection is unavailable."); }
  };
  useEffect(() => {
    const id = sessionStorage.getItem(storageKey);
    if (id) { selectedRequestId.current = id; void inspect(id); }
  }, [storageKey, artifactIdentity]);
  const activeId = rendition && ["queued", "generating"].includes(rendition.status) ? rendition.id : null;
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await inspect(activeId);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeId, artifactIdentity]);
  return <section aria-label="Browser Viewing Rendition">
    <h5>Browser Viewing Rendition</h5>
    <p>Ordinary playback of a finished Encode Output. Source correspondence may be unknown. No damage seek is claimed.</p>
    {validationFailed || rendition?.source.state === "validation_failed" ? <p role="alert">Validation-failed source. Viewing does not change Encode Job status, validate the output or record a Keep decision.</p> : null}
    <p>This separate MP4 copies compatible video and audio from the canonical MKV. It does not replace that file or establish watchability.</p>
    <a href="/viewing-access" target="_blank" rel="noreferrer">Sign in for browser playback</a>
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError(null); submission.current = null;
      void fetch(`/api/encode-outputs/${encodeURIComponent(artifactIdentity)}/renditions`, { cache: "no-store" })
        .then(readResponse).then(setAvailability).catch((failure: Error) => setError(failure.message)).finally(() => setBusy(false));
    }}>Check browser playback</button>
    {availability ? <>
      {availability.reasons.map((reason) => <p key={reason.code}>{reason.message} [{reason.code}]</p>)}
      <p>Audio: {audioInventoryLabel(availability.source.media.streams)}.</p>
      <p>{availability.conversion.subtitles === "omitted" ? "Soft subtitles, including DVD bitmap subtitles, are omitted. No subtitles are burned in." : availability.conversion.subtitles === "unknown" ? "Subtitle inventory is unknown." : "No subtitles are present."}</p>
      <button type="button" disabled={busy || !availability.available} onClick={() => {
        setBusy(true); setError(null); selectedRequestId.current = null; latestRead.current += 1; setRendition(null);
        submission.current ??= { mutationKey: createMutationKey(), reviewToken: availability.reviewToken };
        void fetch(`/api/encode-outputs/${encodeURIComponent(artifactIdentity)}/renditions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission.current) })
          .then(readResponse).then((result: Rendition) => { sessionStorage.setItem(storageKey, result.id); selectedRequestId.current = result.id; setRendition(result); })
          .catch((failure: Error) => setError(failure.message)).finally(() => setBusy(false));
      }}>Create browser rendition</button>
    </> : null}
    {rendition ? <>
      {rendition.sourceAuthorityRevision !== sourceAuthorityRevision || rendition.source.file.mutationRevision !== sourceFileMutationRevision ? <p role="alert">Historical rendition. Its source file or authority differs from the currently inspected output. This playback shows the recorded earlier generation.</p> : null}
      <p>Rendition {rendition.id}: {rendition.status}{rendition.progress.percent === null ? "" : ` · ${Math.floor(rendition.progress.percent)}%`}.</p>
      <p>Audio: {audioInventoryLabel(rendition.source.media.streams)}.</p>
      <p>Stream-copy remux to MP4. {rendition.conversion.subtitles === "omitted" ? "Soft subtitles omitted; none burned in." : rendition.conversion.subtitles === "unknown" ? "Subtitle inventory is unknown." : "No subtitles."}</p>
      {rendition.reason ? <p role="alert">{rendition.reason.message} [{rendition.reason.code}]</p> : null}
      <button type="button" onClick={() => { setError(null); void inspect(rendition.id); }}>Refresh rendition status</button>
      {rendition.media?.availability?.available === false ? <p role="alert">Rendition media is unavailable. [{rendition.media.availability.reasonCode}]</p> : null}
      {rendition.status === "complete" && rendition.media && rendition.media.availability?.available !== false ? <video aria-label="Finished Encode Output browser rendition" controls playsInline preload="metadata" src={`/api/browser-renditions/${encodeURIComponent(rendition.id)}/media`} style={{ width: "100%", maxWidth: "60rem" }} onError={() => setError("The browser could not play this rendition. Its source validation status is unchanged.")} /> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
