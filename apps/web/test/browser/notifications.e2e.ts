/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { expect, test } from "@playwright/test";
import { controlledSubscription, deliverPush, dispatchQueuedPushes } from "./notification-test-support";

test("installs metadata and opts in, displays the queued test, navigates, and opts out without reopening permission", async ({ page, context }) => {
  await context.grantPermissions(["notifications"], { origin: "http://localhost:3101" });
  await controlledSubscription(page);
  await page.goto("/notifications");
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
  await expect(page.getByText("On iPhone, open this app in Safari", { exact: false })).toBeVisible();
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ id: "/", display: "standalone", start_url: "/" });
  expect((await page.request.get("/app-icon/192")).headers()["content-type"]).toContain("image/png");
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications enabled on this browser.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(page.getByRole("status")).toContainText("Queued for delivery");
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(await worker.evaluate(() => Notification.permission)).toBe("granted");
  const sent = dispatchQueuedPushes();
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
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("button", { name: "Disable notifications", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Disable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
});

test("handles malformed push data, missing labels and unsafe click destinations", async ({ page, context }) => {
  await context.grantPermissions(["notifications"], { origin: "http://localhost:3101" });
  await controlledSubscription(page);
  await page.goto("/notifications");
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
  await expect(page).toHaveURL(/localhost:3101\/notifications$/);
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
});

test("opens a labeled Archive Job target using its current shared operation detail", async ({ page }) => {
  const response = await page.request.get("/api/operations?kind=archive-jobs");
  const { items } = await response.json();
  const job = items.find((item: { status: string }) => item.status === "failed");
  expect(job).toBeTruthy();
  await page.goto(`/notifications/target?kind=archive-jobs&id=${encodeURIComponent(job.id)}`);
  await expect(page.getByRole("heading", { name: "SYNTHETIC_NOTIFICATION_DISC" })).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
});

test("explains denied permission and unsupported APIs", async ({ page }) => {
  await controlledSubscription(page, "denied");
  await page.goto("/notifications");
  await expect(page.getByText("Notifications are denied.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBeNull();
  await page.addInitScript(() => { delete (window as unknown as { PushManager?: unknown }).PushManager; });
  await page.reload();
  await expect(page.getByText("This browser does not support Web Push.", { exact: false })).toBeVisible();
});
