import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDataAccess,
  DomainInvariantError,
  type RecordWorkerIncidentInput,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createAccess() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-worker-incident-"));
  temporaryDirectories.push(directory);
  return createDataAccess({ databasePath: join(directory, "test.sqlite") });
}

const pollFailure = {
  schemaVersion: 1,
  workerKind: "encode",
  reasonCode: "poll_failure",
  phase: "polling",
  retryability: "automatic",
  evidence: {},
} satisfies RecordWorkerIncidentInput;

const archiveRecoveryFailure = {
  schemaVersion: 1,
  workerKind: "archive",
  reasonCode: "claim_recovery_failure",
  phase: "claim_recovery",
  retryability: "automatic",
  evidence: { recoveryArea: "expired_archive_job_claim" },
} satisfies RecordWorkerIncidentInput;

describe("Worker Incident data access", () => {
  it("coalesces repeated active incidents and retains resolved history", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T12:00:00.000Z");
    const access = createAccess();

    const first = access.workerIncidents.record(pollFailure);
    vi.setSystemTime("2026-09-01T12:01:00.000Z");
    const repeated = access.workerIncidents.record(pollFailure);

    expect(repeated).toMatchObject({
      id: first.id,
      schemaVersion: 1,
      workerKind: "encode",
      reasonCode: "poll_failure",
      phase: "polling",
      retryability: "automatic",
      evidence: {},
      firstObservedAt: new Date("2026-09-01T12:00:00.000Z"),
      lastObservedAt: new Date("2026-09-01T12:01:00.000Z"),
      occurrenceCount: 2,
      resolvedAt: null,
    });

    vi.setSystemTime("2026-09-01T12:02:00.000Z");
    expect(access.workerIncidents.resolve(pollFailure)).toEqual([
      expect.objectContaining({
        id: first.id,
        occurrenceCount: 2,
        resolvedAt: new Date("2026-09-01T12:02:00.000Z"),
      }),
    ]);
    expect(access.workerIncidents.resolve(pollFailure)).toEqual([]);

    vi.setSystemTime("2026-09-01T12:03:00.000Z");
    const later = access.workerIncidents.record(pollFailure);
    expect(later.id).not.toBe(first.id);
    expect(access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })).toEqual([
      expect.objectContaining({ id: later.id, resolvedAt: null }),
      expect.objectContaining({
        id: first.id,
        resolvedAt: new Date("2026-09-01T12:02:00.000Z"),
      }),
    ]);
    access.close();
  });

  it("keeps at most 100 per worker and never prunes the active incident", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T00:00:00.000Z");
    const access = createAccess();
    const active = access.workerIncidents.record(pollFailure);
    const recoveryFailure = {
      schemaVersion: 1,
      workerKind: "encode",
      reasonCode: "publication_recovery_failure",
      phase: "publication_recovery",
      retryability: "automatic",
      evidence: { recoveryArea: "pending_partial_cleanup" },
    } satisfies RecordWorkerIncidentInput;

    for (let index = 0; index < 105; index += 1) {
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.record(recoveryFailure);
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.resolve(recoveryFailure);
    }

    const retained = access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 100,
    });
    expect(retained).toHaveLength(100);
    expect(retained[0]).toMatchObject({ id: active.id, resolvedAt: null });
    expect(retained.filter(({ resolvedAt }) => resolvedAt !== null))
      .toHaveLength(99);
    access.close();
  });

  it("coalesces and bounds Archive Worker recovery history independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-01T00:00:00.000Z");
    const access = createAccess();
    const active = access.workerIncidents.record({
      ...pollFailure,
      workerKind: "archive",
    });

    for (let index = 0; index < 105; index += 1) {
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.record(archiveRecoveryFailure);
      vi.setSystemTime(Date.now() + 1_000);
      access.workerIncidents.resolve(archiveRecoveryFailure);
    }

    const retained = access.workerIncidents.list({
      workerKind: "archive",
      resolvedLimit: 100,
    });
    expect(retained).toHaveLength(100);
    expect(retained[0]).toMatchObject({ id: active.id, resolvedAt: null });
    expect(retained.filter(({ resolvedAt }) => resolvedAt !== null))
      .toHaveLength(99);
    access.close();
  });

  it("rejects unversioned, inconsistent, and non-allowlisted records", () => {
    const access = createAccess();

    for (const invalid of [
      { ...pollFailure, schemaVersion: 2 },
      { ...pollFailure, reasonCode: "raw_error" },
      { ...pollFailure, phase: "publication_recovery" },
      { ...pollFailure, evidence: { path: "/private/movie.iso" } },
      {
        ...pollFailure,
        evidence: { recoveryArea: "pending_partial_cleanup" },
      },
      {
        ...archiveRecoveryFailure,
        evidence: { recoveryArea: "active_publication" },
      },
      {
        ...archiveRecoveryFailure,
        workerKind: "encode",
      },
      {
        ...archiveRecoveryFailure,
        workerKind: "encode",
        reasonCode: "publication_recovery_failure",
        phase: "publication_recovery",
      },
    ]) {
      expect(() =>
        access.workerIncidents.record(
          invalid as unknown as RecordWorkerIncidentInput,
        )
      ).toThrow(DomainInvariantError);
    }
    expect(access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 100,
    })).toEqual([]);
    access.close();
  });
});
