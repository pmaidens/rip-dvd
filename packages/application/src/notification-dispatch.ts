import type { DataAccess, NotificationPayload, NotificationSubscriptionInput } from "@rip-dvd/data-access";
import { notificationDeliveryFailure } from "./notification-delivery-failure.js";

export type NotificationSender = (subscription: NotificationSubscriptionInput, payload: NotificationPayload,
  options: { signal: AbortSignal; ttlSeconds: number }) => Promise<void>;

async function sendWithinDeadline(send: NotificationSender, subscription: NotificationSubscriptionInput, payload: NotificationPayload,
  ttlSeconds: number, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Notification send timed out"), { name: "TimeoutError" })), 10_000);
  let rejectAborted: (() => void) | undefined;
  try {
    await Promise.race([
      send(subscription, payload, { signal: controller.signal, ttlSeconds }),
      new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAborted, { once: true });
        if (controller.signal.aborted) rejectAborted();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
  }
}

/** One bounded pass. Transport failures only affect delivery records. */
export async function dispatchNotifications(
  access: DataAccess,
  send: NotificationSender,
  options: { limit?: number; now?: () => Date; signal?: AbortSignal } = {},
): Promise<{ accepted: number; failed: number }> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid dispatch limit");
  const now = options.now ?? (() => new Date());
  access.notifications.maintain({ now: now(), limit: 100 });
  access.notifications.heartbeat(now());
  const result = { accepted: 0, failed: 0 };
  for (let index = 0; index < limit && !options.signal?.aborted; index += 1) {
    access.notifications.heartbeat(now());
    const claim = access.notifications.claim({ now: now(), leaseMs: 30_000 });
    if (!claim) break;
    if (!access.notifications.isDispatchable(claim, now())) continue;
    if (claim.subscription.expirationTime !== null && claim.subscription.expirationTime <= now().getTime()) {
      if (access.notifications.settle(claim, { status: "failed", failureCode: "subscription_expired" }, now()) === "failed") result.failed += 1;
      continue;
    }
    try {
      await sendWithinDeadline(send, claim.subscription, claim.payload, Math.max(1, Math.ceil((claim.expiresAt.getTime() - now().getTime()) / 1_000)), options.signal);
      if (access.notifications.settle(claim, { status: "accepted" }, now()) === "accepted") result.accepted += 1;
    } catch (error) {
      // Keep ownership until lease expiry on shutdown. An in-flight response may be lost.
      if (options.signal?.aborted) break;
      const failure = notificationDeliveryFailure(error, claim.attemptCount, now());
      if (access.notifications.settle(claim, failure, now()) === "failed") result.failed += 1;
    }
  }
  return result;
}
