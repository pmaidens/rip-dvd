import { describe, expect, it } from "vitest";

import { DiscInspectionError } from "./disc-inspection-error.js";
import { decodeDirectDvdCapacity } from "./direct-dvd-capacity.js";
import type { CommandResult } from "./optical-drive-command-runner.js";

function result(
  exitCode: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return { exitCode, signal: null, stderr, stdout };
}

describe("direct DVD capacity decoder", () => {
  it("decodes the READ CAPACITY block count and DVD sector size", () => {
    expect(
      decodeDirectDvdCapacity(result(0, "0x230540 0x800\n")),
    ).toEqual({ kind: "capacity", capacityBytes: 4_700_372_992 });
  });

  it.each([2, 6, 12, 13])(
    "keeps sg3_utils exit status %i as a retryable settling observation",
    (exitCode) => {
      expect(decodeDirectDvdCapacity(result(exitCode))).toEqual({
        kind: "retryable",
      });
    },
  );

  it("distinguishes an absent medium from transient not-ready state", () => {
    expect(
      decodeDirectDvdCapacity(
        result(2, "0x0 0x0\n", "Not ready: medium not present"),
      ),
    ).toEqual({ kind: "no_medium" });
  });

  it.each([3, 5, 7, 11, 33, 98, 99])(
    "fails closed on sg3_utils capacity status %i",
    (exitCode) => {
      expect(() => decodeDirectDvdCapacity(result(exitCode))).toThrow(
        expect.objectContaining<Partial<DiscInspectionError>>({
          kind: "fail",
          reasonCode: "content_size_failed",
        }),
      );
    },
  );

  it.each([15, 126, 127])(
    "classifies unavailable capacity status %i",
    (exitCode) => {
      expect(() => decodeDirectDvdCapacity(result(exitCode))).toThrow(
        expect.objectContaining<Partial<DiscInspectionError>>({
          kind: "retry",
          reasonCode: "drive_unavailable",
        }),
      );
    },
  );

  it.each([
    ["malformed output", "not-capacity"],
    ["zero blocks", "0x0 0x800"],
    ["non-DVD block size", "0x230540 0x200"],
    ["capacity beyond the DVD bound", "0x500000 0x800"],
  ])("rejects %s", (_name, output) => {
    expect(() => decodeDirectDvdCapacity(result(0, output))).toThrow(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "invalid_content",
      }),
    );
  });

  it.each([1, 97])(
    "treats malformed command status %i as invalid content evidence",
    (exitCode) => {
      expect(() => decodeDirectDvdCapacity(result(exitCode))).toThrow(
        expect.objectContaining<Partial<DiscInspectionError>>({
          kind: "fail",
          reasonCode: "invalid_content",
        }),
      );
    },
  );

  it("fails closed when the capacity command ends by signal", () => {
    expect(() =>
      decodeDirectDvdCapacity({
        exitCode: null,
        signal: "SIGKILL",
        stderr: "",
        stdout: "",
      })
    ).toThrow(
      expect.objectContaining<Partial<DiscInspectionError>>({
        kind: "fail",
        reasonCode: "content_size_failed",
      }),
    );
  });
});
