import { vi } from "vitest";

import type { DataAccess } from "./types.js";

const SETTLING_OBSERVATION_ELAPSED_MS = [0, 2_500, 5_000] as const;

type DiscSettlingTestDataAccess = Pick<DataAccess, "discInspections">;

function startDiscSettlingClockForTest() {
  const alreadyUsingFakeTimers = vi.isFakeTimers();
  if (!alreadyUsingFakeTimers) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  return {
    alreadyUsingFakeTimers,
    firstObservationAt,
    setObservationTime(elapsedMs: number) {
      vi.setSystemTime(new Date(firstObservationAt + elapsedMs));
    },
  };
}

export function beginSettledDiscInspectionForTest(
  access: DiscSettlingTestDataAccess,
  input: Parameters<DataAccess["discInspections"]["beginOrResume"]>[0],
) {
  const clock = startDiscSettlingClockForTest();
  const started = access.discInspections.beginOrResume(input);
  if (started.claim === null) {
    throw new Error("Expected a claimed settling Disc Inspection");
  }
  let claim = started.claim;
  let inspection = started.inspection;
  for (const elapsedMs of SETTLING_OBSERVATION_ELAPSED_MS.slice(1)) {
    clock.setObservationTime(elapsedMs);
    const observed = access.discInspections.recordSettlingObservation(claim, {
      mediaGeneration: input.mediaGeneration,
      mediaCapacityBytes: input.mediaCapacityBytes,
    });
    claim = observed.claim;
    inspection = observed.inspection;
  }
  return {
    inspection,
    claim,
    restoreSystemTime() {
      if (clock.alreadyUsingFakeTimers) {
        vi.setSystemTime(new Date(clock.firstObservationAt));
      } else {
        vi.useRealTimers();
      }
    },
  };
}
