import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { measureBrowserRenditionTimeline, type CorrespondenceMediaTool } from "./encode-output-cell-correspondence.js";

it.each(["shifted", "changed_video", "missing_timing", "decode_failure", "changed_bytes"] as const)("measures complete native rendition clocks or keeps %s unknown", async (variant) => {
  const root = mkdtempSync(join(tmpdir(), "synthetic-viewing-clock-"));
  const canonical = join(root, "canonical.mkv"), rendition = join(root, "view.mp4");
  writeFileSync(canonical, "synthetic canonical"); writeFileSync(rendition, "synthetic rendition");
  const tool: CorrespondenceMediaTool = async ({ arguments_: args }) => {
    if (variant === "decode_failure") throw new Error("Synthetic decoder failure");
    const viewing = args.includes(rendition);
    if (variant === "changed_bytes" && viewing) writeFileSync(canonical, "synthetic edited canonical");
    const values = viewing && variant === "changed_video" ? ["a", "c"] : ["a", "b"];
    return { stderr: "", stdout: args.includes("framehash")
      ? ["#dimensions 0: 64x64", ...values.map((value, index) => `0, ${index}, ${index}, 1, 6144, ${createHash("sha256").update(value).digest("hex")}`)].join("\n")
      : JSON.stringify({ streams: [{ width: 64, height: 64, pix_fmt: "yuv420p", time_base: "1/1000" }], format: { start_time: viewing ? "0" : "10" },
        frames: values.map((_, index) => ({ pts: viewing && variant === "missing_timing" ? undefined : (viewing ? 2000 : 10000) + index * 40, duration: 40 })) }) };
  };
  try {
    const result = await measureBrowserRenditionTimeline(canonical, rendition, new AbortController().signal, tool);
    expect(result).toMatchObject(variant === "shifted" ? { status: "verified", frames: [
      { canonical: { startMilliseconds: 0, endMilliseconds: 40 }, rendition: { startMilliseconds: 2000, endMilliseconds: 2040 } },
      { canonical: { startMilliseconds: 40, endMilliseconds: 80 }, rendition: { startMilliseconds: 2040, endMilliseconds: 2080 } },
    ] } : { status: "unknown", reasonCode: "RENDITION_TIMELINE_UNVERIFIED" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
