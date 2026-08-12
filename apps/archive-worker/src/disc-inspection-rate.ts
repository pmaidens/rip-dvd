export interface DiscInspectionRateEstimate {
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface DiscInspectionRateEstimator {
  update(bytesHashed: number, totalBytes: number, observedAtMs: number): DiscInspectionRateEstimate;
}

interface RateSample {
  bytes: number;
  at: number;
}

export function createDiscInspectionRateEstimator({
  minimumSamples = 3,
  stabilizationMs = 2_000,
  windowMs = 15_000,
}: {
  minimumSamples?: number;
  stabilizationMs?: number;
  windowMs?: number;
} = {}): DiscInspectionRateEstimator {
  if (
    !Number.isSafeInteger(minimumSamples) || minimumSamples < 2 ||
    !Number.isSafeInteger(stabilizationMs) || stabilizationMs <= 0 ||
    !Number.isSafeInteger(windowMs) || windowMs < stabilizationMs
  ) {
    throw new Error("Disc Inspection rate estimator configuration is invalid");
  }
  let samples: RateSample[] = [];
  return {
    update(bytesHashed, totalBytes, observedAtMs) {
      if (
        !Number.isSafeInteger(bytesHashed) || bytesHashed < 0 ||
        !Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
        bytesHashed > totalBytes ||
        !Number.isSafeInteger(observedAtMs) || observedAtMs < 0
      ) {
        throw new Error("Disc Inspection rate sample is invalid");
      }
      const latest = samples.at(-1);
      if (
        latest !== undefined &&
        (bytesHashed < latest.bytes || observedAtMs <= latest.at)
      ) {
        samples = [];
      }
      samples.push({ at: observedAtMs, bytes: bytesHashed });
      const cutoff = observedAtMs - windowMs;
      while (samples.length > 1 && samples[1]!.at <= cutoff) {
        samples.shift();
      }
      if (bytesHashed === totalBytes) {
        return { bytesPerSecond: null, etaSeconds: null };
      }
      const first = samples[0]!;
      const elapsedMs = observedAtMs - first.at;
      const movedBytes = bytesHashed - first.bytes;
      if (
        samples.length < minimumSamples ||
        elapsedMs < stabilizationMs ||
        movedBytes <= 0
      ) {
        return { bytesPerSecond: null, etaSeconds: null };
      }
      const bytesPerSecond = Math.max(1, Math.round(movedBytes * 1_000 / elapsedMs));
      return {
        bytesPerSecond,
        etaSeconds: Math.ceil((totalBytes - bytesHashed) / bytesPerSecond),
      };
    },
  };
}
