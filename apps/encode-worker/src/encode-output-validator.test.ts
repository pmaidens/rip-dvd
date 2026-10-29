import { describe, expect, it, vi } from "vitest";

import { subtitleLog } from "./test-fixtures/handbrake-subtitle-log.js";
import { createHandBrakeSubtitleProvenanceParser } from "./handbrake-subtitle-provenance.js";

import { createNodeDvdSubtitleScanner } from "./dvd-subtitle-scanner.js";
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
  outputDurationSeconds = 8_078,
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
  outputDurationSeconds?: number | null;
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
            format: { duration: String(outputDurationSeconds) },
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
          streams: [{ index: 1 }],
        }),
      );
    },
  );
}

describe("encode output validation", () => {
  it.each(["EIO", "ENOSPC", "EDQUOT", "EROFS", "ESTALE"])("does not make a %s probe storage fault retainable", async (code) => {
    const validator = createNodeEncodeOutputValidator({ runMediaTool: async () => {
      throw Object.assign(new Error("Synthetic media storage failure"), { code });
    } });
    await expect(validator.prepareAndValidate("/media/synthetic.mkv", new AbortController().signal)).rejects.toMatchObject({ retentionSafe: false });
  });

  it.each([true, false])("preserves complete sources and search playback flags, reused=%s", async (reused) => {
    const expectedVobSubStreams = [
      { languageCode: "eng", sourceTrackNumber: 1, title: null },
      { languageCode: "eng", sourceTrackNumber: 2, title: null },
    ];
    const parser = createHandBrakeSubtitleProvenanceParser();
    parser.push(subtitleLog({ search: true, reused }));
    const repairer = { removeEmptyVobSubStreams: vi.fn(async () => {}) };
    const runMediaTool = createMediaToolRunner({
      subtitleStreams: [
        { index: 2, codec_name: "dvd_subtitle", disposition: { default: 1, forced: 1 }, tags: { language: "eng" } },
        { index: 3, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "eng" } },
        ...(!reused ? [{ index: 4, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "eng" } }] : []),
      ],
    });
    const validator = createNodeEncodeOutputValidator({ repairer, runMediaTool });
    await expect(validator.prepareAndValidate("/media/subtitled.mkv", new AbortController().signal, {
      expectedVobSubStreams,
      vobSubProvenance: parser.finish(expectedVobSubStreams),
    })).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
    expect(repairer.removeEmptyVobSubStreams).not.toHaveBeenCalled();
    expect(runMediaTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments_: expect.arrayContaining(["-count_packets"]),
    }));
  });

  it.each([
    { name: "language", language: "fra", title: "Commentary", defaultFlag: 1, forcedFlag: 1, error: "source VobSub stream 2 has language" },
    { name: "title", language: "eng", title: undefined, defaultFlag: 1, forcedFlag: 1, error: "source VobSub stream 2 has title" },
    { name: "default flag", language: "eng", title: "Commentary", defaultFlag: 0, forcedFlag: 1, error: "disposition inconsistent" },
    { name: "forced flag", language: "eng", title: "Commentary", defaultFlag: 1, forcedFlag: 0, error: "disposition inconsistent" },
  ])("rejects incorrect $name on a source reused by search", async ({ language, title, defaultFlag, forcedFlag, error }) => {
    const expectedVobSubStreams = [
      { languageCode: "eng", sourceTrackNumber: 1, title: null },
      { languageCode: "eng", sourceTrackNumber: 2, title: "Commentary" },
    ];
    const parser = createHandBrakeSubtitleProvenanceParser();
    parser.push(subtitleLog({ search: true, reused: true }));
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [
        { index: 2, codec_name: "dvd_subtitle", disposition: { default: defaultFlag, forced: forcedFlag }, tags: { language, title } },
        { index: 3, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "eng" } },
      ] }),
    });
    await expect(validator.prepareAndValidate("/media/subtitled.mkv", new AbortController().signal, {
      expectedVobSubStreams,
      vobSubProvenance: parser.finish(expectedVobSubStreams),
    })).rejects.toThrow(error);
  });

  it("matches source metadata by identity after search reorders a named source", async () => {
    const expectedVobSubStreams = [
      { languageCode: "fra", sourceTrackNumber: 1, title: "Commentary" },
      { languageCode: "eng", sourceTrackNumber: 2, title: null },
    ];
    const parser = createHandBrakeSubtitleProvenanceParser();
    parser.push(subtitleLog({ search: true, reused: true }));
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [
        { index: 2, codec_name: "dvd_subtitle", disposition: { default: 1, forced: 1 }, tags: { language: "eng" } },
        { index: 3, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "fra", title: "Commentary" } },
      ] }),
    });
    await expect(validator.prepareAndValidate("/media/subtitled.mkv", new AbortController().signal, {
      expectedVobSubStreams,
      vobSubProvenance: parser.finish(expectedVobSubStreams),
    })).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
  });

  it("does not count a derived search result as its missing complete source", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ subtitleStreams: [
        { index: 2, codec_name: "dvd_subtitle", disposition: { default: 1, forced: 1 }, tags: { language: "eng" } },
        { index: 3, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "eng" } },
      ] }),
    });
    await expect(validator.prepareAndValidate("/media/subtitled.mkv", new AbortController().signal, {
      expectedVobSubStreams: [
        { languageCode: "eng", sourceTrackNumber: 1 },
        { languageCode: "eng", sourceTrackNumber: 2 },
      ],
      vobSubProvenance: [
        { sourceTrackNumber: 2, kind: "foreign_audio_search", default: true, forced: true },
        { sourceTrackNumber: 1, kind: "source", default: false, forced: false },
      ],
    })).rejects.toThrow("expected 2 source VobSub streams, found 1");
  });

  it.each([false, true])("revalidates renumbered reused source flags after empty-track cleanup, damaged=%s", async (damaged) => {
    const expectedVobSubStreams = [
      { languageCode: "fra", sourceTrackNumber: 1, title: "Commentary" },
      { languageCode: "eng", sourceTrackNumber: 2, title: null },
    ];
    const originalExpectations = structuredClone(expectedVobSubStreams);
    const parser = createHandBrakeSubtitleProvenanceParser();
    parser.push(subtitleLog({ search: true, reused: true }));
    let cleaned = false;
    const repairer = { removeEmptyVobSubStreams: vi.fn(async () => { cleaned = true; }) };
    const validator = createNodeEncodeOutputValidator({
      repairer,
      runMediaTool: async (request) => createMediaToolRunner({
        subtitleStreams: cleaned ? [
          { index: 2, codec_name: "dvd_subtitle", disposition: { default: damaged ? 0 : 1, forced: 1 }, tags: { language: "eng" } },
        ] : [
          { index: 6, codec_name: "dvd_subtitle", disposition: { default: 1, forced: 1 }, tags: { language: "eng" } },
          { index: 8, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "fra", title: "Commentary" } },
        ],
        subtitlePacketStreams: cleaned ? [
          { index: 2, codec_name: "dvd_subtitle", nb_read_packets: "4" },
        ] : [
          { index: 6, codec_name: "dvd_subtitle", nb_read_packets: "4" },
          { index: 8, codec_name: "dvd_subtitle", nb_read_packets: "0" },
        ],
      })(request),
    });
    const validation = validator.prepareAndValidate("/media/subtitled.mkv", new AbortController().signal, {
      expectedVobSubStreams,
      vobSubProvenance: parser.finish(expectedVobSubStreams),
    });
    if (damaged) {
      await expect(validation).rejects.toThrow("disposition inconsistent");
    } else {
      await expect(validation).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
    }
    expect(repairer.removeEmptyVobSubStreams).toHaveBeenCalledWith(expect.objectContaining({
      emptyStreamIndexes: [8],
      retainedSubtitleDispositions: [{ default: true, forced: true }],
    }));
    expect(expectedVobSubStreams).toEqual(originalExpectations);
  });

  it.each([
    { title: null, actualTitle: undefined, valid: true },
    { title: "Commentary", actualTitle: "Commentary", valid: true },
    { title: null, actualTitle: "Commentary", valid: false },
    { title: "Commentary", actualTitle: undefined, valid: false },
    { title: "Closed Caption", actualTitle: "Commentary", valid: false },
  ])("validates HandBrake track name $title against $actualTitle", async ({
    title, actualTitle, valid,
  }) => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [{
          codec_name: "dvd_subtitle",
          disposition: { default: 0, forced: 0 },
          index: 2,
          tags: { language: "eng", title: actualTitle },
        }],
      }),
    });
    const validation = validator.prepareAndValidate(
      "/media/subtitled.mkv",
      new AbortController().signal,
      { expectedVobSubStreams: [{ languageCode: "eng", title }] },
    );
    if (valid) {
      await expect(validation).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
    } else {
      await expect(validation).rejects.toThrow("source VobSub stream 1 has title");
    }
  });

  it("rejects a materially truncated full-title output", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ outputDurationSeconds: 97.205 }),
    });

    const failure = validator.prepareAndValidate(
      "/media/truncated.mkv",
      new AbortController().signal,
      { expectedDurationSeconds: 8_078 },
    );

    await expect(failure).rejects.toThrow(
      "Encode output validation failed: output duration 97.205 seconds is materially shorter than the expected 8078 seconds",
    );
    await expect(failure).rejects.toMatchObject({
      evidence: {
        kind: "duration",
        expectedSeconds: 8_078,
        observedSeconds: 97.205,
      },
    });
  });

  it("accepts a full-title output within the duration tolerance", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ outputDurationSeconds: 8_000 }),
    });

    await expect(
      validator.prepareAndValidate(
        "/media/complete.mkv",
        new AbortController().signal,
        { expectedDurationSeconds: 8_078 },
      ),
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
  });

  it("rejects missing duration metadata for a full-title output", async () => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({ outputDurationSeconds: null }),
    });

    const failure = validator.prepareAndValidate(
      "/media/unmeasured.mkv",
      new AbortController().signal,
      { expectedDurationSeconds: 8_078 },
    );
    await expect(failure).rejects.toThrow(
      "Encode output validation failed: output duration metadata is unavailable",
    );
    await expect(failure).rejects.toMatchObject({
      evidence: { kind: "validation_check", check: "duration_metadata" },
    });
  });

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
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
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
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
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
            { languageCode: "en", title: null },
            { languageCode: "en", title: "Commentary" },
            { languageCode: "en", title: "Closed Caption" },
          ],
        },
      ),
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
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
          { languageCode: "en", title: null },
          { languageCode: "en", title: "Commentary" },
        ],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: source VobSub stream 2 has title undefined, expected title Commentary",
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
          { languageCode: "en", title: "Commentary" },
          { languageCode: "en", title: "Closed Caption" },
        ],
      }),
    ).rejects.toThrow(
      "Encode output validation failed: source VobSub stream 1 has title Closed Caption, expected title Commentary",
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
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
  });

  it.each([
    { name: "absent tags", tags: undefined, title: null },
    { name: "empty tags", tags: {}, title: null },
    { name: "title only", tags: { title: "Commentary" }, title: "Commentary" },
    { name: "explicit und", tags: { language: "und" }, title: null },
  ])("matches an unspecified scanned language with $name", async ({ tags, title }) => {
    const scanner = createNodeDvdSubtitleScanner({
      runCommand: async () => ({
        stdout: `JSON Title Set: ${JSON.stringify({
          TitleList: [{
            Index: 4,
            SubtitleList: [
              {
                TrackNumber: 1,
                SourceName: "VOBSUB",
                Format: "bitmap",
                LanguageCode: "und",
                ...(title ? { Name: title } : {}),
              },
              { TrackNumber: 2, SourceName: "CC608", Format: "text", LanguageCode: "eng" },
            ],
          }],
        })}`,
      }),
    });
    const signal = new AbortController().signal;
    const expectedVobSubStreams = await scanner.scan("/source.iso", 4, signal);
    expect(expectedVobSubStreams).toEqual([{ languageCode: "und", sourceTrackNumber: 1, title }]);
    const runMediaTool = createMediaToolRunner({
      subtitleStreams: [
        {
          codec_name: "dvd_subtitle",
          disposition: { default: 0, forced: 0 },
          index: 2,
          tags,
        },
        {
          codec_name: "ass",
          disposition: { default: 0, forced: 0 },
          index: 3,
          tags: { language: "eng" },
        },
      ],
    });
    const repairer = {
      removeEmptyVobSubStreams: vi.fn(async () => {
        throw new Error("Unexpected repair");
      }),
    };
    const validator = createNodeEncodeOutputValidator({ repairer, runMediaTool });

    await expect(validator.prepareAndValidate("/media/subtitled.mkv", signal, {
      expectedDurationSeconds: 8_078,
      expectedVobSubStreams,
    })).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });

    expect(repairer.removeEmptyVobSubStreams).not.toHaveBeenCalled();
    expect(runMediaTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments_: expect.arrayContaining(["-count_packets"]),
    }));
    expect(runMediaTool).toHaveBeenCalledWith(expect.objectContaining({ executable: "ffmpeg" }));
  });

  it.each([
    { languageCode: "eng", tags: undefined },
    { languageCode: "fra", tags: {} },
    { languageCode: "eng", tags: { language: "und" } },
    { languageCode: "und", tags: { language: "eng" } },
  ])("rejects a source language mismatch for $languageCode against $tags", async ({ languageCode, tags }) => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [
          {
            codec_name: "dvd_subtitle",
            disposition: { default: 0, forced: 0 },
            index: 2,
            tags,
          },
        ],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [{ languageCode }],
      }),
    ).rejects.toThrow("source VobSub stream 1 has language");
  });

  it.each([
    null, [], "invalid", 7,
    ...[null, "", " ", "unknown", "xx", 7, [], {}].map((language) => ({ language })),
    { title: null }, { title: "" }, { title: "unknown" },
  ])("rejects malformed subtitle tags %j even for an unspecified source language", async (tags) => {
    const validator = createNodeEncodeOutputValidator({
      runMediaTool: createMediaToolRunner({
        subtitleStreams: [{
          codec_name: "dvd_subtitle",
          disposition: { default: 0, forced: 0 },
          index: 2,
          tags,
        }],
      }),
    });

    await expect(
      validator.prepareAndValidate("/media/broken.mkv", new AbortController().signal, {
        expectedVobSubStreams: [{ languageCode: "und" }],
      }),
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
          expectedVobSubStreams: [...cleanedSubtitleStreams.slice(1), ...emptySubtitleStreams]
            .map((stream) => ({ languageCode: stream.tags.language })),
        },
      ),
    ).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });

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

  it.each<{
    name: string;
    count?: unknown;
    packetFault?: "missing" | "duplicate" | "unexpected" | "stderr";
    beforeFault?: "language" | "title" | "disposition";
    afterFault?: "missing" | "extra" | "language" | "title" | "empty";
    failure?: string;
  }>([
    { name: "absent packet count" },
    { name: "explicit string zero", count: "0" },
    { name: "explicit numeric zero", count: 0 },
    ...[null, "N/A", "", "-1", "1.5", "0garbage", -1, 0.5, {}, "9007199254740992"].map((count) => ({
      name: `invalid count ${JSON.stringify(count)}`, count, failure: "subtitle packet probe returned an invalid result",
    })),
    { name: "missing packet stream", packetFault: "missing", failure: "subtitle packet probe returned an invalid result" },
    { name: "duplicate packet stream", packetFault: "duplicate", failure: "subtitle packet probe returned an invalid result" },
    { name: "unexpected packet stream", packetFault: "unexpected", failure: "subtitle packet probe returned an invalid result" },
    { name: "packet read errors", packetFault: "stderr", failure: "subtitle packet probe reported unreadable data" },
    { name: "empty track language mismatch", beforeFault: "language", failure: "has language fra, expected eng" },
    { name: "empty track title mismatch", beforeFault: "title", failure: "has title Wrong, expected title Main" },
    { name: "empty track disposition mismatch", beforeFault: "disposition", failure: "unexpected default or forced disposition" },
    { name: "cleanup drops populated source", afterFault: "missing", failure: "expected 1 source VobSub stream, found 0" },
    { name: "cleanup keeps extra source", afterFault: "extra", failure: "expected 1 source VobSub stream, found 2" },
    { name: "cleanup changes language", afterFault: "language", failure: "has language eng, expected spa" },
    { name: "cleanup changes title", afterFault: "title", failure: "has title Wrong, expected title Commentary" },
    { name: "cleanup leaves empty track", afterFault: "empty", failure: "subtitle cleanup left an empty VobSub stream" },
  ])("accounts for empty source streams with $name", async ({
    count, packetFault, beforeFault, afterFault, failure,
  }) => {
    const source = [
      { index: 2, codec_name: "dvd_subtitle", disposition: { default: 0, forced: beforeFault === "disposition" ? 1 : 0 }, tags: {
        language: beforeFault === "language" ? "fra" : "eng", title: beforeFault === "title" ? "Wrong" : "Main",
      } },
      { index: 3, codec_name: "dvd_subtitle", disposition: { default: 0, forced: 0 }, tags: { language: "spa", title: "Commentary" } },
    ];
    const retained = { ...source[1]!, index: 2, tags: {
      language: afterFault === "language" ? "eng" : "spa",
      title: afterFault === "title" ? "Wrong" : "Commentary",
    } };
    const packetStreams = [
      { index: 2, codec_name: "dvd_subtitle", nb_read_packets: count },
      { index: 3, codec_name: "dvd_subtitle", nb_read_packets: "10" },
    ];
    if (packetFault === "missing") packetStreams.shift();
    if (packetFault === "duplicate") packetStreams.push(packetStreams[0]!);
    if (packetFault === "unexpected") packetStreams.push({ index: 9, codec_name: "dvd_subtitle", nb_read_packets: "0" });
    const originalRunner = createMediaToolRunner({
      subtitleStreams: source, subtitlePacketStreams: packetStreams,
      subtitlePacketStderr: packetFault === "stderr" ? "read error" : "",
    });
    const cleanedRunner = createMediaToolRunner({
      subtitleStreams: afterFault === "missing" ? [] : afterFault === "extra" ? [retained, { ...retained, index: 3 }] : [retained],
      ...(afterFault === "empty" ? { subtitlePacketStreams: [{ index: 2, codec_name: "dvd_subtitle", nb_read_packets: "0" }] } : {}),
    });
    let cleaned = false;
    const repairer = { removeEmptyVobSubStreams: vi.fn(async () => { cleaned = true; }) };
    const validator = createNodeEncodeOutputValidator({
      repairer, runMediaTool: (request) => (cleaned ? cleanedRunner : originalRunner)(request),
    });
    const expectations = { expectedVobSubStreams: [
      { languageCode: "eng", title: "Main" }, { languageCode: "spa", title: "Commentary" },
    ] };
    const result = validator.prepareAndValidate("/media/bonus.mkv", new AbortController().signal, expectations);
    if (failure) await expect(result).rejects.toThrow(failure);
    else await expect(result).resolves.toMatchObject({ policyVersion: "encode-output-validation-v1", decode: { completed: true } });
    expect(repairer.removeEmptyVobSubStreams).toHaveBeenCalledTimes(failure && !afterFault ? 0 : 1);
    if (cleaned) expect(repairer.removeEmptyVobSubStreams).toHaveBeenCalledWith(expect.objectContaining({
      emptyStreamIndexes: [2], retainedSubtitleDispositions: [{ default: false, forced: false }],
    }));
    expect(expectations.expectedVobSubStreams).toHaveLength(2);
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

  it("requires audio only when the immutable source claim requires it", async () => {
    const validator = createNodeEncodeOutputValidator({ runMediaTool: createMediaToolRunner({ audioFirstPts: null }) });
    const signal = new AbortController().signal;
    await expect(validator.prepareAndValidate("/media/synthetic-silent.mkv", signal, { expectedAudioSourceIds: [128], audioOutputSourceIds: [128] }))
      .rejects.toThrow("required audio stream has no readable first packet");
    const evidence = await validator.prepareAndValidate("/media/synthetic-silent.mkv", signal);
    await expect(validator.prepareAndValidate("/media/synthetic-silent.mkv", signal, { expectedAudioSourceIds: [128, 129], audioOutputSourceIds: [128] }))
      .rejects.toThrow("required audio source coverage does not match the source claim");
    expect(evidence).toMatchObject({ audio: { firstPacketSeconds: null, expectedSourceIds: null },
      duration: { expectedSeconds: null, minimumRatio: null }, decode: { seconds: 5, frames: 120, completed: true } });
  });

  it("allows a surround preset's additional encodings of a required source audio stream", async () => {
    const runMediaTool = createMediaToolRunner();
    const validator = createNodeEncodeOutputValidator({ runMediaTool: async (request) => {
      if (request.arguments_.includes("a")) return mediaToolResult(JSON.stringify({
        streams: [{ index: 1 }, { index: 2 }], packets: [{ pts_time: "0.0" }],
      }));
      return runMediaTool(request);
    } });
    await expect(validator.prepareAndValidate("/media/synthetic-surround.mkv", new AbortController().signal,
      { expectedAudioSourceIds: [128], audioOutputSourceIds: [128, 128] }))
      .resolves.toMatchObject({ audio: { expectedSourceIds: [128], outputSourceIds: [128, 128], observedStreams: 2 } });
    await expect(validator.prepareAndValidate("/media/synthetic-missing-commentary.mkv", new AbortController().signal,
      { expectedAudioSourceIds: [128, 129], audioOutputSourceIds: [128, 128] }))
      .rejects.toThrow("required audio source coverage does not match the source claim");
  });

  it("requires a readable packet in each selected audio output", async () => {
    const runMediaTool = createMediaToolRunner();
    const validator = createNodeEncodeOutputValidator({ runMediaTool: async (request) => {
      if (request.arguments_.includes("a")) return mediaToolResult(JSON.stringify({ streams: [{ index: 1 }, { index: 2 }] }));
      if (request.arguments_.includes("a:1")) return mediaToolResult(JSON.stringify({ packets: [] }));
      return runMediaTool(request);
    } });
    await expect(validator.prepareAndValidate("/media/synthetic-empty-commentary.mkv", new AbortController().signal,
      { expectedAudioSourceIds: [128, 129], audioOutputSourceIds: [128, 129] }))
      .rejects.toThrow("required audio stream has no readable first packet");
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
