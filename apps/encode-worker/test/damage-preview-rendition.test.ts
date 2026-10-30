import { writeFileSync, existsSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { openBrowserRendition } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { requestSyntheticPreviewRendition } from "../../operator-cli/src/damage-preview-rendition.test-support.js";
import { compatibleOutputProbe, subtitleOutputProbe } from "../../operator-cli/src/encode-output-rendition.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../operator-cli/src/archive-evidence.test-support.js";
import { settleDamagePreviewMedia } from "../../operator-cli/src/damage-preview.test-support.js";
import { pollBrowserRenditions, type BrowserRenditionGenerator } from "../src/browser-rendition-worker.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const generator: BrowserRenditionGenerator = {
  probe: compatibleOutputProbe, version: async () => "ffmpeg synthetic-test-tool",
  async generate({ destination, onProgress }) { onProgress(50); writeFileSync(destination, "synthetic MP4 bytes"); },
};
it.each(["complete", "partial", "interrupted", "failed"] as const)("renders retained %s sample bytes and keeps source provenance and live outdated conditions", async (generationStatus) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { generationStatus });
  advanceCommittedArchiveEvidence(fixture, seeded.seeded.manifest);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    expect(await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).toMatchObject({ exitCode: 0, result: {
      status: "complete", source: { identity: seeded.identity, generationStatus, provenance: seeded.review.source.provenance, coverage: seeded.review.source.coverage },
      previewCondition: { generationStatus, outdated: true, status: "outdated" }, playback: { kind: "damage_preview_sample", watchability: "not_assessed" }, media: { mediaType: "video/mp4" },
    } });
    const opened = await openBrowserRendition(access, seeded.request.id, true);
    try { expect(await opened.file.readFile("utf8")).toBe("synthetic MP4 bytes"); } finally { await opened.file.close(); }
    expect(access.browserRenditions.find(seeded.request.id)!.command).toContain("<canonical-preview-snapshot>");
  } finally { access.close(); }
});
it.each(["conversion", "missing", "checksum", "interrupted"])("retains a distinct %s failure without media or an automatic restart", async (failure) => {
  const { unlinkSync } = await import("node:fs");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { probe: subtitleOutputProbe });
  const access = fixture.openAccess();
  const signal = new AbortController();
  try {
    if (failure === "missing") unlinkSync(seeded.path);
    if (failure === "checksum") writeFileSync(seeded.path, "synthetic changed canonical bytes");
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: signal.signal, enabled: true, generator: { ...generator,
      probe: (path) => path.endsWith(".mp4") ? compatibleOutputProbe(path) : subtitleOutputProbe(path),
      async generate() { if (failure === "interrupted") signal.abort(); throw new Error("Synthetic conversion failure"); },
    } });
    expect(await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).toMatchObject({ exitCode: 0, result: { status: failure === "interrupted" ? "interrupted" : "failed", media: null,
      reason: { code: ["missing", "checksum"].includes(failure) ? "RENDITION_SOURCE_CHANGED" : failure === "interrupted" ? "RENDITION_INTERRUPTED" : "RENDITION_CONVERSION_FAILED" } } });
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    await expect(openBrowserRendition(access, seeded.request.id, true)).rejects.toMatchObject({ code: "RENDITION_MEDIA_UNAVAILABLE" });
  } finally { access.close(); }
});
it("revokes derived ranges when canonical deletion is admitted and removes worker-owned derivative bytes", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    const path = access.browserRenditions.find(seeded.request.id)!.media!.path;
    const preview = await seeded.inspect();
    expect(await fixture.run(["damage-preview", "delete", seeded.id, "--key", "synthetic-preview-rendition-delete", "--json", JSON.stringify({ mediaToken: preview.media.token })])).toMatchObject({ exitCode: 0 });
    await expect(openBrowserRendition(access, seeded.request.id, true)).rejects.toMatchObject({ code: "DAMAGE_PREVIEW_MEDIA_REMOVING" });
    settleDamagePreviewMedia(fixture);
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    expect(existsSync(path)).toBe(false);
    expect(await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).toMatchObject({ exitCode: 0, result: { status: "complete", media: null, source: { identity: seeded.identity }, previewCondition: { canonicalMedia: { state: "removed" } } } });
  } finally { access.close(); }
});
