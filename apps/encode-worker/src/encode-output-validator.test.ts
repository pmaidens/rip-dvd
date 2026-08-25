import { describe, expect, it, vi } from "vitest";

import {
  createNodeEncodeOutputValidator,
  type MediaToolRunRequest,
  type MediaToolRunResult,
} from "./encode-output-validator.js";

function mediaToolResult(stdout: string): MediaToolRunResult {
  return { stderr: "", stdout };
}

function createMediaToolRunner({
  audioFirstPts = "0.000000",
  decodedFrames = 120,
  pixFmt = "yuv420p",
  profile = "High",
  videoFirstPts = "0.021000",
}: {
  audioFirstPts?: string | null;
  decodedFrames?: number;
  pixFmt?: string;
  profile?: string;
  videoFirstPts?: string | null;
} = {}) {
  return vi.fn(
    async (request: MediaToolRunRequest): Promise<MediaToolRunResult> => {
      if (request.executable === "ffmpeg") {
        return mediaToolResult(
          `frame=${decodedFrames}\nprogress=end\n`,
        );
      }
      const streamSelector = request.arguments_[
        request.arguments_.indexOf("-select_streams") + 1
      ];
      if (streamSelector === "v:0") {
        return mediaToolResult(
          JSON.stringify({
            packets:
              videoFirstPts === null ? [] : [{ pts_time: videoFirstPts }],
            streams: [{ codec_name: "h264", pix_fmt: pixFmt, profile }],
          }),
        );
      }
      return mediaToolResult(
        JSON.stringify({
          packets:
            audioFirstPts === null ? [] : [{ pts_time: audioFirstPts }],
        }),
      );
    },
  );
}

describe("encode output validation", () => {
  it("accepts an identified video stream that starts promptly and decodes frames", async () => {
    const runMediaTool = createMediaToolRunner();
    const validator = createNodeEncodeOutputValidator({ runMediaTool });

    await validator.validate(
      "/media/.Example.mkv.claim.rip-dvd-partial",
      new AbortController().signal,
    );

    expect(runMediaTool).toHaveBeenCalledTimes(3);
    expect(runMediaTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        arguments_: expect.arrayContaining([
          "-map",
          "0:v:0",
          "-t",
          "5",
          "/media/.Example.mkv.claim.rip-dvd-partial",
        ]),
        executable: "ffmpeg",
      }),
    );
  });

  it("rejects the unknown video headers produced by an undecrypted DVD encode", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        pixFmt: "unknown",
        profile: "unknown",
      }),
    });

    await expect(
      validator.validate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: video stream metadata is incomplete",
    );
  });

  it("rejects video that begins too far behind the audio", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ videoFirstPts: "24.480000" }),
    });

    await expect(
      validator.validate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: first video frame starts 24.480 seconds after the audio baseline",
    );
  });

  it("rejects video that produces no frames during a bounded decode", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ decodedFrames: 0 }),
    });

    await expect(
      validator.validate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: the first 5 seconds decoded zero video frames",
    );
  });
});
