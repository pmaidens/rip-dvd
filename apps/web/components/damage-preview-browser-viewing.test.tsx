// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DamagePreviewBrowserViewing } from "./damage-preview-browser-viewing";

const identity = "damage-preview-v1.11111111-2222-4333-8444-555555555555.0";
const preview = { generationStatus: "partial" as const, outdated: true, provenance: { checkpoint: { manifestRevision: 2 } },
  artifacts: [{ identity, coverage: { startMilliseconds: 1000, endMilliseconds: 4000 }, coverageMethod: "handbrake_seek_and_probed_video_packets" as const }] };
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); sessionStorage.clear(); });
it("keeps partial/outdated source revision, canonical relationship and coverage visible through playback and media failure", async () => {
  sessionStorage.setItem(`damage-preview-browser-rendition:${identity}`, "synthetic-request");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => Response.json({ id: "synthetic-request", status: "complete", progress: { percent: 100 },
    source: { kind: "damage_preview", identity, generationStatus: "partial", provenance: preview.provenance, coverage: preview.artifacts[0]!.coverage, media: { streams: [] } },
    previewCondition: { outdated: true, generationStatus: "partial", canonicalMedia: { state: "retained", reasonCode: null } },
    conversion: { kind: "stream_copy_remux", subtitles: "none" }, reason: null, media: { identity: "synthetic-media", availability: { available: true } } }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DamagePreviewBrowserViewing artifactIdentity={identity} preview={preview} />));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/browser-renditions/synthetic-request/media");
    for (const label of ["Partial sample", "Outdated sample", "Actual sample coverage: 1 s to 4 s", "Source revision: 2", "Canonical MKV:", identity, "not finished Encode Output or a watchability verdict"]) expect(container.textContent).toContain(label);
    await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("The browser could not play this sample rendition");
    expect(container.textContent).toContain("Partial sample"); expect(container.textContent).toContain("Outdated sample");
  } finally { await act(async () => root.unmount()); }
});
it("keeps interrupted generation distinct and reports authorization failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DamagePreviewBrowserViewing artifactIdentity={identity} preview={{ ...preview, generationStatus: "interrupted" }} />));
    expect(container.textContent).toContain("Sample generation interrupted");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Check sample browser playback")!.click());
    expect(container.textContent).toContain("Sign in for browser playback");
    expect(container.textContent).toContain("Sample generation interrupted");
    expect(container.querySelector("video")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
