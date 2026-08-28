import { describe, expect, it } from "vitest";

import { createByteProgressRateEstimator } from "./byte-progress-rate.js";

describe("byte progress rate estimator", () => {
  it("stabilizes throughput and ETA, then resets for a restarted byte stream", () => {
    const estimator = createByteProgressRateEstimator();

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
});
