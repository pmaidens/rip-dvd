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

function validationRequest() {
  return {
    expectedTitleMap,
    imagePath: "/private/originals/rescued-image.partial",
    recoveryResult,
    signal: new AbortController().signal,
  };
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
