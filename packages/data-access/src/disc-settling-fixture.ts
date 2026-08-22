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

export async function pollDiscSettlingForTest(
  access: DiscSettlingTestDataAccess,
  observe: () => Promise<void>,
): Promise<void> {
  const clock = startDiscSettlingClockForTest();
  try {
    for (const elapsedMs of SETTLING_OBSERVATION_ELAPSED_MS) {
      clock.setObservationTime(elapsedMs);
      await observe();
      if (
        !access.discInspections
          .list({ currentOnly: true })
          .some(
            (inspection) =>
              inspection.status === "running" &&
              inspection.phase === "settling",
          )
      ) {
        return;
      }
    }
  } finally {
    if (!clock.alreadyUsingFakeTimers) {
      vi.useRealTimers();
    }
  }
}

export function beginSettledDiscInspectionForTest(
  access: DiscSettlingTestDataAccess,
  input: Parameters<DataAccess["discInspections"]["beginOrResume"]>[0],
) {
  const clock = startDiscSettlingClockForTest();
  let settled = access.discInspections.beginOrResume(input);
  for (const elapsedMs of SETTLING_OBSERVATION_ELAPSED_MS.slice(1)) {
    clock.setObservationTime(elapsedMs);
    settled = access.discInspections.beginOrResume(input);
  }
  if (settled.claim === null) {
    throw new Error("Expected a settled Disc Inspection claim");
  }
  return {
    ...settled,
    restoreSystemTime() {
      if (clock.alreadyUsingFakeTimers) {
        vi.setSystemTime(new Date(clock.firstObservationAt));
      } else {
        vi.useRealTimers();
      }
    },
  };
}
