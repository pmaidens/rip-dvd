export interface ByteProgressRateEstimate {
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface ByteProgressRateEstimator {
  update(
    completedBytes: number,
    totalBytes: number,
    observedAtMs: number,
  ): ByteProgressRateEstimate;
}

interface RateSample {
  bytes: number;
  at: number;
}

export function createByteProgressRateEstimator({
  minimumSamples = 3,
  stabilizationMs = 2_000,
  windowMs = 15_000,
}: {
  minimumSamples?: number;
  stabilizationMs?: number;
  windowMs?: number;
} = {}): ByteProgressRateEstimator {
  if (
    !Number.isSafeInteger(minimumSamples) || minimumSamples < 2 ||
    !Number.isSafeInteger(stabilizationMs) || stabilizationMs <= 0 ||
    !Number.isSafeInteger(windowMs) || windowMs < stabilizationMs
  ) {
    throw new Error("Byte progress rate estimator configuration is invalid");
  }
  let samples: RateSample[] = [];
  return {
    update(completedBytes, totalBytes, observedAtMs) {
      if (
        !Number.isSafeInteger(completedBytes) || completedBytes < 0 ||
        !Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
        completedBytes > totalBytes ||
        !Number.isSafeInteger(observedAtMs) || observedAtMs < 0
      ) {
        throw new Error("Byte progress rate sample is invalid");
      }
      const latest = samples.at(-1);
      if (
        latest !== undefined &&
        (completedBytes < latest.bytes || observedAtMs <= latest.at)
      ) {
        samples = [];
      }
      samples.push({ at: observedAtMs, bytes: completedBytes });
      const cutoff = observedAtMs - windowMs;
      while (samples.length > 1 && samples[1]!.at <= cutoff) {
        samples.shift();
      }
      if (completedBytes === totalBytes) {
        return { bytesPerSecond: null, etaSeconds: null };
      }
      const first = samples[0]!;
      const elapsedMs = observedAtMs - first.at;
      const movedBytes = completedBytes - first.bytes;
      if (
        samples.length < minimumSamples ||
        elapsedMs < stabilizationMs ||
        movedBytes <= 0
      ) {
        return { bytesPerSecond: null, etaSeconds: null };
      }
      const bytesPerSecond = Math.max(
        1,
        Math.round(movedBytes * 1_000 / elapsedMs),
      );
      return {
        bytesPerSecond,
        etaSeconds: Math.ceil((totalBytes - completedBytes) / bytesPerSecond),
      };
    },
  };
}
