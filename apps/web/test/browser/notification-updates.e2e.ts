/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
import { expect, test, type Page, type Worker } from "@playwright/test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { controlledSubscription, deliverPush, dispatchQueuedPushes, clickNotification } from "./notification-test-support";

const override = resolve("test-results/notification-worker-override.js");
const requests = resolve("test-results/notification-worker-requests.log");
const oldWorker = readFileSync(resolve("test/browser/fixtures/notification-worker-v1.js"), "utf8");
const requestCount = () => readFileSync(requests, "utf8").trim().split("\n").length;

async function foreground(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

async function activeWorker(page: Page): Promise<Worker> {
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.state)).toBe("activated");
  return page.context().serviceWorkers().find((worker) => worker.url().endsWith("/sw.js"))!;
}

async function subscriptionState(page: Page) {
  return page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration("/"))!;
    return { subscription: (await registration.pushManager.getSubscription())?.toJSON() ?? null,
      id: localStorage.getItem("rip-dvd.notifications.subscription"),
      preference: localStorage.getItem("rip-dvd.notifications.preference"),
      scope: registration.scope, cache: registration.updateViaCache };
  });
}

test.afterEach(() => { rmSync(override, { force: true }); });

test("upgrades an open app without replacing its subscription or reloading, and keeps v1 push and clicks working", async ({ page, context }) => {
  const response = await page.request.get("/sw.js");
  expect(response.headers()["content-type"]).toContain("application/javascript");
  expect(response.headers()["cache-control"]).toContain("must-revalidate");
  const deployedWorker = await response.text();
  writeFileSync(override, oldWorker);
  await controlledSubscription(page);
  await page.clock.install();
  await page.goto("/settings#notifications");
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Notifications enabled on this browser.");
  const old = await activeWorker(page);
  // Bind the subscription assertion to the actual browser registration identity.
  const session = await context.newCDPSession(page);
  const registrations = new Set<string>();
  session.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: values }) => {
    for (const value of values) { if (!value.isDeleted) registrations.add(value.registrationId); }
  });
  await session.send("ServiceWorker.enable");
  await expect.poll(() => registrations.size).toBe(1);
  const payload = JSON.stringify({ version: 1, title: "Synthetic compatible test", body: "Synthetic outcome", tag: "synthetic-update-test", destination: "/settings#notifications" });
  await deliverPush(old, payload);
  await expect.poll(() => old.evaluate(async () => (await self.registration.getNotifications()).find((item) => item.tag === "synthetic-update-test")?.data.destination))
    .toBe("http://localhost:3101/notifications");
  await clickNotification(old, "synthetic-update-test");
  await expect(page).toHaveURL(/\/settings#notifications$/);
  await expect(page.getByRole("button", { name: "Disable notifications", exact: true })).toBeEnabled();
  // Keep an already-displayed legacy notification across activation of the new worker.
  await deliverPush(old, JSON.stringify({ version: 1, title: "Synthetic legacy test", body: "Before activation",
    tag: "synthetic-legacy-update", destination: "/notifications" }));
  await page.evaluate(() => { (window as unknown as { pageLifetime: string }).pageLifetime = "synthetic-open-page"; });
  const before = await subscriptionState(page);
  expect(before.cache).toBe("none");
  const count = requestCount();
  writeFileSync(override, deployedWorker + '\nself.addEventListener("activate", () => { self.syntheticRevision = "new"; });');
  await foreground(page);
  await page.getByRole("button", { name: "Check notification status" }).click();
  expect(requestCount()).toBe(count);
  await page.clock.fastForward(5 * 60_000 + 1);
  const updated = context.waitForEvent("serviceworker");
  await foreground(page);
  const worker = await updated;
  await expect.poll(() => worker.evaluate(() => (self as unknown as { syntheticRevision?: string }).syntheticRevision)).toBe("new");
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageLifetime: string }).pageLifetime)).toBe("synthetic-open-page");
  expect(await subscriptionState(page)).toEqual(before);
  expect(registrations.size).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
  await deliverPush(worker, payload);
  await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications()).map((item) => item.title))).toContain("Synthetic compatible test");
  await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications()).find((item) => item.tag === "synthetic-update-test")?.data.destination))
    .toBe("http://localhost:3101/settings#notifications");
  await page.getByRole("button", { name: "Send test notification" }).click();
  await expect(page.getByRole("status")).toContainText("Queued for delivery");
  const queued = dispatchQueuedPushes();
  expect(queued.length).toBeGreaterThan(0);
  for (const payload of queued) {
    expect(payload).toMatchObject({ destination: "/settings#notifications" });
    await deliverPush(worker, JSON.stringify(payload));
  }
  await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications()).map((item) => item.title))).toContain("Rip DVD test");
  await clickNotification(worker, "synthetic-update-test");
  await expect(page).toHaveURL(/\/settings#notifications$/);
  expect(context.pages()).toHaveLength(1);
  await page.goto("/catalog");
  await clickNotification(worker, "synthetic-legacy-update");
  await expect(page).toHaveURL("/settings#notifications");
  expect(context.pages()).toHaveLength(1);
  expect(await subscriptionState(page)).toEqual(before);
  expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
});

for (const failure of [
  { name: "malformed script", script: "self.addEventListener(\"install\", ;", error: true },
  { name: "rejected installation", script: 'self.addEventListener("install", event => { event.waitUntil(Promise.reject(new Error("Synthetic rejected installation"))); });', error: false },
].flatMap((failure) => [ { ...failure, optedOut: false }, { ...failure, optedOut: true } ])) {
  test(`preserves ${failure.optedOut ? "opt-out" : "the enabled subscription"} after a ${failure.name} and corrected activation`, async ({ page, context }) => {
    await controlledSubscription(page);
    await page.clock.install();
    await page.goto("/settings#notifications");
    await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Notifications enabled on this browser.");
    const knownGood = await activeWorker(page);
    if (failure.optedOut) {
      await page.getByRole("button", { name: "Disable notifications", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Notifications disabled on this browser.");
    }
    const before = await subscriptionState(page);
    const session = await context.newCDPSession(page);
    const errors: string[] = [];
    const redundant = new Set<string>();
    session.on("ServiceWorker.workerErrorReported", ({ errorMessage }) => { errors.push(errorMessage.errorMessage); });
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      for (const version of versions) { if (version.status === "redundant") redundant.add(version.versionId); }
    });
    await session.send("ServiceWorker.enable");
    await page.evaluate(() => { (window as unknown as { pageLifetime: string }).pageLifetime = "synthetic-surviving-page"; });
    writeFileSync(override, failure.script);
    await page.clock.fastForward(5 * 60_000 + 1);
    await foreground(page);
    await expect.poll(() => failure.error ? errors.length : redundant.size).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { pageLifetime: string }).pageLifetime)).toBe("synthetic-surviving-page");
    expect(await subscriptionState(page)).toEqual(before);
    await deliverPush(knownGood, JSON.stringify({ version: 1, title: "Synthetic retained worker", body: "Still usable", tag: "synthetic-retained", destination: "/notifications" }));
    await expect.poll(() => knownGood.evaluate(async () => (await self.registration.getNotifications()).map((item) => item.title))).toContain("Synthetic retained worker");
    await page.getByRole("button", { name: "Check notification status" }).click();
    await expect(page.getByRole("status")).toHaveText("Notification status refreshed.");
    if (failure.optedOut) {
      await expect(page.getByRole("button", { name: "Send test notification" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeEnabled();
    } else {
      await page.getByRole("button", { name: "Send test notification" }).click();
      await expect(page.getByRole("status")).toContainText("Queued for delivery");
    }
    // A corrected deployment can still replace the retained worker later.
    rmSync(override);
    const corrected = await (await page.request.get("/sw.js")).text();
    writeFileSync(override, corrected + '\nself.addEventListener("activate", () => { self.syntheticRevision = "corrected"; });');
    await page.clock.fastForward(5 * 60_000 + 1);
    const updated = context.waitForEvent("serviceworker");
    await foreground(page);
    const worker = await updated;
    await expect.poll(() => worker.evaluate(() => (self as unknown as { syntheticRevision?: string }).syntheticRevision)).toBe("corrected");
    expect(await subscriptionState(page)).toEqual(before);
    await page.reload();
    await expect(page.getByRole("button", { name: failure.optedOut ? "Enable notifications" : "Disable notifications", exact: true })).toBeEnabled();
    expect(await subscriptionState(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem("synthetic-permission-prompts"))).toBe("1");
  });
}
