"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserRenditionAvailability, DamagePreviewRenditionAvailability, presentBrowserRendition } from "@rip-dvd/application";
import { createMutationKey } from "../lib/mutation-key";
async function readRenditionResponse(response: Response) {
  if (response.status === 401) throw new Error("Sign in for browser playback, then try again.");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error?.code ?? "Browser playback is unavailable.");
  return body;
}


type Rendition = ReturnType<typeof presentBrowserRendition>;
export function useBrowserRendition({ artifactIdentity, sourceKind, pollTerminal }: {
  artifactIdentity: string; sourceKind: "encode_output" | "damage_preview"; pollTerminal: boolean;
}) {
  const [availability, setAvailability] = useState<BrowserRenditionAvailability | DamagePreviewRenditionAvailability | null>(null);
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [burnSubtitleIndex, setBurnSubtitleIndex] = useState("");
  const [busy, setBusy] = useState(false);
  const submission = useRef<{ mutationKey: string; reviewToken: string; burnSubtitleIndex?: number } | null>(null);
  const selectedRequestId = useRef<string | null>(null);
  const latestRead = useRef(0);
  const contextRevision = useRef(0);
  const prefix = sourceKind === "damage_preview" ? "damage-preview" : "encode-output";
  const storageKey = `${prefix}-browser-rendition:${artifactIdentity}`;
  const endpoint = `/api/${sourceKind === "damage_preview" ? "damage-preview-media" : "encode-outputs"}/${encodeURIComponent(artifactIdentity)}/renditions`;
  const inspect = useCallback(async (id: string) => {
    if (selectedRequestId.current !== id) return;
    const sequence = ++latestRead.current;
    const current = () => selectedRequestId.current === id && latestRead.current === sequence;
    try {
      const result: Rendition = await readRenditionResponse(await fetch(`/api/browser-renditions/${encodeURIComponent(id)}`, { cache: "no-store" }));
      const matchesSource = sourceKind === "damage_preview" ? "kind" in result.source && result.source.kind === "damage_preview" : "file" in result.source;
      if (result.id !== id || result.source.identity !== artifactIdentity || !matchesSource) throw new Error("The saved rendition belongs to a different request or canonical source.");
      if (current()) setRendition(result);
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : "Rendition inspection is unavailable."); }
  }, [artifactIdentity, sourceKind]);
  useEffect(() => {
    contextRevision.current += 1;
    setAvailability(null); setRendition(null); setError(null); setBurnSubtitleIndex(""); setBusy(false); submission.current = null;
    const id = sessionStorage.getItem(storageKey);
    selectedRequestId.current = id;
    if (id) void inspect(id);
    return () => { contextRevision.current += 1; selectedRequestId.current = null; latestRead.current += 1; };
  }, [storageKey, inspect]);
  const polledId = rendition && (pollTerminal || ["queued", "generating"].includes(rendition.status)) ? rendition.id : null;
  useEffect(() => {
    if (!polledId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await inspect(polledId);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [polledId, inspect]);
  function review(selected = burnSubtitleIndex) {
    setBusy(true); setError(null); submission.current = null;
    const revision = contextRevision.current;
    const current = () => contextRevision.current === revision;
    const query = selected === "" ? "" : `?burnSubtitleIndex=${encodeURIComponent(selected)}`;
    void fetch(`${endpoint}${query}`, { cache: "no-store" }).then(readRenditionResponse).then((result) => { if (current()) setAvailability(result); })
      .catch((failure: Error) => { if (current()) { setAvailability(null); setError(failure.message); } }).finally(() => { if (current()) setBusy(false); });
  }
  function selectSubtitle(selected: string) { setBurnSubtitleIndex(selected); review(selected); }
  function create() {
    if (!availability?.available) return;
    setBusy(true); setError(null); selectedRequestId.current = null; latestRead.current += 1; setRendition(null);
    submission.current ??= { mutationKey: createMutationKey(), reviewToken: availability.reviewToken, ...(burnSubtitleIndex === "" ? {} : { burnSubtitleIndex: Number(burnSubtitleIndex) }) };
    const revision = contextRevision.current;
    const current = () => contextRevision.current === revision;
    void fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission.current) })
      .then(readRenditionResponse).then((result: Rendition) => { sessionStorage.setItem(storageKey, result.id); if (current()) { selectedRequestId.current = result.id; setRendition(result); } })
      .catch((failure: Error) => { if (current()) setError(failure.message); }).finally(() => { if (current()) setBusy(false); });
  }
  function refresh() { setError(null); if (rendition) void inspect(rendition.id); }
  return { availability, rendition, error, busy, burnSubtitleIndex, review, selectSubtitle, create, refresh, reportPlaybackError: setError };
}
