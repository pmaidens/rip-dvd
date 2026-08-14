import { describe, expect, it } from "vitest";

import { formatFailureDetail } from "./failure-detail";

describe("formatFailureDetail", () => {
  it.each([
    [
      "missing optical medium",
      "DVD read failed at /dev/sr0: no medium found",
      "No optical medium was found in the drive.",
    ],
    [
      "drive readiness",
      "/dev/sr0 not ready",
      "The optical drive was not ready.",
    ],
    [
      "permission",
      "Could not open /media/My Movie.iso: Permission denied",
      "The worker did not have permission to complete the operation.",
    ],
    [
      "input/output",
      "HandBrake failed while reading /media/secret.iso: Input/output error",
      "The worker reported an input/output error.",
    ],
    [
      "archive read input/output",
      "DVD archive copy failed: DVD content read failed at byte 1904640: Input/output error",
      "The archive worker encountered an input/output error while reading the disc at byte 1,904,640.",
    ],
    [
      "archive read without a recognized cause",
      "DVD archive copy failed: DVD content read failed at byte 2048: private-name.iso",
      "The archive worker could not read the disc at byte 2,048.",
    ],
    [
      "archive read ending early",
      "DVD archive copy failed: DVD content read ended before the declared media size",
      "The archive worker reached the end of the disc before its declared size.",
    ],
    [
      "rescued unreadable sectors",
      "DVD rescue requires validation: 3 unreadable sectors in 2 areas; LBAs 12, 20-21",
      "The rescued image was retained for validation with 3 unreadable sectors across 2 areas (LBAs 12, 20–21).",
    ],
    [
      "bounded rescued unreadable areas",
      "DVD rescue requires validation: 10 unreadable sectors in 10 areas; LBAs 0, 2, 4, 6, 8, 10, 12, 14, and 2 more",
      "The rescued image was retained for validation with 10 unreadable sectors across 10 areas (LBAs 0, 2, 4, 6, 8, 10, 12, 14, and 2 more).",
    ],
    [
      "structural salvage rejection",
      "DVD salvage rejected: unreadable sectors affect DVD navigation data; 1 sector in 1 area; LBAs 20",
      "Automatic salvage validation rejected damage to DVD navigation data; the image remains available for another recovery attempt with 1 unreadable sector across 1 area (LBAs 20).",
    ],
    [
      "timeout",
      "DVD archive copy timed out",
      "The worker operation timed out.",
    ],
    [
      "cleanup",
      "encode failed; cleanup failed at ../partial/output.mkv",
      "The worker could not clean up a partial output.",
    ],
    [
      "publication",
      "Encode publication mutation was abandoned",
      "The worker could not publish the completed output.",
    ],
    [
      "existing output",
      "Encode Job final output already exists",
      "The Encode Job output already exists.",
    ],
    [
      "unavailable Disc Selection",
      "Encode Job Disc Selection is unavailable",
      "The Encode Job's Disc Selection is no longer available.",
    ],
    [
      "incomplete HandBrake output",
      "HandBrake did not produce a complete regular output file",
      "The worker did not produce a complete output file.",
    ],
    [
      "archive mismatch",
      "Existing DVD archive does not match the Detected Disc",
      "The archived content does not match the detected disc.",
    ],
    [
      "active archive copy",
      "DVD archive copy is still active",
      "Another archive copy is still active.",
    ],
    [
      "partial archive discovery",
      "Could not safely discover DVD archive partials",
      "The archive worker could not safely inspect partial archives for recovery.",
    ],
    [
      "invalid originals library",
      "Originals library must be a real directory",
      "A configured library or output path failed safety validation.",
    ],
    [
      "invalid output hierarchy",
      "Encode output directory hierarchy is invalid",
      "A configured library or output path failed safety validation.",
    ],
    [
      "unsafe claim token",
      "Encode Job claim token is unsafe",
      "The worker's job claim failed integrity validation.",
    ],
    [
      "unsafe optical-drive lock",
      "DVD archive device lock is unsafe",
      "The archive worker could not safely lock the optical drive.",
    ],
    [
      "read failure",
      "disc read failed",
      "The worker could not read its input.",
    ],
    [
      "command status",
      "DVD archive copy stopped with status 23",
      "A worker command exited with status 23.",
    ],
    [
      "archive copy status fallback",
      "DVD archive copy failed with status 1",
      "The archive copy command exited with status 1.",
    ],
    [
      "command signal",
      "worker stopped after signal SIGTERM",
      "A worker command stopped after receiving signal SIGTERM.",
    ],
  ])("classifies a %s without returning raw diagnostics", (_case, errorMessage, expected) => {
    expect(formatFailureDetail(errorMessage)).toBe(expected);
  });

  it.each([
    "failed at h264/aac",
    "failed at media/My Movie with Secret Collection/output.mkv",
    "source[0]/media/private/secret.iso",
    "unrecognized helper failure involving private-name.iso",
  ])("returns a path-free fallback for an unclassified diagnostic", (errorMessage) => {
    const detail = formatFailureDetail(errorMessage);

    expect(detail).toBe(
      "The worker reported an unclassified failure. Check the worker logs for the full diagnostic.",
    );
    expect(detail).not.toContain("private");
    expect(detail).not.toContain("Secret");
    expect(detail).not.toMatch(/[\\/]/);
  });

  it("preserves a missing failure detail", () => {
    expect(formatFailureDetail(null)).toBeNull();
  });
});
