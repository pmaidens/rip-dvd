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
  subtitleStreams = [
    {
      codec_name: "dvd_subtitle",
      disposition: { default: 0, forced: 0 },
      index: 2,
      tags: { language: "eng" },
    },
  ],
  videoFirstPts = "0.021000",
}: {
  audioFirstPts?: string | null;
  decodedFrames?: number;
  pixFmt?: string;
  profile?: string;
  subtitleStreams?: unknown;
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
      if (streamSelector === "s") {
        return mediaToolResult(JSON.stringify({ streams: subtitleStreams }));
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

    expect(runMediaTool).toHaveBeenCalledTimes(4);
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

  it("accepts an output without subtitles when the selected source has none", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [] }),
    });

    await expect(
      validator.validate(
        "/media/subtitle-free.mkv",
        new AbortController().signal,
        { minimumVobSubStreams: 0 },
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts identified VobSub streams with language and disposition metadata", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 1, forced: 0 },
            index: 2,
            tags: { language: "eng", title: "English" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 1 },
            index: 3,
            tags: { language: "fra" },
          },
          {
            codec_name: "subrip",
            disposition: { default: 0, forced: 0 },
            index: 4,
          },
        ],
      }),
    });

    await expect(
      validator.validate(
        "/media/subtitled.mkv",
        new AbortController().signal,
        { minimumVobSubStreams: 2 },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an output that dropped a selected title's VobSub streams", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [] }),
    });

    await expect(
      validator.validate(
        "/media/broken.mkv",
        new AbortController().signal,
        { minimumVobSubStreams: 2 },
      ),
    ).rejects.toThrow(
      "Encode output validation failed: expected at least 2 VobSub streams, found 0",
    );
  });

  it("rejects incomplete subtitle metadata", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "unknown",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: {},
          },
        ],
      }),
    });

    await expect(
      validator.validate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle stream metadata is incomplete",
    );
  });

  it("rejects a malformed subtitle probe result", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: {} }),
    });

    await expect(
      validator.validate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle probe returned an invalid result",
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
