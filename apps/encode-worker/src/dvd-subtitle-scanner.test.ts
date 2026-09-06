import { describe, expect, it, vi } from "vitest";

import { createNodeDvdSubtitleScanner } from "./dvd-subtitle-scanner.js";
import dvdVariants from "./test-fixtures/handbrake-dvd-variants.json" with { type: "json" };

const title = dvdVariants.TitleList[0]!;
const variant = title.SubtitleList[0]!;

function scanResult(subtitles: unknown[]) {
  return { TitleList: [{ Index: 4, SubtitleList: subtitles }] };
}

function scannerReturning(result: unknown) {
  return createNodeDvdSubtitleScanner({
    runCommand: async () => ({
      stdout: `Version: {"VersionString":"1.9.2"}\nProgress: {"State":"SCANNING"}\nJSON Title Set: ${JSON.stringify(result, null, 2)}\n`,
    }),
  });
}

describe("HandBrake DVD subtitle scan", () => {
  it("retains separate widescreen and letterbox streams in HandBrake order", async () => {
    await expect(scannerReturning(dvdVariants).scan("/source.iso", 4, new AbortController().signal))
      .resolves.toEqual([
        { languageCode: "eng", title: null },
        { languageCode: "eng", title: null },
      ]);
  });

  it("retains names, unknown languages and non-display variants without inventing duplicates", async () => {
    const subtitles = [
      { ...variant, LanguageCode: "fra", Name: "Commentary", Attributes: { PanScan: true } },
      { ...variant, TrackNumber: 2, LanguageCode: "und", Name: "Closed Caption", Attributes: { "4:3": true } },
      { TrackNumber: 3, SourceName: "CC608", Format: "text" },
    ];
    await expect(scannerReturning(scanResult(subtitles)).scan("/source.iso", 4, new AbortController().signal))
      .resolves.toEqual([
        { languageCode: "fra", title: "Commentary" },
        { languageCode: "und", title: "Closed Caption" },
      ]);
  });

  it("accepts a complete scan with no subtitles", async () => {
    await expect(scannerReturning(scanResult([])).scan("/source.iso", 4, new AbortController().signal))
      .resolves.toEqual([]);
  });

  it.each([
    ["missing title list", {}],
    ["empty title list", { TitleList: [] }],
    ["wrong title", { TitleList: [{ ...title, Index: 5 }] }],
    ["duplicate title", { TitleList: [title, title] }],
    ["absent subtitles", { TitleList: [{ Index: 4 }] }],
    ["invalid subtitle list", { TitleList: [{ Index: 4, SubtitleList: {} }] }],
    ["null subtitle", scanResult([null])],
    ["duplicate track ordinal", scanResult([variant, variant])],
    ["missing first track", scanResult([{ ...variant, TrackNumber: 2 }])],
    ["unknown source", scanResult([{ ...variant, SourceName: "unknown" }])],
    ["wrong format", scanResult([{ ...variant, Format: "text" }])],
    ["missing language", scanResult([{ ...variant, LanguageCode: undefined }])],
    ["invalid language", scanResult([{ ...variant, LanguageCode: "?" }])],
    ["empty name", scanResult([{ ...variant, Name: "" }])],
    ["invalid name", scanResult([{ ...variant, Name: 7 }])],
    ["too many DVD streams", scanResult(Array.from({ length: 33 }, (_, index) => ({ ...variant, TrackNumber: index + 1 })))],
  ])("fails closed on %s", async (_, result) => {
    await expect(scannerReturning(result).scan("/source.iso", 4, new AbortController().signal))
      .rejects.toThrow("HandBrake DVD subtitle scan is incomplete or invalid");
  });

  it.each(["", "JSON Title Set: {", "JSON Title Set: {}\nJSON Title Set: {}"])("rejects absent, truncated or repeated JSON", async (stdout) => {
    const scanner = createNodeDvdSubtitleScanner({ runCommand: async () => ({ stdout }) });
    await expect(scanner.scan("/source.iso", 4, new AbortController().signal))
      .rejects.toThrow("HandBrake DVD subtitle scan is incomplete or invalid");
  });

  it("bounds the read-only scan and hides raw command failures", async () => {
    const runCommand = vi.fn(async () => { throw new Error("timeout /private/source.iso raw diagnostics"); });
    const scanner = createNodeDvdSubtitleScanner({ runCommand });
    const signal = new AbortController().signal;
    await expect(scanner.scan("/source.iso", 4, signal)).rejects.toThrow(/^HandBrake DVD subtitle scan failed$/);
    expect(runCommand.mock.calls[0]).toEqual([
      "nice",
      ["-n", "19", "ionice", "-c", "3", "rip-dvd-handbrake", "--no-dvdnav", "--scan", "--json", "--title", "4", "--min-duration", "0", "--previews", "1:0", "-i", "/source.iso"],
      { encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, signal, timeout: 120_000 },
    ]);
  });

  it("preserves cancellation before and during a scan", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const runCommand = vi.fn(async () => {
      controller.abort(reason);
      throw new Error("command aborted");
    });
    const scanner = createNodeDvdSubtitleScanner({ runCommand });
    await expect(scanner.scan("/source.iso", 4, controller.signal)).rejects.toBe(reason);
    await expect(scanner.scan("/source.iso", 4, controller.signal)).rejects.toBe(reason);
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
