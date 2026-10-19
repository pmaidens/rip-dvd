import webpush from "web-push";
import { Agent } from "node:https";
import type { NotificationConfiguration } from "./notification-config.js";
import type { NotificationSender } from "./notification-dispatch.js";
import { requireCurrentPushSubscription, validateNotificationSubscription } from "./notification-validation.js";

export function createWebPushSender(configuration: NotificationConfiguration): NotificationSender {
  return async (subscription, payload, options) => {
    // Validate again at the network boundary, including persisted subscriptions.
    const validated = validateNotificationSubscription(subscription);
    requireCurrentPushSubscription(validated);
    options.signal.throwIfAborted();
    // Isolate each request so cancellation closes its socket, including a trickling response.
    const agent = new Agent({ keepAlive: false });
    const abort = () => agent.destroy();
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await webpush.sendNotification(validated, JSON.stringify(payload), {
        vapidDetails: configuration.vapid, timeout: 10_000, TTL: options.ttlSeconds,
        contentEncoding: "aes128gcm", urgency: "normal", agent,
      });
      if (result.statusCode < 200 || result.statusCode >= 300) throw result;
    } finally {
      options.signal.removeEventListener("abort", abort);
      agent.destroy();
    }
  };
}
