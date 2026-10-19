/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { expect, test, type Page, type Worker } from "@playwright/test";
import { createECDH } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

async function controlledSubscription(page: Page, permission: "granted" | "denied" = "granted") {
  const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.alloc(32, 2));
  const input = { endpoint: "https://web.push.apple.com/synthetic-browser-test", expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } };
  await page.addInitScript(({ subscription, permission }) => {
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => { localStorage.setItem("synthetic-permission-prompts", String(Number(localStorage.getItem("synthetic-permission-prompts") || 0) + 1)); return permission; };
    function current(): PushSubscription | null {
      if (localStorage.getItem("synthetic-push-subscription") !== "yes") return null;
      return { endpoint: subscription.endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true }, getKey: () => null, toJSON: () => subscription,
        unsubscribe: async () => { localStorage.removeItem("synthetic-push-subscription"); return true; } };
    }
    PushManager.prototype.getSubscription = async () => current();
    PushManager.prototype.subscribe = async () => { localStorage.setItem("synthetic-push-subscription", "yes"); return current()!; };
  }, { subscription: input, permission });
}


async function deliverPush(worker: Worker, data: string) {
  const result = await worker.evaluate(async (data) => {
    const event = new PushEvent("push", { data });
    const lifetime: Promise<unknown>[] = [];
    event.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(event);
    return Promise.allSettled(lifetime).then((results) => results.map((result) => result.status === "rejected" ? String(result.reason) : "displayed"));
  }, data);
  expect(result).toEqual(["displayed"]);
}

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
  const data = pathToFileURL(resolve("../../packages/data-access/dist/index.js")).href;
  const app = pathToFileURL(resolve("../../packages/application/dist/index.js")).href;
  const sent = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createDataAccess } from ${JSON.stringify(data)};
    import { dispatchNotifications } from ${JSON.stringify(app)};
    const access = createDataAccess({ databasePath: process.argv[1] });
    const payloads = [];
    await dispatchNotifications(access, async (_subscription, payload) => { payloads.push(payload); });
    access.close();
    console.log(JSON.stringify(payloads));
  `, resolve("test-results/catalog-review-browser-data/rip-dvd.sqlite")], { encoding: "utf8" }));
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
