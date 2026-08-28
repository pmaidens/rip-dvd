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
  subtitlePacketStderr = "",
  subtitlePacketStreams,
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
  subtitlePacketStderr?: string;
  subtitlePacketStreams?: unknown;
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
        if (request.arguments_.includes("-count_packets")) {
          const derivedPacketStreams = Array.isArray(subtitleStreams)
            ? subtitleStreams.flatMap((stream) => {
                if (
                  typeof stream !== "object" ||
                  stream === null ||
                  Array.isArray(stream) ||
                  !("index" in stream) ||
                  !("codec_name" in stream)
                ) {
                  return [];
                }
                return [
                  {
                    codec_name: stream.codec_name,
                    index: stream.index,
                    nb_read_packets: "1",
                  },
                ];
              })
            : [];
          return {
            stderr: subtitlePacketStderr,
            stdout: JSON.stringify({
              streams: subtitlePacketStreams ?? derivedPacketStreams,
            }),
          };
        }
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

    await validator.prepareAndValidate(
      "/media/.Example.mkv.claim.rip-dvd-partial",
      new AbortController().signal,
    );

    expect(runMediaTool).toHaveBeenCalledTimes(5);
    expect(runMediaTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments_: expect.arrayContaining(["-count_packets"]),
        executable: "ffprobe",
        timeoutMs: 300_000,
      }),
    );
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
      validator.prepareAndValidate(
        "/media/subtitle-free.mkv",
        new AbortController().signal,
        { expectedVobSubStreams: [] },
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts identified VobSub streams with language and disposition metadata", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 1, forced: 1 },
            index: 2,
            tags: { language: "eng", title: "English" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 3,
            tags: { language: "eng" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 4,
            tags: { language: "fra" },
          },
          {
            codec_name: "subrip",
            disposition: { default: 0, forced: 0 },
            index: 5,
            tags: { language: "eng" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate(
        "/media/subtitled.mkv",
        new AbortController().signal,
        {
          expectedVobSubStreams: [
            { languageCode: "en" },
            { languageCode: "fr" },
          ],
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("matches same-language normal, commentary, and closed-caption tracks by title", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: { language: "eng" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 3,
            tags: { language: "eng", title: "Commentary" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 4,
            tags: { language: "eng", title: "Closed Caption" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate(
        "/media/subtitled.mkv",
        new AbortController().signal,
        {
          expectedVobSubStreams: [
            { contentLabel: "Normal", languageCode: "en" },
            { contentLabel: "Director", languageCode: "en" },
            { contentLabel: "Normal_CC", languageCode: "en" },
          ],
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a duplicated normal track that replaced same-language commentary", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: { language: "eng" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 3,
            tags: { language: "eng" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [
          { contentLabel: "Normal", languageCode: "en" },
          { contentLabel: "Director", languageCode: "en" },
        ],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: source VobSub stream 2 has title undefined, expected content Director",
    );
  });

  it("rejects swapped same-language commentary and closed-caption titles", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: { language: "eng", title: "Closed Caption" },
          },
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 3,
            tags: { language: "eng", title: "Commentary" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [
          { contentLabel: "Director", languageCode: "en" },
          { contentLabel: "Normal_CC", languageCode: "en" },
        ],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: source VobSub stream 1 has title Closed Caption, expected content Director",
    );
  });

  it("rejects an output that dropped a selected title's VobSub streams", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [] }),
    });

    await expect(
      validator.prepareAndValidate(
        "/media/broken.mkv",
        new AbortController().signal,
        { expectedVobSubStreams: [{}, {}] },
      ),
    ).rejects.toThrow(
      "Encode output validation failed: expected 2 source VobSub streams, found 0",
    );
  });

  it("rejects same-count VobSub streams with the wrong source language", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: { language: "fra" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [{ languageCode: "en" }],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: source VobSub stream 1 has language fra, expected en",
    );
  });

  it("does not let a foreign-audio-search track mask a dropped source track", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 1, forced: 1 },
            index: 2,
            tags: { language: "eng" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [{ languageCode: "en" }],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: expected 1 source VobSub stream, found 0",
    );
  });

  it("matches an unknown DVD language to Matroska's und fallback", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: { language: "und" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate(
        "/media/subtitled.mkv",
        new AbortController().signal,
        { expectedVobSubStreams: [{ languageCode: "xx" }] },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a subtitle stream without a language tag", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags: {},
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle stream metadata is incomplete",
    );
  });

  it("rejects an unexpected source VobSub disposition", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 1, forced: 0 },
            index: 2,
            tags: { language: "eng" },
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: a source VobSub stream has an unexpected default or forced disposition",
    );
  });

  it("rejects a malformed VobSub packet count", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitlePacketStreams: [
          {
            codec_name: "dvd_subtitle",
            index: 2,
            nb_read_packets: "not-a-count",
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle packet probe returned an invalid result",
    );
  });

  it("rejects a packet probe that omits a declared VobSub stream", async () => {
    const repairer = {
      removeEmptyVobSubStreams: vi.fn(async () => {}),
    };
    const validator = createNodeEncodeOutputValidator({
      repairer,
      runMediaTool: createMediaToolRunner({ subtitlePacketStreams: [] }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle packet probe returned an invalid result",
    );
    expect(repairer.removeEmptyVobSubStreams).not.toHaveBeenCalled();
  });

  it("removes packetless forced variants before accepting useful VobSub streams", async () => {
    const cleanedSubtitleStreams = Array.from({ length: 6 }, (_, position) => ({
      codec_name: "dvd_subtitle",
      disposition:
        position === 0
          ? { default: 1, forced: 1 }
          : { default: 0, forced: 0 },
      index: position + 3,
      tags: { language: position % 2 === 0 ? "eng" : "spa" },
    }));
    const cleanedSubtitlePacketStreams = cleanedSubtitleStreams.map(
      (stream, position) => ({
        codec_name: "dvd_subtitle",
        index: stream.index,
        nb_read_packets: position + 1,
      }),
    );
    const emptySubtitleStreams = Array.from(
      { length: 6 },
      (_, position) => ({
        codec_name: "dvd_subtitle",
        disposition: { default: 0, forced: 0 },
        index: position + 9,
        tags: { language: position % 2 === 0 ? "eng" : "spa" },
      }),
    );
    const originalRunner = createMediaToolRunner({
      subtitlePacketStreams: [
        ...cleanedSubtitlePacketStreams,
        ...emptySubtitleStreams.map((stream) => ({
          codec_name: "dvd_subtitle",
          index: stream.index,
        })),
      ],
      subtitleStreams: [
        ...cleanedSubtitleStreams,
        ...emptySubtitleStreams,
      ],
    });
    let remuxed = false;
    const runMediaTool = vi.fn(async (request: MediaToolRunRequest) => {
      if (remuxed) {
        const streamSelector = request.arguments_[
          request.arguments_.indexOf("-select_streams") + 1
        ];
        if (streamSelector === "s") {
          return mediaToolResult(
            JSON.stringify({
              streams: request.arguments_.includes("-count_packets")
                ? cleanedSubtitlePacketStreams
                : cleanedSubtitleStreams,
            }),
          );
        }
      }
      return originalRunner(request);
    });
    const repairer = {
      removeEmptyVobSubStreams: vi.fn(async () => {
        remuxed = true;
      }),
    };
    const validator = createNodeEncodeOutputValidator({
      repairer,
      runMediaTool,
    });

    await expect(
      validator.prepareAndValidate(
        "/media/subtitled.mkv",
        new AbortController().signal,
        {
          expectedVobSubStreams: cleanedSubtitleStreams
            .slice(1)
            .map((stream) => ({ languageCode: stream.tags.language })),
        },
      ),
    ).resolves.toBeUndefined();

    expect(repairer.removeEmptyVobSubStreams).toHaveBeenCalledWith({
      emptyStreamIndexes: [9, 10, 11, 12, 13, 14],
      outputPath: "/media/subtitled.mkv",
      retainedSubtitleDispositions: [
        { default: true, forced: true },
        ...Array.from({ length: 5 }, () => ({
          default: false,
          forced: false,
        })),
      ],
      signal: expect.any(AbortSignal),
      timeoutMs: 300_000,
    });
  });

  it("rejects VobSub packet read errors reported by ffprobe", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitlePacketStderr: "invalid subtitle packet",
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle packet probe reported unreadable data",
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
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: subtitle stream metadata is incomplete",
    );
  });

  it("rejects a malformed subtitle probe result", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: {} }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
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
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: video stream metadata is incomplete",
    );
  });

  it("rejects video that begins too far behind the audio", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ videoFirstPts: "24.480000" }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: first video frame starts 24.480 seconds after the audio baseline",
    );
  });

  it("rejects video that produces no frames during a bounded decode", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ decodedFrames: 0 }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal),
    ).rejects.toThrow(
      "Encode output validation failed: the first 5 seconds decoded zero video frames",
    );
  });
});
