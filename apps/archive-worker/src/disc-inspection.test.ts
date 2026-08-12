import { describe, expect, it } from "vitest";

import { classifyDiscInspectionError } from "./disc-inspection-error.js";
import { createDiscInspectionRateEstimator } from "./disc-inspection-rate.js";

describe("Disc Inspection worker policy", () => {
  it("stabilizes throughput and ETA, then resets after a restarted hash", () => {
    const estimator = createDiscInspectionRateEstimator();

    expect(estimator.update(0, 10_000, 1_000)).toEqual({
      bytesPerSecond: null,
      etaSeconds: null,
    });
    expect(estimator.update(1_000, 10_000, 2_000)).toEqual({
      bytesPerSecond: null,
      etaSeconds: null,
    });
    expect(estimator.update(2_000, 10_000, 3_000)).toEqual({
      bytesPerSecond: 1_000,
      etaSeconds: 8,
    });
    expect(estimator.update(2_000, 10_000, 4_000)).toEqual({
      bytesPerSecond: 667,
      etaSeconds: 12,
    });
    expect(estimator.update(0, 10_000, 5_000)).toEqual({
      bytesPerSecond: null,
      etaSeconds: null,
    });
    expect(estimator.update(10_000, 10_000, 6_000)).toEqual({
      bytesPerSecond: null,
      etaSeconds: null,
    });
  });

  it("classifies removal, invalid contracts, and transient drive failures centrally", () => {
    expect(classifyDiscInspectionError(new Error("DVD medium changed during scanning")))
      .toMatchObject({ kind: "abort", reasonCode: "media_changed" });
    expect(classifyDiscInspectionError(new Error("lsdvd returned an invalid DVD title map")))
      .toMatchObject({ kind: "fail", reasonCode: "invalid_metadata" });
    expect(classifyDiscInspectionError(new Error("Optical Drive is temporarily not ready")))
      .toMatchObject({ kind: "retry", reasonCode: "drive_not_ready" });
    expect(classifyDiscInspectionError(new Error("DVD content hashing failed")))
      .toMatchObject({ kind: "retry", reasonCode: "content_read_failed" });
  });
});
