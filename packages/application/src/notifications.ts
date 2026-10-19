import type { DataAccess } from "@rip-dvd/data-access";
import { parseMutationKey } from "./mutation-key.js";
import { readNotificationConfiguration } from "./notification-config.js";
import { formatNotification } from "./notification-policy.js";
import { InvalidNotificationInputError, notificationId, notificationLimit, notificationRecord, validateNotificationSubscription } from "./notification-validation.js";

export class NotificationsUnavailableError extends Error {
  constructor() { super("Notifications are not configured for a secure application origin."); this.name = "NotificationsUnavailableError"; }
}

export function createNotificationOperations(access: DataAccess) {
  return {
    notificationStatus() {
      const config = readNotificationConfiguration();
      const heartbeat = access.notifications.lastHeartbeat();
      const dispatcherAvailable = heartbeat !== null && Date.now() - heartbeat.getTime() < 30_000;
      return { schemaVersion: 1, configured: config.ready,
        reason: config.ready ? (dispatcherAvailable ? "ready" : "delivery_unavailable") : config.reason,
        publicKey: config.ready ? config.configuration.vapid.publicKey : null,
        dispatcherAvailable,
        deliveryMeaning: "Accepted means accepted by the push service, not displayed by a device.",
        disableNotice: "Disabling prevents later dispatch. An already accepted push cannot be recalled." };
    },
    notificationSubscriptions(input: { id?: unknown; limit?: unknown } = {}) {
      return { schemaVersion: 1, subscriptions: access.notifications.subscriptions({
        ...(input.id === undefined ? {} : { id: notificationId(input.id) }), limit: notificationLimit(input.limit) }) };
    },
    notificationDeliveries(input: { eventId?: unknown; limit?: unknown } = {}) {
      return { schemaVersion: 1, deliveries: access.notifications.deliveries({
        ...(input.eventId === undefined ? {} : { eventId: notificationId(input.eventId) }), limit: notificationLimit(input.limit) }) };
    },
    registerNotificationSubscription(input: unknown) {
      const record = notificationRecord(input);
      const mutationKey = parseMutationKey(record.mutationKey);
      const subscription = validateNotificationSubscription(record.subscription);
      if (typeof record.enable !== "boolean") throw new InvalidNotificationInputError("Explicit enable or reconcile is required.");
      if (record.enable && !readNotificationConfiguration().ready) throw new NotificationsUnavailableError();
      return { schemaVersion: 1, ...access.notifications.register({ mutationKey, subscription, enable: record.enable }) };
    },
    removeNotificationSubscription(input: unknown) {
      const record = notificationRecord(input);
      return { schemaVersion: 1, ...access.notifications.disable({ mutationKey: parseMutationKey(record.mutationKey), subscriptionId: notificationId(record.subscriptionId) }) };
    },
    submitTestNotification(input: unknown) {
      const record = notificationRecord(input);
      const mutationKey = parseMutationKey(record.mutationKey);
      if (!readNotificationConfiguration().ready) throw new NotificationsUnavailableError();
      return { schemaVersion: 1, ...access.notifications.submitTest({ mutationKey, event: formatNotification({ kind: "test", sourceEventId: `test:${mutationKey}` }) }),
        status: "queued", deliveryMeaning: "Queued for the dispatcher. Provider acceptance does not prove device display." };
    },
  };
}
