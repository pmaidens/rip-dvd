/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { expect, test } from "@playwright/test";
import { clickNotification, completeControlledRecoveryStop, controlledSubscription, deliverPush, dispatchQueuedPushes, recoveryNotificationPayload } from "./notification-test-support";

test("explains missing server setup and visibly disables opt-in", async ({ page }) => {
  await controlledSubscription(page);
  await page.route("**/api/notifications?action=status", (route) => route.fulfill({ json: {
    configured: false, reason: "missing_configuration", publicKey: null, dispatcherAvailable: false,
  } }));
  await page.route("**/api/notifications?action=deliveries&limit=25", (route) => route.fulfill({ json: { deliveries: [] } }));
  await page.goto("/settings#notifications");
  await expect(page.getByText("Push configuration is missing.", { exact: false })).toBeVisible();
  const button = page.getByRole("button", { name: "Enable notifications", exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveCSS("opacity", "0.5");
  await expect(page.getByRole("status")).toHaveText("Notifications cannot be enabled until server setup is complete.");
  await page.getByRole("button", { name: "Check notification status" }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications cannot be enabled until server setup is complete.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
});

test("redirects the legacy page to Notifications in Settings without prompting", async ({ page }) => {
  await controlledSubscription(page);
  const response = await page.request.get("/notifications", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/settings#notifications");
  await page.goto("/notifications");
  await expect(page).toHaveURL("/settings#notifications");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
});

test("installs metadata and opts in, displays the queued test, navigates, and opts out without reopening permission", async ({ page, context }) => {
  await context.grantPermissions(["notifications"], { origin: "http://localhost:3101" });
  await controlledSubscription(page);
  await page.goto("/settings#notifications");
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
  await expect(page.getByText("On iPhone, open this app in Safari", { exact: false })).toBeVisible();
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ id: "/", display: "standalone", start_url: "/" });
  expect((await page.request.get("/app-icon/192")).headers()["content-type"]).toContain("image/png");
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications enabled on this browser.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
  const subscriptionId = await page.evaluate(() => localStorage.getItem("rip-dvd.notifications.subscription"));
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(page.getByRole("status")).toContainText("Queued for delivery");
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(await worker.evaluate(() => Notification.permission)).toBe("granted");
  dispatchQueuedPushes({ throttle: true });
  await page.getByRole("button", { name: "Check notification status" }).click();
  await expect(page.getByRole("status")).toContainText("Retrying delivery after a temporary failure");
  await expect(page.getByRole("list", { name: "Recent notification deliveries" })).toContainText("Reason: throttled");
  const sent = dispatchQueuedPushes({ advanceMs: 60_000 });
  await page.getByRole("button", { name: "Check notification status" }).click();
  await expect(page.getByRole("status")).toHaveText("Accepted by the push service. Device display is not confirmed.");
  await expect(page.getByRole("list", { name: "Recent notification deliveries" })).toContainText("Attempts: 2");
  expect(sent.length).toBeGreaterThan(0);
  for (const payload of sent) {
    await deliverPush(worker, JSON.stringify(payload));
  }
  await expect.poll(async () => worker.evaluate(async () => (await self.registration.getNotifications()).map((notification) => notification.title))).toContain("Rip DVD test");
  await page.goto("/catalog");
  await worker.evaluate(async () => {
    const notification = (await self.registration.getNotifications()).find((item) => item.title === "Rip DVD test")!;
    const click = new NotificationEvent("notificationclick", { notification });
    const lifetime: Promise<unknown>[] = [];
    click.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(click);
    await Promise.allSettled(lifetime);
  });
  await expect(page).toHaveURL(/\/settings#notifications$/);
  await expect(page.getByRole("button", { name: "Disable notifications", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("rip-dvd.notifications.subscription"))).toBe(subscriptionId);
  await page.getByRole("button", { name: "Disable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  await page.goto("/notifications");
  await expect(page).toHaveURL("/settings#notifications");
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Notifications" }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
});

test("handles malformed push data, missing labels and unsafe click destinations", async ({ page, context }) => {
  await context.grantPermissions(["notifications"], { origin: "http://localhost:3101" });
  await controlledSubscription(page);
  await page.goto("/settings#notifications");
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(await worker.evaluate(() => Notification.permission)).toBe("granted");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await deliverPush(worker, "not-json");
  await expect.poll(async () => worker.evaluate(async () => (await self.registration.getNotifications()).map((notification) => notification.title))).toContain("Unlabelled disc");
  await worker.evaluate(async () => {
    await self.registration.showNotification("Synthetic unsafe destination", { data: { destination: "https://outside.example/" } });
    const notification = (await self.registration.getNotifications()).find((item) => item.title === "Synthetic unsafe destination")!;
    const click = new NotificationEvent("notificationclick", { notification });
    const lifetime: Promise<unknown>[] = [];
    click.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(click);
    await Promise.allSettled(lifetime);
  });
  await expect(page).toHaveURL(/localhost:3101\/settings#notifications$/);
  expect(context.pages()).toHaveLength(1);
  await deliverPush(worker, JSON.stringify({ version: 1, body: "Synthetic outcome", tag: "synthetic-missing-label",
    destination: "/notifications/target?kind=archive-jobs&id=synthetic-missing" }));
  await expect.poll(async () => worker.evaluate(async () => (await self.registration.getNotifications()).map((notification) => notification.title))).toContain("Unlabelled disc");
  const clickResult = await worker.evaluate(async () => {
    const notification = (await self.registration.getNotifications()).find((item) => item.tag === "synthetic-missing-label")!;
    const target = notification.data;
    const click = new NotificationEvent("notificationclick", { notification });
    const lifetime: Promise<unknown>[] = [];
    click.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(click);
    const results = await Promise.allSettled(lifetime);
    return { target, results: results.map((result) => result.status === "fulfilled" ? "navigated" : String(result.reason)),
      windows: (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map(({ url }) => url) };
  });
  expect(clickResult).toEqual({ target: { destination: "http://localhost:3101/notifications/target?kind=archive-jobs&id=synthetic-missing" }, results: ["navigated"], windows: ["http://localhost:3101/notifications/target?kind=archive-jobs&id=synthetic-missing"] });
  await expect(page).toHaveURL(/\/notifications\/target\?kind=archive-jobs&id=synthetic-missing$/);
  await expect(page.getByText("This notification target is no longer available.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Notification settings", exact: true })).toHaveAttribute("href", "/settings#notifications");
});

test("opens a labeled Archive Job target using its current shared operation detail", async ({ page }) => {
  const response = await page.request.get("/api/operations?kind=archive-jobs");
  const { items } = await response.json();
  const job = items.find((item: { status: string }) => item.status === "failed");
  expect(job).toBeTruthy();
  const target = `/notifications/target?kind=archive-jobs&id=${encodeURIComponent(job.id)}&source=synthetic-notification`;
  await page.goto(target);
  await expect(page).toHaveURL(target);
  await expect(page.getByRole("heading", { name: "SYNTHETIC_NOTIFICATION_DISC" })).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Notification settings", exact: true }).click();
  await expect(page).toHaveURL("/settings#notifications");
  await page.goBack();
  await expect(page).toHaveURL(target);
  await expect(page.getByRole("heading", { name: "SYNTHETIC_NOTIFICATION_DISC" })).toBeVisible();
});

test("opens current Recovery details from a supplied recovery notification", async ({ page, context }) => {
  await controlledSubscription(page);
  await page.goto("/settings#notifications");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const { items } = await (await page.request.get("/api/operations?kind=archive-recoveries")).json();
  const recovery = items.find((item: { id: string }) => item.id === "browser-damage-recovery-alert-recovery");
  expect(recovery).toBeTruthy();
  const { item: archive } = await (await page.request.get(
    `/api/operations?kind=original-disc-archives&id=${recovery.originalDiscArchiveId}`,
  )).json();
  const payload = recoveryNotificationPayload(recovery.originalDiscArchiveId, archive.detectedDisc.volumeLabel);
  await deliverPush(worker, JSON.stringify(payload));
  await clickNotification(worker, payload.tag);
  await expect(page).toHaveURL(new RegExp(`/notifications/target\\?kind=original-disc-archives&id=${recovery.originalDiscArchiveId}$`));
  await expect(page.getByRole("heading", { name: "Archive Recovery", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: archive.detectedDisc.volumeLabel, exact: true })).toBeVisible();
  await expect(page.getByText("Current recovery status", { exact: true })).toBeVisible();
  await expect(page.getByText(recovery.recoveryStatus.replaceAll("_", " "), { exact: true })).toBeVisible();
  await expect(page.getByText("Unrecovered Source", { exact: true })).toBeVisible();
  await expect(page.getByText("Checkpoint reconciliation status", { exact: true })).toBeVisible();
  await expect(page.getByText("CONSISTENCY_FAULT", { exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

test("explains denied permission and unsupported APIs", async ({ page }) => {
  await controlledSubscription(page, "denied");
  await page.goto("/settings#notifications");
  await expect(page.getByText("Notifications are denied.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
  await page.addInitScript(() => { delete (window as unknown as { PushManager?: unknown }).PushManager; });
  await page.reload();
  await expect(page.getByText("This browser does not support Web Push.", { exact: false })).toBeVisible();
});

for (const readiness of [
  { reason: "invalid_configuration", configured: false, message: "Push configuration is invalid." },
  { reason: "ready", configured: true, message: "Delivery is unavailable. The notification dispatcher has not reported readiness recently." },
]) {
  test(`explains ${readiness.reason} readiness in Settings without prompting`, async ({ page }) => {
    await controlledSubscription(page);
    await page.route("**/api/notifications?action=status", async (route) => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({ json: { ...status, configured: readiness.configured, reason: readiness.reason,
        publicKey: readiness.configured ? status.publicKey : null, dispatcherAvailable: false } });
    });
    await page.goto("/settings#notifications");
    await expect(page.getByText(readiness.message, { exact: false })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(readiness.configured
      ? "Notifications disabled on this browser." : "Notifications cannot be enabled until server setup is complete.");
    if (!readiness.configured) await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
  });
}

test("keeps loading, empty and failed Settings usable and retries notification status", async ({ page }) => {
  await controlledSubscription(page);
  let releaseStatus!: () => void;
  const statusReady = new Promise<void>((resolve) => { releaseStatus = resolve; });
  await page.route("**/api/notifications?action=status", async (route) => {
    await statusReady;
    await route.fulfill({ status: 503, json: { error: { message: "Synthetic unavailable service" } } });
  });
  await page.route("**/api/notifications?action=deliveries&limit=25", (route) => route.fulfill({ json: { deliveries: [] } }));
  await page.goto("/settings#notifications");
  await expect(page.getByRole("status")).toHaveText("Checking notification readiness…");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Notifications" })).toBeVisible();
  releaseStatus();
  await expect(page.getByRole("status")).toHaveText("Notification service is unavailable. Try checking status again.");
  await page.unroute("**/api/notifications?action=status");
  await page.getByRole("button", { name: "Check notification status" }).click();
  await expect(page.getByRole("status")).toHaveText("Notification status refreshed.");
  await expect(page.getByText("No retained deliveries.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
});

test("displays a confirmed Recovery Stop with remaining source and navigates to the saved archive", async ({ page, context }) => {
  await controlledSubscription(page);
  await page.goto("/settings#notifications");
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications enabled on this browser.");
  const recoveryId = "browser-damage-notification-recovery";
  const before = await (await page.request.get("/api/notifications?action=deliveries")).json();
  const stopped = await page.request.post(`/api/archive-recoveries/${recoveryId}/stop`, {
    headers: { origin: "http://localhost:3101" },
    data: { mutationKey: "synthetic-browser-stop", attemptId: `${recoveryId}:attempt:1` },
  });
  expect(stopped.status()).toBe(202);
  expect(await (await page.request.get("/api/notifications?action=deliveries")).json()).toEqual(before);
  completeControlledRecoveryStop(recoveryId);
  const sent = dispatchQueuedPushes() as { label: string; body: string; tag: string; destination: string }[];
  const payload = sent.find((item) => item.label === "CATALOG_BROWSER_DAMAGE_NOTIFICATION")!;
  expect(payload).toMatchObject({ body: "Archive Recovery stopped. Source remains unrecovered.",
    destination: expect.stringMatching(/^\/notifications\/target\?kind=original-disc-archives&id=/) });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await deliverPush(worker, JSON.stringify(payload));
  await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications())
    .map((notification) => ({ title: notification.title, body: notification.body }))))
    .toContainEqual({ title: "CATALOG_BROWSER_DAMAGE_NOTIFICATION", body: "Archive Recovery stopped. Source remains unrecovered." });
  await page.goto("/catalog");
  await clickNotification(worker, payload.tag);
  await expect(page).toHaveURL(`http://localhost:3101${payload.destination}`);
  await expect(page.getByRole("heading", { name: "CATALOG_BROWSER_DAMAGE_NOTIFICATION" })).toBeVisible();
  await expect(page.getByText("incomplete read", { exact: true })).toBeVisible();
  const recoveryDetail = page.getByRole("region", { name: "Archive Recovery detail" });
  await expect(recoveryDetail.getByText("stopped", { exact: true })).toBeVisible();
  await expect(recoveryDetail.getByText("1 sectors", { exact: true })).toBeVisible();
  await expect(recoveryDetail.getByRole("list", { name: "Recovery action availability" })).toContainText("Archive Recovery is already stopped.");
  const current = await (await page.request.get(`/api/operations?kind=archive-recoveries&id=${recoveryId}`)).json();
  const resume = current.item.availableActions.find((action: { name: string }) => action.name === "resume");
  expect(resume.eligible).toBe(false);
  // This fixture has no ownership namespace. Both views must fail closed.
  expect(resume.blockingReasons).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "CONSISTENCY_FAULT" }),
  ]));
  await expect(recoveryDetail.getByRole("list", { name: "Recovery action availability" }))
    .toContainText(`resume: ${resume.reason}`);
  expect(context.pages()).toHaveLength(1);
});
