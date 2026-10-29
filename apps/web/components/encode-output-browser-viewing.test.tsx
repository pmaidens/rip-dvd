// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EncodeOutputBrowserViewing } from "./encode-output-browser-viewing";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); sessionStorage.clear(); });
it("keeps failed-source and ordinary-playback warnings visible through authorization and playback failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const fetcher = vi.fn(async () => new Response(null, { status: 401 })); vi.stubGlobal("fetch", fetcher);
  try {
    await act(async () => root.render(<EncodeOutputBrowserViewing artifactIdentity="synthetic-failed-artifact" validationFailed sourceAuthorityRevision="synthetic-authority" sourceFileMutationRevision="synthetic-file" />));
    expect(container.textContent).toContain("Validation-failed source"); expect(container.textContent).toContain("No damage seek is claimed");
    expect(container.querySelector("video")).toBeNull();
    const check = [...container.querySelectorAll("button")].find((button) => button.textContent === "Check browser playback")!;
    await act(async () => check.click());
    expect(container.textContent).toContain("Sign in for browser playback, then try again");
    expect(container.textContent).toContain("Viewing does not change Encode Job status");
  } finally { await act(async () => root.unmount()); }
});
it("resumes a saved durable rendition without requesting another one or acknowledging inspection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.setItem("encode-output-browser-rendition:synthetic-artifact", "synthetic-rendition");
  const fetcher = vi.fn(async () => Response.json({ id: "synthetic-rendition", status: "complete", progress: { percent: 100 }, sourceAuthorityRevision: "earlier-authority", source: { identity: "synthetic-artifact", state: "validation_failed", file: { mutationRevision: "earlier-file" }, media: { streams: [{ kind: "audio", codecName: "aac", language: "eng" }] } }, conversion: { kind: "stream_copy_remux", subtitles: "omitted" }, reason: null, media: { identity: "synthetic-rendition-media" } }));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EncodeOutputBrowserViewing artifactIdentity="synthetic-artifact" validationFailed={false} sourceAuthorityRevision="current-authority" sourceFileMutationRevision="current-file" />));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/browser-renditions/synthetic-rendition/media");
    expect(container.textContent).toContain("Validation-failed source"); expect(container.textContent).toContain("Soft subtitles omitted");
    expect(container.textContent).toContain("Historical rendition");
    expect(container.textContent).toContain("Audio: aac eng");
    expect(fetcher.mock.calls).toHaveLength(1);
    await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("The browser could not play this rendition");
    expect(container.textContent).toContain("Validation-failed source");
  } finally { await act(async () => root.unmount()); }
});
it("keeps a failed probe's stream inventory unknown instead of claiming audio or subtitles are absent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => Response.json({ available: false, reasons: [{ code: "OUTPUT_PROBE_FAILED", message: "The media probe failed." }], source: { media: { streams: null } }, conversion: { subtitles: "unknown" } }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EncodeOutputBrowserViewing artifactIdentity="synthetic-artifact" validationFailed sourceAuthorityRevision="synthetic-authority" sourceFileMutationRevision="synthetic-file" />));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Check browser playback")!.click());
    expect(container.textContent).toContain("Audio: unknown inventory"); expect(container.textContent).toContain("Subtitle inventory is unknown");
    expect(container.textContent).not.toContain("Audio: none"); expect(container.textContent).not.toContain("No subtitles are present");
  } finally { await act(async () => root.unmount()); }
});
it("keeps a newly admitted request selected when an older restoration response arrives late", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.setItem("encode-output-browser-rendition:synthetic-artifact", "earlier-request");
  let restore: (response: Response) => void = () => { throw new Error("Restore not started"); };
  const pendingRestore = new Promise<Response>((resolve) => { restore = resolve; });
  const source = { identity: "synthetic-artifact", state: "published", file: { mutationRevision: "synthetic-file" }, media: { streams: [] } };
  const result = (id: string) => ({ id, status: "complete", progress: { percent: 100 }, source, sourceAuthorityRevision: "synthetic-authority", conversion: { subtitles: "none" }, reason: null, media: { identity: `synthetic-media-${id}` } });
  vi.stubGlobal("fetch", async (url: string, options?: { method?: string }) => {
    if (url.endsWith("/earlier-request")) return pendingRestore;
    if (options?.method === "POST") return Response.json(result("new-request"));
    return Response.json({ available: true, reasons: [], reviewToken: "synthetic-reviewed-token", source, conversion: { subtitles: "none" } });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EncodeOutputBrowserViewing artifactIdentity="synthetic-artifact" validationFailed={false} sourceAuthorityRevision="synthetic-authority" sourceFileMutationRevision="synthetic-file" />));
    const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
    await act(async () => button("Check browser playback").click());
    await act(async () => button("Create browser rendition").click());
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/browser-renditions/new-request/media");
    await act(async () => restore(Response.json(result("earlier-request"))));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/browser-renditions/new-request/media");
    expect(container.textContent).toContain("Rendition new-request: complete");
    expect(container.textContent).not.toContain("Rendition earlier-request");
  } finally { await act(async () => root.unmount()); }
});
