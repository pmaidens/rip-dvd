import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ArchiveRecoveryId,
  CommittedDvdCheckpointEvidence,
} from "@rip-dvd/data-access";

import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
  withEvidenceGuardsDisabled,
} from "./archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

it("pages complete checkpoint-bound Archive Recovery source ranges", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await seedCommittedArchiveEvidence(fixture, [
    { startLba: 10, sectorCount: 2, classification: "skipped_untested" },
    { startLba: 20, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);

  const first = await fixture.run([
    "archive-recovery",
    "ranges",
    "synthetic-committed-recovery",
    "--limit",
    "1",
  ]);

  expect(first.exitCode).toBe(0);
  expect(first.result).toMatchObject({
    schemaVersion: 1,
    archiveRecoveryId: "synthetic-committed-recovery",
    available: true,
    checkpoint: { revision: 1 },
    progress: {
      acceptedExtentSectorCount: 1_024,
      skippedUntestedSectorCount: 3,
      individuallyFailedSectorCount: 0,
      recoveredSectorCount: 0,
      unresolvedSectorCount: 3,
    },
    ranges: [{
      startLba: 10,
      sectorCount: 2,
      classification: "skipped_untested",
    }],
    rangeOffset: 0,
    truncated: true,
    nextCursor: expect.any(String),
  });

  const cursor = (first.result as { nextCursor: string }).nextCursor;
  const second = await fixture.run([
    "archive-recovery",
    "ranges",
    "synthetic-committed-recovery",
    "--limit",
    "1",
    "--cursor",
    cursor,
  ]);
  expect(second.exitCode).toBe(0);
  expect(second.result).toMatchObject({
    checkpoint: { revision: 1 },
    ranges: [{
      startLba: 20,
      sectorCount: 1,
      classification: "skipped_untested",
    }],
    rangeOffset: 1,
    truncated: false,
    nextCursor: null,
  });
});

it("compacts recovered ranges and rejects a cursor after the checkpoint changes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [
    { startLba: 10, sectorCount: 3, classification: "skipped_untested" },
    { startLba: 20, sectorCount: 1, classification: "skipped_untested" },
    { startLba: 30, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  const initial = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
    "--limit", "1",
  ]);
  const initialCursor = (initial.result as { nextCursor: string }).nextCursor;

  const second = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 20,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  const stale = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
    "--cursor", initialCursor,
  ]);
  expect(stale.exitCode).toBe(0);
  expect(stale.result).toMatchObject({
    available: false,
    unavailableReason: "DVD_RECOVERY_RANGE_CURSOR_STALE",
    checkpoint: { revision: 2, manifestDigest: second.manifestDigest },
    ranges: null,
  });

  const third = advanceCommittedArchiveEvidence(fixture, second, {
    startLba: 10,
    outcome: "recovered",
    publishFilesystemCheckpoint: true,
  });
  const fourth = advanceCommittedArchiveEvidence(fixture, third, {
    startLba: 11,
    outcome: "recovered",
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, fourth, {
    startLba: 20,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  const current = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
    "--limit", "100",
  ]);

  expect(current.exitCode).toBe(0);
  expect(current.result).toMatchObject({
    available: true,
    checkpoint: { revision: 5 },
    progress: {
      acceptedExtentSectorCount: 1_024,
      skippedUntestedSectorCount: 2,
      individuallyFailedSectorCount: 1,
      recoveredSectorCount: 2,
      unresolvedSectorCount: 3,
    },
    history: {
      transitions: { totalCount: 3, truncated: false },
    },
    ranges: [
      { startLba: 10, sectorCount: 2, classification: "recovered" },
      { startLba: 12, sectorCount: 1, classification: "skipped_untested" },
      { startLba: 20, sectorCount: 1, classification: "individually_failed" },
      { startLba: 30, sectorCount: 1, classification: "skipped_untested" },
    ],
    rangeCount: 4,
    truncated: false,
    nextCursor: null,
  });
});

it("bounds transition history across repeated no-change rechecks", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 40,
    sectorCount: 1,
    classification: "skipped_untested",
  }], false, true);
  let manifest = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 40,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  for (let index = 0; index < 17; index += 1) {
    manifest = advanceCommittedArchiveEvidence(fixture, manifest, {
      startLba: 40,
      outcome: "failed",
      publishFilesystemCheckpoint: true,
    });
  }

  const ranges = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ]);
  expect(ranges.exitCode).toBe(0);
  expect(ranges.result).toMatchObject({
    available: true,
    checkpoint: { revision: 19 },
    history: {
      transitions: {
        items: [{
          checkpointRevision: 2,
          startLba: 40,
          fromClassification: "skipped_untested",
          toClassification: "individually_failed",
        }],
        totalCount: 1,
        truncated: false,
      },
    },
    ranges: [{
      startLba: 40,
      sectorCount: 1,
      classification: "individually_failed",
    }],
  });
});

it("classifies transitions from the preceding checkpoint range", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 50,
    sectorCount: 1,
    classification: "skipped_untested",
  }], false, true);
  const failed = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 50,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  const unchanged = advanceCommittedArchiveEvidence(fixture, failed, {
    startLba: 50,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, unchanged, {
    startLba: 50,
    outcome: "recovered",
    publishFilesystemCheckpoint: true,
  });

  const ranges = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ]);
  expect(ranges.exitCode).toBe(0);
  expect(ranges.result).toMatchObject({
    history: {
      transitions: {
        items: [
          {
            checkpointRevision: 2,
            startLba: 50,
            fromClassification: "skipped_untested",
            toClassification: "individually_failed",
          },
          {
            checkpointRevision: 4,
            startLba: 50,
            fromClassification: "individually_failed",
            toClassification: "recovered",
          },
        ],
        totalCount: 2,
        truncated: false,
      },
    },
  });
});

it("fails closed when bounded transition evidence is corrupted", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 60,
    sectorCount: 1,
    classification: "skipped_untested",
  }], false, true);
  const first = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 60,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  const second = advanceCommittedArchiveEvidence(fixture, first, {
    startLba: 60,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, second, {
    startLba: 60,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
    database.prepare(`
      UPDATE dvd_archive_recovery_reads
      SET evidence_digest = ?
      WHERE from_manifest_revision = 1
    `).run("0".repeat(64));
  });

  const access = fixture.openAccess();
  expect(() => access.catalog.readDvdArchiveRecoveryRangeEvidence(
    "synthetic-committed-recovery" as ArchiveRecoveryId,
    { rangeOffset: 0, rangeLimit: 20 },
  )).toThrow(/evidence digest/i);
  access.close();

  const ranges = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ]);
  expect(ranges.exitCode).toBe(0);
  expect(ranges.result).toMatchObject({
    available: false,
    unavailableReason: "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
    ranges: null,
  });
});

it("fails closed when the current no-change observation is corrupted", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 65,
    sectorCount: 1,
    classification: "skipped_untested",
  }], false, true);
  const first = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 65,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, first, {
    startLba: 65,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
    database.prepare(`
      UPDATE dvd_archive_recovery_reads
      SET evidence_digest = ?
      WHERE from_manifest_revision = 2
    `).run("0".repeat(64));
  });

  const access = fixture.openAccess();
  expect(() => access.catalog.readDvdArchiveRecoveryRangeEvidence(
    "synthetic-committed-recovery" as ArchiveRecoveryId,
    { rangeOffset: 0, rangeLimit: 20 },
  )).toThrow(/evidence digest/i);
  access.close();
});

it("fails closed when a bounded transition is detached from its source range", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 70,
    sectorCount: 2,
    classification: "skipped_untested",
  }], false, true);
  const first = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 70,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  const second = advanceCommittedArchiveEvidence(fixture, first, {
    startLba: 70,
    outcome: "recovered",
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, second, {
    startLba: 71,
    outcome: "failed",
    publishFilesystemCheckpoint: true,
  });
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
    database.prepare(`
      UPDATE dvd_archive_recovery_reads
      SET start_lba = 999
      WHERE from_manifest_revision = 2
    `).run();
  });

  const access = fixture.openAccess();
  expect(() => access.catalog.readDvdArchiveRecoveryRangeEvidence(
    "synthetic-committed-recovery" as ArchiveRecoveryId,
    { rangeOffset: 0, rangeLimit: 20 },
  )).toThrow(/transition|evidence digest/i);
  access.close();
});

it("validates the extra bounded row used to report truncated history", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 200,
    sectorCount: 17,
    classification: "skipped_untested",
  }], false, true);
  let manifest: CommittedDvdCheckpointEvidence = seeded.manifest;
  for (let index = 0; index < 17; index += 1) {
    manifest = advanceCommittedArchiveEvidence(fixture, manifest, {
      startLba: 200 + index,
      outcome: "failed",
      publishFilesystemCheckpoint: true,
    });
  }
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
    database.prepare(`
      UPDATE dvd_archive_evidence_manifests
      SET manifest_digest = ?
      WHERE revision = 2
    `).run("0".repeat(64));
  });

  const access = fixture.openAccess();
  expect(() => access.catalog.readDvdArchiveRecoveryRangeEvidence(
    "synthetic-committed-recovery" as ArchiveRecoveryId,
    { rangeOffset: 0, rangeLimit: 20 },
  )).toThrow(/digest/i);
  access.close();
});

it("reports qualified current-pass progress through inspect and wait", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(1_500));
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 100,
    sectorCount: 5,
    classification: "skipped_untested",
  }], false, true);
  const previousPass = advanceCommittedArchiveEvidence(
    fixture,
    seeded.manifest,
    {
      startLba: 100,
      outcome: "recovered",
      createdAtMs: 2_000,
      publishFilesystemCheckpoint: true,
    },
  );
  const second = advanceCommittedArchiveEvidence(fixture, previousPass, {
    startLba: 101,
    outcome: "recovered",
    createdAtMs: 1_100,
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, second, {
    startLba: 102,
    outcome: "recovered",
    createdAtMs: 1_300,
    publishFilesystemCheckpoint: true,
  });
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`
    INSERT INTO archive_recovery_work (
      archive_recovery_id, original_disc_archive_id, attempt_id, status,
      verification_id, claimed_by, claim_token, claimed_at, pass_number,
      pass_direction, pass_started_at, pass_started_manifest_revision,
      pass_initial_unrecovered_sector_count, pass_recovered_sector_count,
      pass_observation_count, pass_positive_interval_count,
      pass_minimum_interval_ms, pass_maximum_interval_ms,
      pass_last_observed_at,
      pass_cursor_lba, created_at, updated_at
    ) SELECT id, original_disc_archive_id, attempt_id, 'claimed', NULL,
      'synthetic-worker', 'synthetic-claim', 1000, 1, 'forward', 1000, 2, 4, 2,
      2, 2, 100, 200, 1300, 102, 1000, 1300
    FROM archive_recoveries
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'running', updated_at = 1300
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.close();

  const ranges = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ]);
  expect(ranges.result).toMatchObject({
    progress: {
      currentPass: {
        number: 1,
        direction: "forward",
        cursorLba: 102,
        elapsedMs: 500,
        observedSectorCount: 2,
        remainingSectorCount: 2,
        completionEstimate: {
          scope: "current_pass",
          minimumRemainingMs: 200,
          maximumRemainingMs: 400,
          observationCount: 2,
        },
      },
    },
  });
  const inspected = await fixture.run([
    "inspect", "archive-recoveries", "synthetic-committed-recovery",
  ]);
  expect(inspected.result).toMatchObject({
    item: {
      status: "running",
      progress: {
        recoveredSectorCount: 3,
        currentPass: { completionEstimate: { scope: "current_pass" } },
      },
    },
  });
  const waiting = await fixture.run([
    "wait", "archive-recoveries", "synthetic-committed-recovery",
    "--timeout-ms", "0",
  ]);
  expect(waiting.exitCode).toBe(3);
  expect(waiting.result).toMatchObject({
    outcome: "timeout",
    current: {
      status: "running",
      progress: { currentPass: { observedSectorCount: 2 } },
    },
  });

  const terminal = new DatabaseSync(fixture.databasePath);
  terminal.prepare(`
    UPDATE archive_recovery_work
    SET status = 'requested', claimed_by = NULL, claim_token = NULL,
        claimed_at = NULL, requested_at = 1500, updated_at = 1500
    WHERE archive_recovery_id = 'synthetic-committed-recovery'
  `).run();
  terminal.prepare(`
    UPDATE archive_recoveries
    SET status = 'paused', pause_reason = 'no_progress',
        pass_history = ?, updated_at = 1500
    WHERE id = 'synthetic-committed-recovery'
  `).run(JSON.stringify([{
    passNumber: 1,
    direction: "forward",
    initialUnrecoveredSectorCount: 4,
    recoveredSectorCount: 2,
    remainingSectorCount: 2,
    lastCursorLba: 103,
    startedAtMs: 1_000,
    completedAtMs: 1_500,
    elapsedMs: 500,
    outcome: "no_progress",
  }]));
  terminal.close();
  vi.setSystemTime(new Date(5_000));
  const settled = await fixture.run([
    "wait", "archive-recoveries", "synthetic-committed-recovery",
    "--timeout-ms", "0",
  ]);
  expect(settled.exitCode).toBe(0);
  expect(settled.result).toMatchObject({
    outcome: "settled",
    current: {
      status: "paused",
      progress: {
        currentPass: {
          elapsedMs: 500,
          completionEstimate: "unknown",
        },
      },
      history: {
        passes: { completedPassCount: 1, truncated: false },
      },
    },
  });
});

it("marks upgraded in-flight pass observations unavailable", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await seedCommittedArchiveEvidence(fixture, [{
    startLba: 120,
    sectorCount: 2,
    classification: "skipped_untested",
  }], false, true);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`
    INSERT INTO archive_recovery_work (
      archive_recovery_id, original_disc_archive_id, attempt_id, status,
      verification_id, claimed_by, claim_token, claimed_at, pass_number,
      pass_direction, pass_started_at, pass_started_manifest_revision,
      pass_initial_unrecovered_sector_count, pass_recovered_sector_count,
      pass_cursor_lba, created_at, updated_at
    ) SELECT id, original_disc_archive_id, attempt_id, 'claimed', NULL,
      'synthetic-worker', 'synthetic-claim', 1000, 1, 'forward', 1000, NULL,
      2, 0, NULL, 1000, 1000
    FROM archive_recoveries
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'running', updated_at = 1000
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.close();

  const ranges = await fixture.run([
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ]);
  expect(ranges.result).toMatchObject({
    progress: {
      currentPass: {
        observedSectorCount: null,
        remainingSectorCount: null,
        completionEstimate: "unknown",
      },
    },
  });
});
