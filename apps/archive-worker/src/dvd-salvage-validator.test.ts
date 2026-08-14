import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./optical-drive-command-runner.js";
import { createDamagedDvdRecoveryResult } from "./dvd-recovery-contracts.js";
import { createNodeDvdSalvageValidator } from "./dvd-salvage-validator.js";

const expectedTitleMap = {
  schemaVersion: 2 as const,
  contentId: `dvdmeta-sha256:${"1".repeat(64)}`,
  titles: [{
    number: 1,
    durationSeconds: 3_600,
    chapters: 10,
    audioStreams: [],
    subtitles: [],
  }],
};
const recoveryResult = createDamagedDvdRecoveryResult(4_096, [
  { startLba: 1, sectorCount: 1 },
]);
const lsdvdOutput = [
  "Disc Title: SALVAGE_DISC",
  "Title: 1, Length: 01:00:00.000 Chapters: 10, Cells: 10, Audio streams: 0, Subpictures: 0",
].join("\n");
const payloadExpectedTitleMap = {
  ...expectedTitleMap,
  titles: [{
    ...expectedTitleMap.titles[0],
    audioStreams: [{
      id: 128,
      languageCode: "en",
      language: "English",
      format: "ac3",
      channels: 2,
    }],
  }],
};
const payloadLsdvdOutput = [
  "Disc Title: SALVAGE_DISC",
  "Title: 1, Length: 01:00:00.000 Chapters: 10, Cells: 10, Audio streams: 1, Subpictures: 0",
  "  VTS: 01, TTN: 01, FPS: 29.97, Format: NTSC, Aspect ratio: 4/3, Width: 720, Height: 480, DF: Letterbox",
  "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
].join("\n");
const completedPlaybackOutput = [
  "[12:00:00] ac3-decoder done: 112500 frames, 0 decoder errors",
  "[12:00:00] mpeg2video-decoder done: 90000 frames, 0 decoder errors",
  "[12:00:00] sync: got 90000 frames, 90000 expected",
  "[12:00:00] sync: framerate min 25.000 fps, max 25.000 fps, avg 25.000 fps",
  "[12:00:00] libhb: work result = 0",
  "# Job Completed!",
].join("\n");

function validationRequest() {
  return {
    expectedTitleMap,
    imagePath: "/private/originals/rescued-image.partial",
    recoveryResult,
    signal: new AbortController().signal,
  };
}

function payloadValidationRunner(playback: {
  error?: Error;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
} = {}) {
  const run = vi.fn<CommandRunner["run"]>()
    .mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        affectedTitleSetNumbers: [1],
        protocolVersion: 1,
        outcome: "accepted",
      }),
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: payloadLsdvdOutput,
    });
  return playback.error === undefined
    ? run.mockResolvedValueOnce({
      exitCode: playback.exitCode ?? 0,
      stderr: playback.stderr ?? completedPlaybackOutput,
      stdout: playback.stdout ?? "",
    })
    : run.mockRejectedValueOnce(playback.error);
}

describe("DVD salvage validation process boundary", () => {
  it("accepts unused damage only after filesystem and navigation validation", async () => {
    const run = vi.fn<CommandRunner["run"]>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ protocolVersion: 1, outcome: "accepted" }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: lsdvdOutput,
      });
    const validator = createNodeDvdSalvageValidator({
      classifierScriptPath: "/app/dvd-layout-classifier-cli.js",
      runner: { run },
    });
    const request = validationRequest();

    await expect(validator.validate(request)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(run).toHaveBeenNthCalledWith(
      2,
      "rip-dvd-lsdvd",
      ["-Oh", "-a", "-c", "-s", request.imagePath],
      expect.objectContaining({ signal: request.signal }),
    );
  });

  it("accepts isolated payload damage only after DVD title playback completes", async () => {
    const run = payloadValidationRunner();
    const validator = createNodeDvdSalvageValidator({ runner: { run } });
    const request = {
      ...validationRequest(),
      expectedTitleMap: payloadExpectedTitleMap,
    };

    await expect(validator.validate(request)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(run).toHaveBeenNthCalledWith(
      3,
      "rip-dvd-handbrake",
      expect.arrayContaining([
        "--input",
        request.imagePath,
        "--title",
        "1",
        "--output",
        "/dev/null",
      ]),
      expect.objectContaining({ signal: request.signal }),
    );
    expect(run.mock.calls[2]![1]).not.toContain("--no-dvdnav");
  });

  it("decodes every title that references the affected title VOB", async () => {
    const secondTitle = {
      ...payloadExpectedTitleMap.titles[0],
      number: 2,
    };
    const sharedTitleMap = {
      ...payloadExpectedTitleMap,
      titles: [payloadExpectedTitleMap.titles[0], secondTitle],
    };
    const sharedVobLsdvdOutput = [
      payloadLsdvdOutput,
      "Title: 2, Length: 01:00:00.000 Chapters: 10, Cells: 10, Audio streams: 1, Subpictures: 0",
      "  VTS: 01, TTN: 02, FPS: 29.97, Format: NTSC, Aspect ratio: 4/3, Width: 720, Height: 480, DF: Letterbox",
      "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
    ].join("\n");
    const run = vi.fn<CommandRunner["run"]>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          affectedTitleSetNumbers: [1],
          protocolVersion: 1,
          outcome: "accepted",
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: sharedVobLsdvdOutput,
      })
      .mockResolvedValue({
        exitCode: 0,
        stderr: completedPlaybackOutput,
        stdout: "",
      });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      expectedTitleMap: sharedTitleMap,
    })).resolves.toEqual({ outcome: "accepted" });
    expect(run.mock.calls.slice(2).map((call) => call[1])).toEqual([
      expect.arrayContaining(["--title", "1"]),
      expect.arrayContaining(["--title", "2"]),
    ]);
  });

  it.each([
    [
      "missing audio stream",
      completedPlaybackOutput.replace(
        /^.*ac3-decoder done:.*\n/m,
        "",
      ),
      "decoder_stream",
    ],
    [
      "missing video stream",
      completedPlaybackOutput.replace(
        /^.*mpeg2video-decoder done:.*\n/m,
        "",
      ),
      "decoder_stream",
    ],
    [
      "duration more than one second short",
      completedPlaybackOutput.replace(
        "sync: got 90000 frames, 90000 expected",
        "sync: got 89974 frames, 90000 expected",
      ),
      "decoder_duration",
    ],
    [
      "decoder failure rate above the threshold",
      completedPlaybackOutput
        .replace(
          "ac3-decoder done: 112500 frames, 0 decoder errors",
          "ac3-decoder done: 0 frames, 0 decoder errors",
        )
        .replace(
          "mpeg2video-decoder done: 90000 frames, 0 decoder errors",
          "mpeg2video-decoder done: 9998 frames, 2 decoder errors",
        ),
      "decoder_rate",
    ],
  ] as const)("rejects payload damage after %s", async (
    _name,
    playbackOutput,
    reason,
  ) => {
    const run = payloadValidationRunner({ stderr: playbackOutput });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      expectedTitleMap: payloadExpectedTitleMap,
    })).resolves.toEqual({ outcome: "rejected", reason });
  });

  it.each([
    [
      "one-second duration shortfall",
      completedPlaybackOutput.replace(
        "sync: got 90000 frames, 90000 expected",
        "sync: got 89975 frames, 90000 expected",
      ),
    ],
    [
      "decoder failure rate at the threshold",
      completedPlaybackOutput
        .replace(
          "ac3-decoder done: 112500 frames, 0 decoder errors",
          "ac3-decoder done: 0 frames, 0 decoder errors",
        )
        .replace(
          "mpeg2video-decoder done: 90000 frames, 0 decoder errors",
          "mpeg2video-decoder done: 9999 frames, 1 decoder errors",
        ),
    ],
  ] as const)("accepts payload damage with %s", async (
    _name,
    playbackOutput,
  ) => {
    const run = payloadValidationRunner({ stderr: playbackOutput });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      expectedTitleMap: payloadExpectedTitleMap,
    })).resolves.toEqual({ outcome: "accepted" });
  });

  it.each([
    [
      "malformed completion",
      () => payloadValidationRunner({
        stderr: completedPlaybackOutput.replace(/^.*sync: got.*\n/m, ""),
      }),
      "DVD title playback validator returned malformed output",
    ],
    [
      "decoder crash",
      () => payloadValidationRunner({ exitCode: 9, stderr: "private path" }),
      "DVD title playback validation failed",
    ],
    [
      "decoder timeout",
      () => payloadValidationRunner({
        error: new Error("device command timed out at /private/image"),
      }),
      "DVD title playback validation failed",
    ],
  ] as const)("fails closed on %s", async (
    _name,
    createRunner,
    expectedMessage,
  ) => {
    const run = createRunner();
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      expectedTitleMap: payloadExpectedTitleMap,
    })).rejects.toThrow(expectedMessage);
  });

  it("returns a structural rejection without traversing damaged navigation", async () => {
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        protocolVersion: 1,
        outcome: "rejected",
        reason: "navigation",
      }),
    });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate(validationRequest())).resolves.toEqual({
      outcome: "rejected",
      reason: "navigation",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      createDamagedDvdRecoveryResult(4 * 2_048, [
        { startLba: 1, sectorCount: 2 },
      ]),
      "consecutive_damage",
    ],
    [
      createDamagedDvdRecoveryResult(
        80 * 2_048,
        Array.from({ length: 33 }, (_, index) => ({
          startLba: index * 2,
          sectorCount: 1,
        })),
      ),
      "policy_limit",
    ],
  ] as const)("rejects %s before filesystem admission", async (
    boundedRecoveryResult,
    reason,
  ) => {
    const run = vi.fn<CommandRunner["run"]>();
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      recoveryResult: boundedRecoveryResult,
    })).resolves.toEqual({ outcome: "rejected", reason });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects multiple isolated payload sectors before title playback", async () => {
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        affectedTitleSetNumbers: [1],
        protocolVersion: 1,
        outcome: "accepted",
      }),
    });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate({
      ...validationRequest(),
      recoveryResult: createDamagedDvdRecoveryResult(6 * 2_048, [
        { startLba: 1, sectorCount: 1 },
        { startLba: 3, sectorCount: 1 },
      ]),
    })).resolves.toEqual({ outcome: "rejected", reason: "policy_limit" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["process crash", async () => ({ exitCode: 9, stderr: "secret path", stdout: "" }), "DVD salvage filesystem classification failed"],
    ["malformed protocol", async () => ({ exitCode: 0, stderr: "", stdout: "not-json" }), "DVD salvage classifier returned malformed output"],
    ["timeout", async () => {
      throw new Error("device command timed out at /private/image");
    }, "DVD salvage filesystem classification failed"],
    ["admission exhaustion", async () => {
      throw new Error("device command capacity is exhausted");
    }, "DVD salvage filesystem classification failed"],
  ] as const)("fails closed on classifier %s", async (
    _name,
    implementation,
    expectedMessage,
  ) => {
    const validator = createNodeDvdSalvageValidator({
      runner: { run: vi.fn(implementation) },
    });

    await expect(validator.validate(validationRequest())).rejects.toThrow(
      expectedMessage,
    );
  });

  it("fails closed when navigation no longer matches Disc Inspection", async () => {
    const run = vi.fn<CommandRunner["run"]>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ protocolVersion: 1, outcome: "accepted" }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: lsdvdOutput.replace("Chapters: 10", "Chapters: 9"),
      });
    const validator = createNodeDvdSalvageValidator({ runner: { run } });

    await expect(validator.validate(validationRequest())).rejects.toThrow(
      "DVD salvage navigation validation changed the title map",
    );
  });
});
