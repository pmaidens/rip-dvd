// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EncodeOutputInspection } from "@rip-dvd/application";
import { EncodeOutputBrowserViewing } from "./encode-output-browser-viewing";

const identity = "synthetic-output";
const renditionId = "00000000-0000-4000-8000-000000000001";
const sourceSnapshot = { source: { assessment: { id: "synthetic-assessment", items: [{ titleIdentityObservationId: "synthetic-title",
  estimatedAffectedPlayback: { intervals: [{ startMilliseconds: 1000, endMilliseconds: 5000, coverage: "whole_cell" }] } }] } } } as unknown as EncodeOutputInspection["artifact"]["provenance"]["sourceSnapshot"];
const inspection = { authorityRevision: "synthetic-authority", artifact: { identity, file: { mutationRevision: "synthetic-file" } } };
const target = { intervalIndex: 0, canonicalOutputInterval: { startMilliseconds: 40, endMilliseconds: 160 }, renditionInterval: { startMilliseconds: 2040, endMilliseconds: 2160 }, seekSeconds: 2.04 };
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); document.body.replaceChildren(); });

it.each(["verified", "absent", "unknown", "stale", "changed_on_seek", "unseekable"] as const)("uses only a freshly evidenced native browser target, %s", async (scenario) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.setItem(`encode-output-browser-rendition:${identity}`, renditionId);
  let reads = 0;
  const requests: { url: string; method?: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, options?: { method?: string }) => {
    requests.push({ url, method: options?.method });
    if (url.includes("/browser-renditions/")) return Response.json({ id: renditionId, sourceAuthorityRevision: "synthetic-authority", source: {
      identity, state: "validation_failed", file: { mutationRevision: "synthetic-file" }, media: { streams: [] },
    }, conversion: { subtitles: "none" }, status: "complete", progress: { percent: 100 }, reason: null, media: { identity: "synthetic-viewing-media" } });
    reads += 1;
    const state = scenario === "absent" ? "absent" : scenario === "unknown" || scenario === "changed_on_seek" && reads > 1 ? "unknown" : "verified";
    return Response.json({ query: JSON.parse(new URL(url, "http://localhost").searchParams.get("query")!),
      inspection: scenario === "stale" ? { ...inspection, authorityRevision: "changed-authority" } : inspection,
      intervals: [{ intervalIndex: 0, status: state, outputInterval: state === "verified" ? target.canonicalOutputInterval : null,
        reason: "Synthetic correspondence evidence", reasonCode: state === "unknown" ? "OUTPUT_TRUNCATED" : state === "absent" ? "SOURCE_EXCLUDED_BY_SELECTION" : "OUTPUT_CELL_CONTENT_VERIFIED" }],
      viewing: { renditionId, mediaIdentity: "synthetic-viewing-media", targets: state === "verified" ? [target] : [], reason: null } });
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<EncodeOutputBrowserViewing artifactIdentity={identity} sourceSnapshot={sourceSnapshot} validationFailed sourceAuthorityRevision="synthetic-authority" sourceFileMutationRevision="synthetic-file" />));
    const video = container.querySelector("video")!;
    Object.defineProperties(video, { duration: { value: 10 }, readyState: { value: 2 }, seekable: { value: {
      length: scenario === "unseekable" ? 0 : 1, start: () => 0, end: () => 10,
    } } });
    const select = container.querySelector("select")!;
    await act(async () => { select.selectedIndex = 1; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label);
    await act(async () => button("Check output correspondence")!.click());
    if (["verified", "changed_on_seek", "unseekable"].includes(scenario)) {
      expect(container.textContent).toContain("Canonical seek target: 0.04 seconds");
      expect(container.textContent).toContain("Rendition seek target: 2.04 seconds");
      await act(async () => button("Seek to verified output interval")!.click());
      expect(reads).toBe(2);
    } else expect(button("Seek to verified output interval")).toBeUndefined();
    expect(video.currentTime).toBe(scenario === "verified" ? 2.04 : 0);
    if (scenario === "absent") expect(container.textContent).toContain("SOURCE_EXCLUDED_BY_SELECTION");
    if (["unknown", "changed_on_seek"].includes(scenario)) expect(container.textContent).toContain("OUTPUT_TRUNCATED");
    if (scenario === "stale") expect(container.textContent).toContain("Output evidence changed");
    if (scenario === "unseekable") expect(container.textContent).toContain("not currently seekable");
    expect(container.textContent).toContain("Validation-failed source");
    expect(container.textContent).toContain("No damage seek is claimed by ordinary playback");
    expect(requests.every((request) => request.method === undefined)).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
