import type { ArchiveArtifact } from "@rip-dvd/application";
import { expect, it, vi } from "vitest";

import {
  requestArchiveArtifact,
  requestArchiveArtifactAction,
} from "./archive-artifact-client";

it("reads the shared Archive Artifact projection and dispatches its advertised actions", async () => {
  const artifact = {
    recovery: { record: { id: "recovery-1" } },
    actions: [
      {
        name: "stop",
        available: true,
        expectedInputs: {
          archiveRecoveryId: "recovery-1",
          attemptId: "attempt-1",
        },
      },
      {
        name: "resume",
        available: true,
        expectedInputs: {
          archiveRecoveryId: "recovery-1",
          attemptId: "attempt-1",
          checkpointRevision: 2,
          checkpointDigest: "digest-2",
          speedModes: ["normal", "low"],
        },
      },
      {
        name: "verify-disc",
        available: true,
        expectedInputs: { discInspectionId: "inspection-1" },
      },
      {
        name: "confirm-disc",
        available: true,
        expectedInputs: {
          verificationId: "verification-1",
          acknowledgeMixedSource: true,
        },
      },
      {
        name: "reconcile",
        available: true,
        expectedInputs: { archiveRecoveryId: "recovery-1" },
      },
    ],
  } as unknown as ArchiveArtifact;
  const inspectionFetcher = vi.fn(async () => Response.json({
    item: { archiveArtifact: artifact },
  }));
  await expect(requestArchiveArtifact("archive-1", inspectionFetcher))
    .resolves.toEqual(artifact);
  expect(inspectionFetcher).toHaveBeenCalledWith(
    "/api/operations?kind=original-disc-archives&id=archive-1",
    { cache: "no-store" },
  );

  const actionFetcher = vi.fn(async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => new Response(null, { status: 200 }));
  for (const [name, suffix] of [
    ["stop", "stop"],
    ["resume", "resume"],
    ["verify-disc", "verification"],
    ["confirm-disc", "confirmation"],
    ["reconcile", "reconciliation"],
  ] as const) {
    await requestArchiveArtifactAction(
      artifact,
      name,
      name === "resume" ? { speedMode: "low" } : {},
      actionFetcher,
      `key-${name}`,
    );
    expect(actionFetcher).toHaveBeenLastCalledWith(
      `/api/archive-recoveries/recovery-1/${suffix}`,
      expect.objectContaining({ method: "POST" }),
    );
  }
  expect(JSON.parse(actionFetcher.mock.calls[1]![1]!.body as string))
    .toEqual({
      mutationKey: "key-resume",
      archiveRecoveryId: "recovery-1",
      attemptId: "attempt-1",
      checkpointRevision: 2,
      checkpointDigest: "digest-2",
      speedMode: "low",
    });
  expect(JSON.parse(actionFetcher.mock.calls[3]![1]!.body as string))
    .toEqual({
      mutationKey: "key-confirm-disc",
      verificationId: "verification-1",
      acknowledgeMixedSource: true,
    });
});
