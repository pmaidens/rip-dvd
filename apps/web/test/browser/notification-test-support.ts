/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
import { expect, type Page, type Worker } from "@playwright/test";
import { createECDH } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function controlledSubscription(page: Page, permission: "granted" | "denied" = "granted") {
  const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.alloc(32, 2));
  const input = { endpoint: "https://web.push.apple.com/synthetic-browser-test", expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } };
  await page.addInitScript(({ subscription, permission }) => {
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => { localStorage.setItem("synthetic-permission-prompts", String(Number(localStorage.getItem("synthetic-permission-prompts") || 0) + 1)); return permission; };
    function current(): PushSubscription | null {
      if (localStorage.getItem("synthetic-push-subscription") !== "yes") return null;
      const endpoint = `${subscription.endpoint}-${localStorage.getItem("synthetic-push-generation")}`;
      return { endpoint, expirationTime: null, options: { applicationServerKey: null, userVisibleOnly: true }, getKey: () => null, toJSON: () => ({ ...subscription, endpoint }),
        unsubscribe: async () => { localStorage.removeItem("synthetic-push-subscription"); return true; } };
    }
    PushManager.prototype.getSubscription = async () => current();
    PushManager.prototype.subscribe = async () => {
      localStorage.setItem("synthetic-push-generation", String(Number(localStorage.getItem("synthetic-push-generation") || 0) + 1));
      localStorage.setItem("synthetic-push-subscription", "yes");
      return current()!;
    };
  }, { subscription: input, permission });
}

export async function deliverPush(worker: Worker, data: string) {
  const result = await worker.evaluate(async (data) => {
    const event = new PushEvent("push", { data });
    const lifetime: Promise<unknown>[] = [];
    event.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(event);
    return Promise.allSettled(lifetime).then((results) => results.map((result) => result.status === "rejected" ? String(result.reason) : "displayed"));
  }, data);
  expect(result).toEqual(["displayed"]);
}

export function dispatchQueuedPushes(): unknown[] {
  const data = pathToFileURL(resolve("../../packages/data-access/dist/index.js")).href;
  const app = pathToFileURL(resolve("../../packages/application/dist/index.js")).href;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createDataAccess } from ${JSON.stringify(data)};
    import { dispatchNotifications } from ${JSON.stringify(app)};
    const access = createDataAccess({ databasePath: process.argv[1] });
    const payloads = [];
    await dispatchNotifications(access, async (_subscription, payload) => { payloads.push(payload); });
    access.close();
    console.log(JSON.stringify(payloads));
  `, resolve("test-results/catalog-review-browser-data/rip-dvd.sqlite")], { encoding: "utf8" }));
}

export async function clickNotification(worker: Worker, tag: string): Promise<void> {
  await expect.poll(() => worker.evaluate(async () => (await self.registration.getNotifications()).map((item) => item.tag))).toContain(tag);
  await worker.evaluate(async (tag) => {
    const notification = (await self.registration.getNotifications()).find((item) => item.tag === tag)!;
    const event = new NotificationEvent("notificationclick", { notification });
    const lifetime: Promise<unknown>[] = [];
    event.waitUntil = (promise) => { lifetime.push(promise); };
    self.dispatchEvent(event);
    await Promise.all(lifetime);
  }, tag);
}
