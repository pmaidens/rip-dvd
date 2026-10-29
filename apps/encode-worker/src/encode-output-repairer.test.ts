import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import { createNodeEncodeOutputRepairer } from "./encode-output-repairer.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it("stream-copies retained subtitles with their existing dispositions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-subtitle-repair-")); directories.push(directory);
  const outputPath = join(directory, "subtitled.mkv");
  writeFileSync(outputPath, "synthetic original output");
  const runMediaTool = vi.fn(async (request: import("./encode-output-validator.js").MediaToolRunRequest) => {
    writeFileSync(request.arguments_.at(-1)!, "synthetic repaired output");
    return { stderr: "", stdout: "" };
  });
  const replaceOutput = vi.fn(async (replacementPath: string, path: string) => { renameSync(replacementPath, path); });
  const repairer = createNodeEncodeOutputRepairer({
    replaceOutput,
    runMediaTool,
  });

  const completion = await repairer.removeEmptyVobSubStreams({
    emptyStreamIndexes: [9, 10],
    outputPath,
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
      /subtitled\.mkv\..+\.rip-dvd-subtitle-remux$/,
    ),
    outputPath,
  );
  expect(readFileSync(outputPath, "utf8")).toBe("synthetic repaired output");
  expect(completion).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
