import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./optical-drive-command-runner.js";
import { createNodeDvdCompletenessProver } from "./dvd-completeness-prover.js";

const expectedTitleMap = {
  schemaVersion: 2 as const,
  contentId: `dvdmeta-sha256:${"1".repeat(64)}`,
  titles: [{
    number: 1,
    durationSeconds: 3_600,
    chapters: 10,
    audioStreams: [{
      id: 128,
      languageCode: "en",
      language: "English",
      format: "ac3",
      channels: 2,
    }],
    subtitles: [{
      id: 32,
      languageCode: "en",
      language: "English",
      content: "Normal",
    }],
  }],
};

const lsdvdOutput = [
  "Disc Title: COMPLETE_DISC",
  "Title: 1, Length: 01:00:00.000 Chapters: 10, Cells: 10, Audio streams: 1, Subpictures: 1",
  "  VTS: 01, TTN: 01, FPS: 29.97, Format: NTSC, Aspect ratio: 4/3, Width: 720, Height: 480, DF: Letterbox",
  "  Audio: 1, Language: en - English, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
  "  Subtitle: 1, Language: en - English, Content: Normal, Stream id: 0x20",
].join("\n");

function createRunner(navigationOutput = lsdvdOutput) {
  return vi.fn<CommandRunner["run"]>()
    .mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        maximumReferencedLba: 599,
        protocolVersion: 1,
      }),
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: navigationOutput,
    });
}

describe("retained DVD completeness proof process", () => {
  it("returns the maximum LBA after the complete title and stream map agrees", async () => {
    const run = createRunner();
    const prover = createNodeDvdCompletenessProver({
      classifierScriptPath: "/app/dvd-layout-classifier-cli.js",
      runner: { run },
    });
    const signal = new AbortController().signal;

    await expect(prover.prove({
      candidateBoundaryLba: 600,
      expectedTitleMap,
      imagePath: "/private/originals/retained.partial",
      signal,
    })).resolves.toEqual({ maximumReferencedLba: 599 });
    expect(run).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [
        "/app/dvd-layout-classifier-cli.js",
        "proof",
        "/private/originals/retained.partial",
        "600",
      ],
      expect.objectContaining({ signal }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "rip-dvd-lsdvd",
      ["-Oh", "-a", "-c", "-s", "/private/originals/retained.partial"],
      expect.objectContaining({ signal }),
    );
  });

  it.each([
    ["a missing title", lsdvdOutput.replace("Title: 1", "Title: 2")],
    ["a changed stream", lsdvdOutput.replace("Stream id: 0x80", "Stream id: 0x81")],
  ])("fails closed when Disc Inspection disagrees because of %s", async (
    _reason,
    navigationOutput,
  ) => {
    const run = createRunner(navigationOutput);
    const prover = createNodeDvdCompletenessProver({ runner: { run } });

    await expect(prover.prove({
      candidateBoundaryLba: 600,
      expectedTitleMap,
      imagePath: "/private/originals/retained.partial",
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD completeness proof changed the title map");
  });

  it("fails closed on malformed classifier evidence", async () => {
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        maximumReferencedLba: 600,
        protocolVersion: 1,
      }),
    });
    const prover = createNodeDvdCompletenessProver({ runner: { run } });

    await expect(prover.prove({
      candidateBoundaryLba: 600,
      expectedTitleMap,
      imagePath: "/private/originals/retained.partial",
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD completeness classifier returned malformed output");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
