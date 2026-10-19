import webpush from "web-push";
import type { NotificationConfiguration } from "./notification-config.js";
import type { NotificationSender } from "./notification-dispatch.js";
import { requireCurrentPushSubscription, validateNotificationSubscription } from "./notification-validation.js";

export function createWebPushSender(configuration: NotificationConfiguration): NotificationSender {
  return async (subscription, payload) => {
    // Validate again at the network boundary, including persisted subscriptions.
    const validated = validateNotificationSubscription(subscription);
    requireCurrentPushSubscription(validated);
    const result = await webpush.sendNotification(validated, JSON.stringify(payload), {
      vapidDetails: configuration.vapid, timeout: 10_000, TTL: 300,
      contentEncoding: "aes128gcm", urgency: "normal",
    });
    if (result.statusCode < 200 || result.statusCode >= 300) throw new Error("Push service rejected delivery");
  };
}
