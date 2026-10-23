import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createApplicationOperations } from "@rip-dvd/application";

import { seedDvdDiscVerificationFixture } from "./dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function invokeInNewProcess(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  args: readonly string[],
) {
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      RIP_DVD_DATABASE_PATH: fixture.databasePath,
      RIP_DVD_MEDIA_LIBRARY_PATH: fixture.mediaLibraryPath,
      RIP_DVD_ORIGINALS_LIBRARY_PATH: fixture.originalsLibraryPath,
    },
  });
  return {
    exitCode: result.status,
    result: JSON.parse(result.stdout) as unknown,
  };
}

it("replays a lost Stop response after process restart and attempt rotation", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const mutationKey = "00000000-0000-4000-8000-000000000456";
  const args = [
    "archive-recovery",
    "stop",
    seeded.recoveryId,
    "--key",
    mutationKey,
    "--attempt-id",
    seeded.attemptId,
  ];
  const access = fixture.openAccess();
  const committed = createApplicationOperations(access).stopDvdRecovery({
    mutationKey,
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  access.close();
  const expected = JSON.parse(JSON.stringify(committed));

  expect(invokeInNewProcess(fixture, args)).toEqual({
    exitCode: 0,
    result: expected,
  });

  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`DELETE FROM archive_recovery_work
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  database.prepare(`UPDATE archive_recoveries SET
    attempt_id = ?, attempt_ordinal = 2, status = 'eligible',
    stop_operation_id = NULL, stop_requested_at = NULL, stopped_at = NULL,
    fault_code = NULL, updated_at = updated_at + 1
    WHERE id = ?`).run("synthetic-next-recovery-attempt", seeded.recoveryId);
  database.close();

  expect(invokeInNewProcess(fixture, args)).toEqual({
    exitCode: 0,
    result: expected,
  });
  expect(invokeInNewProcess(fixture, [
    ...args.slice(0, -1),
    "synthetic-next-recovery-attempt",
  ])).toMatchObject({
    exitCode: 2,
    result: { error: { code: "MUTATION_KEY_CONFLICT" } },
  });
  expect(invokeInNewProcess(fixture, [
    ...args.slice(0, 3),
    "--key",
    "00000000-0000-4000-8000-000000000457",
    "--attempt-id",
    seeded.attemptId,
  ])).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "STALE_RECOVERY_ATTEMPT",
        currentIdentities: {
          archiveRecoveryId: seeded.recoveryId,
          attemptId: "synthetic-next-recovery-attempt",
        },
      },
    },
  });
}, 20_000);
