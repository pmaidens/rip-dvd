import { afterEach, describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../test/data-access-fixture";
import { readDashboardSnapshot } from "./dashboard";

const dataAccessFixture = useDataAccessFixture();

afterEach(() => {
  vi.useRealTimers();
});

describe("Worker Incidents on the dashboard", () => {
  it("shows every active incident before at most the activity history limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T00:00:00.000Z");
    const access = dataAccessFixture.create();
    const recoveryIdentity = {
      workerKind: "encode",
      reasonCode: "publication_recovery_failure",
      phase: "publication_recovery",
      retryability: "automatic",
      schemaVersion: 1,
      evidence: { recoveryArea: "active_publication" },
    } as const;
    for (let index = 0; index < 25; index += 1) {
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.record(recoveryIdentity);
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.resolve(recoveryIdentity);
    }
    const active = access.workerIncidents.record({
      workerKind: "encode",
      reasonCode: "poll_failure",
      phase: "polling",
      retryability: "automatic",
      schemaVersion: 1,
      evidence: {},
    });

    const snapshot = readDashboardSnapshot(access, { activityLimit: 20 });

    expect(snapshot.workerIncidents.status).toBe("loaded");
    if (snapshot.workerIncidents.status !== "loaded") {
      throw new Error("Expected Worker Incidents to load");
    }
    expect(snapshot.workerIncidents.items).toHaveLength(21);
    expect(snapshot.workerIncidents.items[0]).toMatchObject({
      id: active.id,
      status: "active",
    });
    expect(
      snapshot.workerIncidents.items.slice(1)
        .every(({ status }) => status === "recovered"),
    ).toBe(true);
  });
});
