import { describe, expect, it } from "vitest";

import {
  classifyDiscInspectionError,
  DiscInspectionError,
} from "./disc-inspection-error.js";

describe("Disc Inspection worker policy", () => {
  it("does not derive a persisted reason code from arbitrary error text", () => {
    for (const message of [
      "DVD medium changed during scanning",
      "lsdvd returned an invalid DVD title map",
      "Optical Drive is temporarily not ready",
      "DVD content hashing failed",
    ]) {
      expect(classifyDiscInspectionError(new Error(message))).toEqual({
        diagnostic: message,
        kind: "retry",
        reasonCode: "unknown",
      });
    }
  });

  it("classifies only structured Disc Inspection errors", () => {
    expect(classifyDiscInspectionError(new DiscInspectionError(
      "abort",
      "media_changed",
      "The generation token changed",
    ))).toEqual({
      diagnostic: "The generation token changed",
      kind: "abort",
      reasonCode: "media_changed",
    });
    expect(classifyDiscInspectionError(new DiscInspectionError(
      "fail",
      "invalid_metadata",
      "The title map violated its contract",
    ))).toEqual({
      diagnostic: "The title map violated its contract",
      kind: "fail",
      reasonCode: "invalid_metadata",
    });
    expect(classifyDiscInspectionError(new DiscInspectionError(
      "retry",
      "content_read_failed",
      "The content helper failed",
    ))).toEqual({
      diagnostic: "The content helper failed",
      kind: "retry",
      reasonCode: "content_read_failed",
    });
  });
});
