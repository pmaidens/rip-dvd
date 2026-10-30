"use client";

import { ConversionDetails, streamLabel } from "./browser-rendition-details";
import { useBrowserRendition } from "./use-browser-rendition";
import { useRef, useState } from "react";
import type { EncodeOutputInspection } from "@rip-dvd/application";
import { EncodeOutputCorrespondence } from "./encode-output-correspondence";

export function EncodeOutputBrowserViewing({ artifactIdentity, validationFailed, sourceAuthorityRevision, sourceFileMutationRevision, sourceSnapshot = null }: { artifactIdentity: string; validationFailed: boolean; sourceAuthorityRevision: string; sourceFileMutationRevision: string | null; sourceSnapshot?: EncodeOutputInspection["artifact"]["provenance"]["sourceSnapshot"] }) {
  const { availability, rendition, error, busy, burnSubtitleIndex, review, selectSubtitle, create, refresh, reportPlaybackError } = useBrowserRendition({ artifactIdentity, sourceKind: "encode_output", pollTerminal: false });
  const video = useRef<HTMLVideoElement | null>(null);
  const [seekMessage, setSeekMessage] = useState<{ renditionId: string; text: string } | null>(null);
  return <section aria-label="Browser Viewing Rendition">
    <h5>Browser Viewing Rendition</h5>
    <p>Ordinary playback of a finished Encode Output. Source correspondence may be unknown. No damage seek is claimed by ordinary playback.</p>
    {validationFailed || (rendition && "state" in rendition.source && rendition.source.state === "validation_failed") ? <p role="alert">Validation-failed source. Viewing does not change Encode Job status, validate the output or record a Keep decision.</p> : null}
    <p>This separate MP4 copies compatible streams or converts video to H.264 and audio to AAC. Its conversion and subtitle choices do not replace the canonical MKV or establish watchability.</p>
    <a href="/viewing-access" target="_blank" rel="noreferrer">Sign in for browser playback</a>
    <button type="button" disabled={busy} onClick={() => review()}>Check browser playback</button>
    {availability ? <>
      {availability.reasons.map((reason) => <p key={reason.code}>{reason.message} [{reason.code}]</p>)}
      <ConversionDetails source={availability.source} conversion={availability.conversion} />
      <label>Burn one subtitle into a separate rendition
        <select aria-label="Burn one subtitle into a separate rendition" value={burnSubtitleIndex} disabled={busy} onChange={(event) => selectSubtitle(event.target.value)}>
          <option value="">No burned subtitles</option>
          {availability.source.media.streams?.filter((stream) => stream.kind === "subtitle").map((stream) => <option key={stream.index} value={stream.index}>{streamLabel(stream)}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !availability.available} onClick={create}>Create browser rendition</button>
    </> : null}
    {rendition ? <>
      {rendition.sourceAuthorityRevision !== sourceAuthorityRevision || ("file" in rendition.source ? rendition.source.file.mutationRevision : null) !== sourceFileMutationRevision ? <p role="alert">Historical rendition. Its source file or authority differs from the currently inspected output. This playback shows the recorded earlier generation.</p> : null}
      <p>Rendition {rendition.id}: {rendition.status}{rendition.progress.percent === null ? "" : ` · ${Math.floor(rendition.progress.percent)}%`}.</p>
      <ConversionDetails source={rendition.source} conversion={rendition.conversion} actualMedia={rendition.actualMedia} />
      {rendition.reason ? <p role="alert">{rendition.reason.message} [{rendition.reason.code}]</p> : null}
      <button type="button" onClick={refresh}>Refresh rendition status</button>
      {rendition.media?.availability?.available === false ? <p role="alert">Rendition media is unavailable. [{rendition.media.availability.reasonCode}]</p> : null}
      {rendition.status === "complete" && rendition.media && rendition.media.availability?.available !== false ? <video key={rendition.id} ref={video} aria-label="Finished Encode Output browser rendition" controls playsInline preload="metadata" src={`/api/browser-renditions/${encodeURIComponent(rendition.id)}/media`} style={{ width: "100%", maxWidth: "60rem" }} onError={() => { setSeekMessage(null); reportPlaybackError("The browser could not play this rendition. Its source validation status is unchanged."); }} /> : null}
    </> : null}
    <EncodeOutputCorrespondence key={JSON.stringify([artifactIdentity, sourceAuthorityRevision, sourceFileMutationRevision, rendition?.id, rendition?.status, rendition?.media?.availability?.available])}
      artifactIdentity={artifactIdentity} snapshot={sourceSnapshot} authorityRevision={sourceAuthorityRevision} fileMutationRevision={sourceFileMutationRevision}
      renditionId={rendition?.status === "complete" && rendition.media && rendition.media.availability?.available !== false ? rendition.id : null}
      onSeek={(target, mediaIdentity) => {
        const player = video.current;
        if (!player || rendition?.media?.identity !== mediaIdentity || player.readyState < 1 || !Number.isFinite(player.duration) || target.seekSeconds >= player.duration ||
            !Array.from({ length: player.seekable.length }, (_, index) => index).some((index) => player.seekable.start(index) <= target.seekSeconds && player.seekable.end(index) > target.seekSeconds)) {
          throw new Error("The proved target is not currently seekable in this browser. Load the rendition and try again; ordinary playback remains available.");
        }
        player.currentTime = target.seekSeconds;
        setSeekMessage({ renditionId: rendition.id, text: `Seek requested at ${target.seekSeconds} seconds in the separate Browser Viewing Rendition. This does not acknowledge inspection or establish watchability.` });
      }} />
    {seekMessage?.renditionId === rendition?.id ? <p role="status">{seekMessage?.text}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
