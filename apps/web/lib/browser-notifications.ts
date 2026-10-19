import { createMutationKey } from "./mutation-key";

export interface PushReadiness {
  configured: boolean;
  reason: string;
  publicKey: string | null;
  dispatcherAvailable: boolean;
}
interface SubscriptionSummary { id: string; active: boolean }
const preferenceKey = "rip-dvd.notifications.preference";
const subscriptionKey = "rip-dvd.notifications.subscription";

export function browserNotificationProblem(): string | null {
  if (!window.isSecureContext) return "Notifications require a secure HTTPS origin.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "This browser does not support Web Push. On iPhone, install and open the Home Screen app first.";
  if (Notification.permission === "denied") return "Notifications are denied. Change notification permission in browser or system settings, then return here.";
  return null;
}

async function api(action: string, method = "GET", input?: unknown) {
  const response = await fetch(`/api/notifications${action ? `?action=${action}` : ""}`, {
    method, headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input), cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "Notification service is unavailable.");
  return result;
}

export async function readPushReadiness(): Promise<PushReadiness> { return api("status"); }

let workerRegistration: Promise<ServiceWorkerRegistration> | undefined;
let lastUpdateCheck = -Infinity;
const updateCheckIntervalMs = 5 * 60_000;

function registration(): Promise<ServiceWorkerRegistration> {
  workerRegistration ??= navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    .catch((error) => { workerRegistration = undefined; throw error; });
  return workerRegistration;
}

export async function checkBrowserPushUpdate(): Promise<void> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  const now = Date.now();
  if (now - lastUpdateCheck < updateCheckIntervalMs) return;
  // Throttle failed checks too, and reserve the interval before asynchronous work.
  lastUpdateCheck = now;
  try { await (await registration()).update(); }
  catch { /* The active worker and subscription controls remain usable offline. */ }
}

async function save(subscription: PushSubscription, enable: boolean): Promise<SubscriptionSummary> {
  const result = await api("", "POST", { mutationKey: createMutationKey(), subscription: subscription.toJSON(), enable });
  localStorage.setItem(subscriptionKey, result.subscription.id);
  return result.subscription;
}

export async function reconcileBrowserPush(): Promise<boolean> {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const worker = await registration();
  const subscription = await worker.pushManager.getSubscription();
  if (localStorage.getItem(preferenceKey) === "disabled") {
    const id = localStorage.getItem(subscriptionKey);
    if (id) await api("", "DELETE", { mutationKey: createMutationKey(), subscriptionId: id });
    if (subscription) await subscription.unsubscribe();
    return false;
  }
  // Reconciliation refreshes keys but cannot activate an opted-out server record.
  if (!subscription) return false;
  const saved = await save(subscription, false);
  return saved.active;
}

export async function enableBrowserPush(publicKey: string): Promise<boolean> {
  // This call runs synchronously after the button tap, before any asynchronous work.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied"
    ? "Notifications are denied. Change permission in browser or system settings."
    : "Notification permission was not granted.");
  const worker = await registration();
  await navigator.serviceWorker.ready;
  const encoded = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const key = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const saved = await save(subscription, true);
  localStorage.setItem(preferenceKey, "enabled");
  return saved.active;
}

export async function disableBrowserPush(): Promise<void> {
  // Persist opt-out before any network action. Opening retries a failed removal.
  localStorage.setItem(preferenceKey, "disabled");
  const worker = await navigator.serviceWorker.getRegistration("/");
  const subscription = await worker?.pushManager.getSubscription();
  let id = localStorage.getItem(subscriptionKey);
  if (!id && subscription) id = (await save(subscription, false)).id;
  if (id) await api("", "DELETE", { mutationKey: createMutationKey(), subscriptionId: id });
  if (subscription) await subscription.unsubscribe();
}

export async function submitBrowserTest(): Promise<string> {
  const result = await api("test", "POST", { mutationKey: createMutationKey() });
  return result.eventId;
}

export async function readBrowserTestDelivery(eventId: string): Promise<string> {
  const result = await api(`deliveries&eventId=${encodeURIComponent(eventId)}`);
  const records: { status: string }[] = result.deliveries;
  if (records.length === 0) return "No active browser was eligible for this event.";
  return records.every((record) => record.status === "accepted") ? "Accepted by the push service. Device display is not confirmed."
    : records.some((record) => record.status === "failed") ? "Delivery failed or a browser was disabled. Inspect delivery records for details."
      : "Queued for delivery.";
}
