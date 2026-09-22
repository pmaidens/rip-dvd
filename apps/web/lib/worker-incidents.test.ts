import { afterEach, describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../test/data-access-fixture";
import { readDashboardSnapshot } from "./dashboard";

const dataAccessFixture = useDataAccessFixture();

afterEach(() => {
  vi.useRealTimers();
});

describe("Worker Incidents on the dashboard", () => {
  it("describes active and recovered Filesystem Verification claim recovery", () => {
    const access = dataAccessFixture.create();
    const identity = {
      workerKind: "archive",
      reasonCode: "claim_recovery_failure",
      phase: "claim_recovery",
      retryability: "automatic",
      schemaVersion: 1,
      evidence: { recoveryArea: "filesystem_verification" },
    } as const;
    access.workerIncidents.record(identity);

    const active = readDashboardSnapshot(access).workerIncidents;
    expect(active).toMatchObject({
      status: "loaded",
      items: [{
        status: "active",
        investigation: {
          explanation:
            "The Archive Worker could not finish Filesystem Verification Run claim recovery.",
          suggestedAction:
            "Check the Archive Worker stdout and database health. The worker will retry Filesystem Verification Run claim recovery automatically.",
        },
      }],
    });

    access.workerIncidents.resolve(identity);
    const recovered = readDashboardSnapshot(access).workerIncidents;
    expect(recovered).toMatchObject({
      status: "loaded",
      items: [{
        status: "recovered",
        investigation: {
          suggestedAction:
            "No action is needed. The Archive Worker completed a later Filesystem Verification Run claim-recovery pass.",
        },
      }],
    });
  });

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
    const activePoll = access.workerIncidents.record({
      workerKind: "encode",
      reasonCode: "poll_failure",
      phase: "polling",
      retryability: "automatic",
      schemaVersion: 1,
      evidence: {},
    });
    vi.setSystemTime(Date.now() + 1_000);
    const activeRecovery = access.workerIncidents.record({
      workerKind: "archive",
      reasonCode: "claim_recovery_failure",
      phase: "claim_recovery",
      retryability: "automatic",
      schemaVersion: 1,
      evidence: { recoveryArea: "expired_archive_job_claim" },
    });

    const snapshot = readDashboardSnapshot(access, { activityLimit: 20 });

    expect(snapshot.workerIncidents.status).toBe("loaded");
    if (snapshot.workerIncidents.status !== "loaded") {
      throw new Error("Expected Worker Incidents to load");
    }
    expect(snapshot.workerIncidents.items).toHaveLength(22);
    expect(snapshot.workerIncidents.items[0]).toMatchObject({
      id: activeRecovery.id,
      worker: "Archive Worker",
      status: "active",
      investigation: {
        worker: "Archive Worker",
        failedPhase: "Claim recovery",
        technicalEvidence: expect.arrayContaining([
          {
            label: "Recovery area",
            value: "Expired Archive Job claim",
          },
        ]),
      },
    });
    expect(snapshot.workerIncidents.items[1]).toMatchObject({
      id: activePoll.id,
      worker: "Encode Worker",
      status: "active",
    });
    expect(
      snapshot.workerIncidents.items.slice(2)
        .every(({ status }) => status === "recovered"),
    ).toBe(true);
  });
});
