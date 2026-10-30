"use client";
import type { presentBrowserRendition } from "@rip-dvd/application";
type Rendition = ReturnType<typeof presentBrowserRendition>;
export function streamLabel(stream: NonNullable<Rendition["source"]["media"]["streams"]>[number]) {
  return `#${stream.index} ${stream.codecName ?? "unknown codec"}, ${stream.language ?? "language unknown"}${stream.title ? `, ${stream.title}` : ""}${stream.forced ? ", forced" : ""}`;
}
export function ConversionDetails({ source, conversion, actualMedia }: Pick<Rendition, "source" | "conversion"> & { actualMedia?: Rendition["actualMedia"] }) {
  const audio = conversion.streams?.filter((stream) => stream.kind === "audio");
  const burned = conversion.burnedSubtitle;
  return <>
    <p>{conversion.kind === "undetermined" ? "Conversion plan unavailable until actual streams can be inspected." : conversion.kind === "stream_copy_remux" ? "Stream-copy remux to MP4." : "H.264/AAC conversion to MP4."}</p>
    {conversion.containerDifferences?.map((difference) => <p key={difference}>{difference}.</p>)}
    {actualMedia ? <p>Observed rendition audio: {actualMedia.streams.filter((stream) => stream.kind === "audio").map(streamLabel).join("; ") || "none"}.</p> : null}
    <p>Audio: {audio ? audio.map((stream) => `#${stream.sourceIndex} ${stream.codec}, ${stream.language ?? "language unknown"}${stream.title ? `, ${stream.title}` : ""}`).join("; ") || "none"
      : source.media.streams?.filter((stream) => stream.kind === "audio").map(streamLabel).join("; ") || (source.media.streams === null ? "unknown inventory" : "none")}.</p>
    {conversion.streams?.map((stream) => <p key={stream.sourceIndex}>Stream #{stream.sourceIndex}: {stream.sourceCodec ?? "unknown codec"} to {stream.codec}, {stream.mode === "copy" ? "copied" : "converted"}{stream.differences.length ? `. ${stream.differences.join(". ")}` : ""}.</p>)}
    <p>{burned ? `Burned subtitle #${burned.sourceIndex}: ${burned.codecName}, ${burned.language ?? "language unknown"}${burned.title ? `, ${burned.title}` : ""}.` : "No subtitles are burned in."}</p>
    <p>{conversion.subtitles === "unknown" ? "Subtitle inventory is unknown." : `Soft subtitles omitted: ${source.media.streams?.filter((stream) => stream.kind === "subtitle" && conversion.omittedStreamIndexes?.includes(stream.index)).map(streamLabel).join("; ") || "none"}.`}</p>
  </>;
}
export async function readRenditionResponse(response: Response) {
  if (response.status === 401) throw new Error("Sign in for browser playback, then try again.");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error?.code ?? "Browser playback is unavailable.");
  return body;
}
