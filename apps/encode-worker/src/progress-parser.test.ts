import { describe, expect, it, vi } from "vitest";

import { createProgressParser } from "./progress-parser.js";

describe("HandBrake progress parser", () => {
  it("parses scanning, previewing, and encoding updates across stream chunks", () => {
    const onProgress = vi.fn();
    const parse = createProgressParser(onProgress);

    parse("Scanning title 1 of 8, 25.90 %\rScanning title 1 of 8, pre");
    parse(
      "view 3, 60.10 %\nEncoding: task 1 of 1, 42.50 % (128.00 fps, ETA 0h12m03s)\r",
    );

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { phase: "scanning", progressPercent: 25, etaSeconds: null },
      { phase: "previewing", progressPercent: 60, etaSeconds: null },
      { phase: "encoding", progressPercent: 42, etaSeconds: 723 },
    ]);
  });

  it("waits for a segment terminator before emitting an update", () => {
    const onProgress = vi.fn();
    const parse = createProgressParser(onProgress);

    parse("Encoding: task 1 of 1, 100.00 %");
    expect(onProgress).not.toHaveBeenCalled();

    parse("\r");

    expect(onProgress).toHaveBeenCalledWith({
      phase: "encoding",
      progressPercent: 100,
      etaSeconds: null,
    });

    parse("", true);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
