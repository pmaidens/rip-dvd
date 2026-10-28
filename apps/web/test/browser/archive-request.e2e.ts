import type {
  ArchiveArtifact,
  ArchiveArtifactAction,
} from "@rip-dvd/application";
import { expect, test } from "@playwright/test";

test("requests an archive on an ordinary HTTP origin", async ({ page }, testInfo) => {
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  await page.goto("/discs");
  // Assert the actual browser capability, not a mocked version of crypto.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

  const disc = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: `HTTP archive fixture ${variant}`, exact: true }),
  });
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/archive-requests") && response.request().method() === "POST",
  );
  await disc.getByRole("button", { name: "Request archive", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(disc.getByRole("region", { name: "Archive Request" })).toBeVisible();
  await expect(disc.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  await page.reload();
  await expect(disc.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
});

test("shows the saved archive and active recovery as one truthful artifact", async ({
  page,
}, testInfo) => {
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  const discLabel = `ARCHIVE_ARTIFACT_BROWSER_${variant.toUpperCase()}`;
  await page.goto("/discs");

  const artifact = page.getByRole("article", {
    name: `${discLabel} archive artifact`,
  });
  await expect(artifact).toBeVisible();
  const initial = artifact.getByRole("region", { name: "Initial preservation" });
  await expect(initial.getByText("Archive Request", { exact: true })).toBeVisible();
  await expect(initial.getByText("fulfilled", { exact: true })).toBeVisible();
  await expect(initial.getByText("Initial Archive Job", { exact: true })).toBeVisible();
  await expect(initial.getByText("completed", { exact: true })).toBeVisible();

  const recovery = artifact.getByRole("region", { name: "Archive Recovery" });
  await expect(recovery.getByText("Revision 1", { exact: false })).toBeVisible();
  await expect(recovery.getByText("Accepted extent", { exact: true })).toBeVisible();
  await expect(recovery.getByText("4096 sectors", { exact: true })).toBeVisible();
  await expect(recovery.getByText("Current pass estimate", { exact: true }))
    .toBeVisible();
  await expect(
    recovery.getByText("Current pass estimate", { exact: true })
      .locator("..").getByText("Unknown", { exact: true }),
  ).toBeVisible();
  await expect(recovery.getByText("1 sector", { exact: true })).toHaveCount(2);
  await expect(recovery.getByText("0 sectors", { exact: true })).toHaveCount(2);

  const readiness = artifact.getByRole("region", { name: "Archive readiness" });
  await expect(readiness.getByText("Not stable", { exact: true })).toBeVisible();
  await expect(readiness.getByText("Current", { exact: true })).toBeVisible();
  await expect(readiness.getByText("Not ready", { exact: true })).toBeVisible();

  const actions = artifact.locator(".archive-artifact-actions");
  await actions.getByText("Recovery actions", { exact: true }).click();
  const stop = actions.locator(".archive-artifact-action").filter({
    has: page.getByText("Stop", { exact: true }),
  });
  await expect(stop.getByText("Available", { exact: true })).toBeVisible();
  const resume = actions.locator(".archive-artifact-action").filter({
    has: page.getByText("Resume", { exact: true }),
  });
  await expect(resume.getByText("Unavailable", { exact: true })).toBeVisible();

  await actions.getByRole("button", {
    name: "Stop and keep archive",
    exact: true,
  }).click();
  await expect(artifact.locator(".status-stopping")).toHaveCount(2);
  await expect(initial.getByText("completed", { exact: true })).toBeVisible();
});

test("dispatches and refreshes every remaining archive recovery action", async ({
  page,
}, testInfo) => {
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  const discLabel = `ARCHIVE_ARTIFACT_BROWSER_${variant.toUpperCase()}`;
  await page.goto("/discs");
  const dashboard = await page.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error("Dashboard request failed");
    return await response.json();
  }) as {
    archiveJobs: {
      items: readonly {
        discLabel: string;
        originalDiscArchiveId?: string | null;
      }[];
    };
  };
  const originalDiscArchiveId = dashboard.archiveJobs.items.find((job) =>
    job.discLabel === discLabel
  )?.originalDiscArchiveId;
  expect(originalDiscArchiveId).toBeTruthy();
  const operationPath =
    `/api/operations?kind=original-disc-archives&id=${encodeURIComponent(originalDiscArchiveId!)}`;
  const operation = await page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Archive artifact request failed");
    return await response.json();
  }, operationPath) as {
    item: { archiveArtifact: ArchiveArtifact };
  };
  const baseArtifact = operation.item.archiveArtifact;
  const recoveryId = baseArtifact.recovery.record?.id;
  expect(recoveryId).toBeTruthy();

  let currentArtifact = baseArtifact;
  let actionResultArtifact = baseArtifact;
  let actionRequest: { path: string; body: Record<string, unknown> } | null = null;
  await page.route((url) => url.pathname + url.search === operationPath, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        item: { archiveArtifact: currentArtifact },
      }),
    });
  });
  await page.route((url) =>
    url.pathname.startsWith(`/api/archive-recoveries/${recoveryId!}/`) &&
    routeActionSuffixes.some((suffix) => url.pathname.endsWith(`/${suffix}`)),
  async (route) => {
    actionRequest = {
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON() as Record<string, unknown>,
    };
    currentArtifact = actionResultArtifact;
    await route.fulfill({ status: 200, body: "{}" });
  });

  const scenarios: readonly {
    action: ArchiveArtifactAction["name"];
    actionLabel: string;
    buttonLabel: string;
    routeSuffix: string;
    requiredInputs: readonly string[];
    expectedInputs: Readonly<Record<string, unknown>>;
    result(artifact: ArchiveArtifact): ArchiveArtifact;
    assertResult(artifact: ReturnType<typeof page.getByRole>): Promise<void>;
  }[] = [
    {
      action: "resume",
      actionLabel: "Resume",
      buttonLabel: "Resume at normal speed",
      routeSuffix: "resume",
      requiredInputs: [
        "mutationKey",
        "archiveRecoveryId",
        "attemptId",
        "checkpointRevision",
        "checkpointDigest",
        "speedMode",
      ],
      expectedInputs: {
        archiveRecoveryId: recoveryId!,
        attemptId: baseArtifact.recovery.record!.attemptId,
        checkpointRevision: baseArtifact.recovery.checkpoint!.revision,
        checkpointDigest: baseArtifact.recovery.checkpoint!.manifestDigest,
        speedModes: ["normal", "low"],
      },
      result: (artifact) => ({
        ...artifact,
        recovery: {
          ...artifact.recovery,
          state: "waiting",
          record: {
            ...artifact.recovery.record!,
            status: "waiting_for_disc",
          },
        },
      }),
      assertResult: async (artifact) => {
        await expect(artifact.locator(".status-waiting")).toHaveCount(2);
      },
    },
    {
      action: "verify-disc",
      actionLabel: "DVD Disc Verification",
      buttonLabel: "Run DVD Disc Verification",
      routeSuffix: "verification",
      requiredInputs: [
        "mutationKey",
        "archiveRecoveryId",
        "discInspectionId",
        "checkpointRevision",
        "checkpointDigest",
      ],
      expectedInputs: {
        archiveRecoveryId: recoveryId!,
        discInspectionId: "browser-inspection",
        checkpointRevision: baseArtifact.recovery.checkpoint!.revision,
        checkpointDigest: baseArtifact.recovery.checkpoint!.manifestDigest,
      },
      result: (artifact) => ({
        ...artifact,
        sourceIdentity: {
          ...artifact.sourceIdentity,
          currentInsertion: {
            discInspectionId: "browser-current-inspection",
            detectedDiscId: "browser-current-disc",
            mediaGeneration: "browser-current-generation",
          },
          verification: {
            id: "browser-verification",
            discInspectionId: "browser-inspection",
            detectedDiscId: "browser-detected-disc",
            mediaGeneration: "browser-media-generation",
            status: "queued",
            outcome: null,
            current: false,
            reasons: [],
          },
        },
      }),
      assertResult: async (artifact) => {
        const recovery = artifact.getByRole("region", { name: "Archive Recovery" });
        await expect(recovery.getByText("queued · Stale · browser-verification", {
          exact: false,
        })).toBeVisible();
        await expect(recovery.getByText("browser-current-inspection", {
          exact: true,
        })).toBeVisible();
        await expect(recovery.getByText("browser-current-disc", { exact: true }))
          .toBeVisible();
        await expect(recovery.getByText("browser-inspection", { exact: true }))
          .toHaveCount(0);
      },
    },
    {
      action: "confirm-disc",
      actionLabel: "Operator Disc Confirmation",
      buttonLabel: "Record Operator Disc Confirmation",
      routeSuffix: "confirmation",
      requiredInputs: [
        "mutationKey",
        "archiveRecoveryId",
        "verificationId",
        "acknowledgeMixedSource",
      ],
      expectedInputs: {
        archiveRecoveryId: recoveryId!,
        verificationId: "browser-verification",
        acknowledgeMixedSource: true,
      },
      result: (artifact) => ({
        ...artifact,
        sourceIdentity: {
          ...artifact.sourceIdentity,
          confirmation: {
            id: "browser-confirmation",
            current: true,
            verificationOutcome: "mismatch",
            expiredAt: null,
            expiryReason: null,
          },
        },
      }),
      assertResult: async (artifact) => {
        await expect(artifact.getByText(
          "Current · mismatch · browser-confirmation",
          { exact: false },
        )).toBeVisible();
      },
    },
    {
      action: "reconcile",
      actionLabel: "Reconcile",
      buttonLabel: "Reconcile checkpoint",
      routeSuffix: "reconciliation",
      requiredInputs: ["mutationKey", "archiveRecoveryId"],
      expectedInputs: { archiveRecoveryId: recoveryId! },
      result: (artifact) => ({
        ...artifact,
        recovery: {
          ...artifact.recovery,
          reconciliation: {
            id: "browser-reconciliation",
            status: "queued",
            phase: "requested",
            outcome: null,
            failureCode: null,
          },
        },
      }),
      assertResult: async (artifact) => {
        await expect(artifact.getByText(
          "queued · browser-reconciliation",
          { exact: false },
        )).toBeVisible();
      },
    },
  ];

  for (const scenario of scenarios) {
    const blockedArtifact = withAction(baseArtifact, scenario.action, {
      available: false,
      blockingReasons: [{
        code: "SYNTHETIC_ACTION_BLOCKED",
        message: `Synthetic ${scenario.actionLabel} blocker.`,
      }],
      requiredInputs: scenario.requiredInputs,
      expectedInputs: null,
    });
    currentArtifact = blockedArtifact;
    await page.goto("/discs");
    const artifact = page.getByRole("article", {
      name: `${discLabel} archive artifact`,
    });
    const actions = artifact.locator(".archive-artifact-actions");
    await actions.getByText("Recovery actions", { exact: true }).click();
    const action = actions.locator(".archive-artifact-action").filter({
      has: page.getByText(scenario.actionLabel, { exact: true }),
    });
    await expect(action.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(action).toContainText("SYNTHETIC_ACTION_BLOCKED");
    await expect(action).toContainText(
      `Expected inputs: ${scenario.requiredInputs.join(", ")}`,
    );

    const availableArtifact = withAction(baseArtifact, scenario.action, {
      available: true,
      blockingReasons: [],
      requiredInputs: scenario.requiredInputs,
      expectedInputs: scenario.expectedInputs,
    });
    currentArtifact = availableArtifact;
    actionResultArtifact = scenario.result(availableArtifact);
    actionRequest = null;
    await page.reload();
    const refreshedArtifact = page.getByRole("article", {
      name: `${discLabel} archive artifact`,
    });
    const refreshedActions = refreshedArtifact.locator(".archive-artifact-actions");
    await refreshedActions.getByText("Recovery actions", { exact: true }).click();
    const availableAction = refreshedActions.locator(".archive-artifact-action")
      .filter({ has: page.getByText(scenario.actionLabel, { exact: true }) });
    await expect(availableAction.getByText("Available", { exact: true }))
      .toBeVisible();
    await expect(availableAction.locator(".archive-artifact-expected-inputs"))
      .toHaveText(JSON.stringify(scenario.expectedInputs));
    if (scenario.action === "confirm-disc") {
      page.once("dialog", async (dialog) => await dialog.accept());
    }
    await refreshedActions.getByRole("button", {
      name: scenario.buttonLabel,
      exact: true,
    }).click();
    await scenario.assertResult(refreshedArtifact);
    expect(actionRequest).not.toBeNull();
    expect(actionRequest!.path).toBe(
      `/api/archive-recoveries/${recoveryId!}/${scenario.routeSuffix}`,
    );
    expect(actionRequest!.body).toEqual({
      mutationKey: expect.any(String),
      ...Object.fromEntries(
        Object.entries(scenario.expectedInputs).filter(([key]) =>
          key !== "speedModes"
        ),
      ),
      ...(scenario.action === "resume" ? { speedMode: "normal" } : {}),
    });
  }

  const completedArtifact = structuredClone(baseArtifact);
  completedArtifact.recovery.state = "completed";
  completedArtifact.recovery.record = {
    ...completedArtifact.recovery.record!,
    status: "completed",
  };
  completedArtifact.readiness.titleAssessment = {
    ready: false,
    state: "pending",
    assessmentIdentity: null,
    reasons: [{
      code: "TITLE_ASSESSMENT_PENDING",
      message: "Synthetic Title Damage assessment is pending.",
    }],
  };
  currentArtifact = completedArtifact;
  await page.goto("/discs");
  const completedCard = page.getByRole("article", {
    name: `${discLabel} archive artifact`,
  });
  const readiness = completedCard.getByRole("region", {
    name: "Archive readiness",
  });
  await expect(readiness.getByText("Pending", { exact: true })).toBeVisible();
  currentArtifact = {
    ...completedArtifact,
    readiness: {
      ...completedArtifact.readiness,
      titleAssessment: {
        ready: true,
        state: "current",
        assessmentIdentity: "browser-title-assessment",
        reasons: [],
      },
    },
  };
  await expect(readiness.getByText("Current", { exact: true })).toBeVisible({
    timeout: 7_000,
  });
});

const routeActionSuffixes = [
  "resume",
  "verification",
  "confirmation",
  "reconciliation",
] as const;

function withAction(
  artifact: ArchiveArtifact,
  name: ArchiveArtifactAction["name"],
  replacement: Omit<ArchiveArtifactAction, "name">,
): ArchiveArtifact {
  return {
    ...structuredClone(artifact),
    actions: artifact.actions.map((action) =>
      action.name === name ? { name, ...replacement } : action
    ),
  };
}
