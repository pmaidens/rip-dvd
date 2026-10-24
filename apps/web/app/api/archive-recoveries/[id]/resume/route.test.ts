import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  createDvdRecoveryEvidenceEncodingTestAccess,
} from "@rip-dvd/data-access/test-support";

import {
  createOperatorWorkflowFixture,
} from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import {
  seedDvdDiscVerificationFixture,
} from "../../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { createDvdRecoveryResumeRoute } from "./route.js";

const fixtures: Array<ReturnType<typeof createOperatorWorkflowFixture>> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function request(
  recoveryId: string,
  body: {
    mutationKey: string;
    attemptId: string;
    checkpointRevision: number;
    checkpointDigest: string;
    speedMode: "normal" | "low";
  },
) {
  return new Request(
    `http://localhost:3000/api/archive-recoveries/${recoveryId}/resume`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

function cliArgs(
  recoveryId: string,
  body: {
    mutationKey: string;
    attemptId: string;
    checkpointRevision: number;
    checkpointDigest: string;
    speedMode: "normal" | "low";
  },
) {
  return [
    "archive-recovery",
    "resume",
    recoveryId,
    "--key",
    body.mutationKey,
    "--attempt-id",
    body.attemptId,
    "--checkpoint-revision",
    String(body.checkpointRevision),
    "--checkpoint-digest",
    body.checkpointDigest,
    "--speed-mode",
    body.speedMode,
  ];
}

it("offers the same checkpoint-bound no-progress Resume through web and CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  const body = {
    mutationKey: "00000000-0000-4000-8000-000000000620",
    attemptId: seeded.attemptId,
    checkpointRevision: seeded.pointer.currentManifestRevision,
    checkpointDigest: seeded.pointer.currentManifestDigest,
    speedMode: "low" as const,
  };
  const access = fixture.openAccess();
  try {
    const web = await createDvdRecoveryResumeRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run(cliArgs(seeded.recoveryId, body));

    expect(web.status).toBe(202);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      archiveRecovery: {
        id: seeded.recoveryId,
        attemptOrdinal: 2,
        status: "eligible",
        pauseReason: null,
        speedMode: "low",
        speedRequestResult: null,
        work: { status: "requested" },
      },
      operation: {
        kind: "archive-recoveries",
        id: seeded.recoveryId,
        status: "eligible",
      },
    });
  } finally {
    access.close();
  }
});

it("returns current checkpoint identities without changing stale Resume state", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  const body = {
    mutationKey: "00000000-0000-4000-8000-000000000621",
    attemptId: seeded.attemptId,
    checkpointRevision: seeded.pointer.currentManifestRevision,
    checkpointDigest: "0".repeat(64),
    speedMode: "normal" as const,
  };
  const access = fixture.openAccess();
  try {
    const web = await createDvdRecoveryResumeRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run(cliArgs(seeded.recoveryId, body));
    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toEqual({
      error: {
        code: "STALE_RECOVERY_CHECKPOINT",
        message: "Archive Recovery checkpoint is stale.",
        currentIdentities: {
          archiveRecoveryId: seeded.recoveryId,
          checkpoint: {
            revision: seeded.pointer.currentManifestRevision,
            digest: seeded.pointer.currentManifestDigest,
          },
        },
      },
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "no_progress",
        attemptId: seeded.attemptId,
      });
  } finally {
    access.close();
  }
});

it("rejects Resume while Encode work owns the archive", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.prepare(`UPDATE original_disc_archives SET
    catalog_review_outcome = 'reviewed_with_selections',
    catalog_reviewed_at = 2, updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.archive.id);
  database.close();
  const preparation = createDvdRecoveryEvidenceEncodingTestAccess({
    databasePath: fixture.databasePath,
    mediaLibraryPath: fixture.mediaLibraryPath,
    originalsLibraryPath: fixture.originalsLibraryPath,
  });
  const selection = preparation.catalog.listDiscSelections({
    originalDiscArchiveId: seeded.archive.id,
  })[0]!;
  const profile = preparation.encodingProfiles.list({
    mediaDomain: "dvd_video",
    activeOnly: true,
  })[0]!;
  const queued = preparation.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: join(fixture.mediaLibraryPath, "resume-conflict.mkv"),
  });
  preparation.close();
  const body = {
    mutationKey: "00000000-0000-4000-8000-000000000622",
    attemptId: seeded.attemptId,
    checkpointRevision: seeded.pointer.currentManifestRevision,
    checkpointDigest: seeded.pointer.currentManifestDigest,
    speedMode: "normal" as const,
  };
  const access = fixture.openAccess();
  try {
    const web = await createDvdRecoveryResumeRoute(
      request(seeded.recoveryId, body),
      seeded.recoveryId,
      () => access,
      () => "http://localhost:3000",
    );
    const cli = await fixture.run(cliArgs(seeded.recoveryId, body));
    expect(web.status).toBe(409);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      error: {
        code: "ENCODE_WORK_CONFLICT",
        blockingReasons: [{ code: "ENCODE_WORK_CONFLICT" }],
        current: {
          archiveRecovery: { id: seeded.recoveryId, work: null },
          encodeJobs: [{ id: queued.id, status: "queued" }],
        },
      },
    });
    expect(access.encodeJobs.find(queued.id)).toMatchObject({
      status: "queued",
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "paused", attemptId: seeded.attemptId });
  } finally {
    access.close();
  }
});
