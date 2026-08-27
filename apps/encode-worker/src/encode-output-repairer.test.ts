import { expect, it, vi } from "vitest";

import { createNodeEncodeOutputRepairer } from "./encode-output-repairer.js";

it("stream-copies retained subtitles with their existing dispositions", async () => {
  const runMediaTool = vi.fn(async () => ({ stderr: "", stdout: "" }));
  const replaceOutput = vi.fn(async () => {});
  const repairer = createNodeEncodeOutputRepairer({
    replaceOutput,
    runMediaTool,
  });

  await repairer.removeEmptyVobSubStreams({
    emptyStreamIndexes: [9, 10],
    outputPath: "/media/subtitled.mkv",
    retainedSubtitleDispositions: [
      { default: true, forced: true },
      { default: false, forced: false },
    ],
    signal: new AbortController().signal,
    timeoutMs: 300_000,
  });

  expect(runMediaTool).toHaveBeenCalledWith(
    expect.objectContaining({
      arguments_: expect.arrayContaining([
        "-map",
        "0",
        "-map",
        "-0:9",
        "-0:10",
        "-c",
        "copy",
        "-disposition:s:0",
        "+default+forced",
        "-disposition:s:1",
        "-default-forced",
        "-f",
        "matroska",
      ]),
      executable: "ffmpeg",
      timeoutMs: 300_000,
    }),
  );
  expect(replaceOutput).toHaveBeenCalledWith(
    expect.stringMatching(
      /^\/media\/subtitled\.mkv\..+\.rip-dvd-subtitle-remux$/,
    ),
    "/media/subtitled.mkv",
  );
});
