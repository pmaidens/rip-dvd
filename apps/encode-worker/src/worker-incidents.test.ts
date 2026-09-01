import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pollEncodeWorker, runEncodeWorker } from "./encode-worker.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-encode-incidents-"));
  temporaryDirectories.push(directory);
  return {
    access: createDataAccess({
      databasePath: join(directory, "test.sqlite"),
    }),
    mediaLibraryPath: join(directory, "media"),
    originalsLibraryPath: join(directory, "originals"),
  };
}

describe("Encode Worker Incidents", () => {
  it("coalesces polling failures and resolves them after a successful poll", async () => {
    const fixture = createFixture();
    const log = vi.fn();
    const claimNext = vi.spyOn(fixture.access.encodeJobs, "claimNext")
      .mockImplementation(() => {
        throw new Error("poll database unavailable");
      });
    const failedController = new AbortController();
    let waits = 0;

    await runEncodeWorker({
      ...fixture,
      concurrency: 1,
      log,
      pollIntervalMs: 1,
      signal: failedController.signal,
      waitForNextPoll: async () => {
        waits += 1;
        if (waits === 2) {
          failedController.abort();
        }
      },
    });

    expect(log).toHaveBeenCalledWith(
      "Encode worker poll failed: poll database unavailable",
    );
    expect(fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })).toEqual([
      expect.objectContaining({
        reasonCode: "poll_failure",
        phase: "polling",
        occurrenceCount: 2,
        resolvedAt: null,
      }),
    ]);

    claimNext.mockReturnValue(null);
    const recoveredController = new AbortController();
    await runEncodeWorker({
      ...fixture,
      concurrency: 1,
      log,
      pollIntervalMs: 1,
      signal: recoveredController.signal,
      waitForNextPoll: async () => recoveredController.abort(),
    });

    expect(fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })).toEqual([
      expect.objectContaining({
        reasonCode: "poll_failure",
        occurrenceCount: 2,
        resolvedAt: expect.any(Date),
      }),
    ]);
    fixture.access.close();
  });

  it("records and resolves publication-recovery failures without persisting diagnostics", async () => {
    const fixture = createFixture();
    const log = vi.fn();
    const list = vi.spyOn(
      fixture.access.encodeJobs,
      "listPublicationMutations",
    ).mockImplementation(() => {
      throw new Error(
        "/private/output.mkv --secret ENV=hidden claim=private-token",
      );
    });
    const options = {
      ...fixture,
      concurrency: 1,
      log,
      signal: new AbortController().signal,
    };

    await expect(pollEncodeWorker(options)).rejects.toThrow(
      "/private/output.mkv --secret ENV=hidden claim=private-token",
    );

    const active = fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    });
    expect(active).toEqual([
      expect.objectContaining({
        reasonCode: "publication_recovery_failure",
        phase: "publication_recovery",
        evidence: { recoveryArea: "active_publication" },
        resolvedAt: null,
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("/private/output.mkv --secret"),
    );
    expect(JSON.stringify(active)).not.toContain("/private/output.mkv");
    expect(JSON.stringify(active)).not.toContain("private-token");

    list.mockReturnValue([]);
    await pollEncodeWorker(options);

    expect(fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })[0]).toMatchObject({
      evidence: { recoveryArea: "active_publication" },
      resolvedAt: expect.any(Date),
    });
    fixture.access.close();
  });

  it("does not resolve a recovery incident while output ownership is deferred", async () => {
    const fixture = createFixture();
    mkdirSync(fixture.mediaLibraryPath, { recursive: true });
    const identity = {
      workerKind: "encode",
      reasonCode: "publication_recovery_failure",
      phase: "publication_recovery",
      evidence: { recoveryArea: "pending_partial_cleanup" },
    } as const;
    const incident = fixture.access.workerIncidents.record({
      ...identity,
      schemaVersion: 1,
      retryability: "automatic",
    });
    const pending = vi.spyOn(
      fixture.access.encodeJobs,
      "listPendingPartialCleanups",
    ).mockReturnValue([{
      jobId: "deferred-job",
      outputPath: join(fixture.mediaLibraryPath, "deferred.mkv"),
      claimToken: "deferred-claim",
      leaseToken: null,
      publicationPending: true,
    } as never]);
    const mutationLock = {
      tryAcquire: vi.fn(() => null),
      release: vi.fn(),
    };
    const options = {
      ...fixture,
      concurrency: 1,
      log: vi.fn(),
      mutationLock,
      signal: new AbortController().signal,
    };

    await pollEncodeWorker(options);

    expect(mutationLock.tryAcquire).toHaveBeenCalledOnce();
    expect(fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })[0]).toMatchObject({ id: incident.id, resolvedAt: null });

    pending.mockReturnValue([]);
    await pollEncodeWorker(options);
    expect(fixture.access.workerIncidents.list({
      workerKind: "encode",
      resolvedLimit: 20,
    })[0]).toMatchObject({
      id: incident.id,
      resolvedAt: expect.any(Date),
    });
    fixture.access.close();
  });

  it("keeps the original failure and incident persistence failure in stdout", async () => {
    const fixture = createFixture();
    const log = vi.fn();
    vi.spyOn(fixture.access.encodeJobs, "claimNext").mockImplementation(() => {
      throw new Error("original poll failure");
    });
    vi.spyOn(fixture.access.workerIncidents, "record").mockImplementation(() => {
      throw new Error("incident database failure");
    });
    const controller = new AbortController();

    await runEncodeWorker({
      ...fixture,
      concurrency: 1,
      log,
      pollIntervalMs: 1,
      signal: controller.signal,
      waitForNextPoll: async () => controller.abort(),
    });

    expect(log.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        "Encode worker poll failed: original poll failure",
        "Encode Worker Incident could not be persisted: incident database failure",
      ]),
    );
    fixture.access.close();
  });
});
