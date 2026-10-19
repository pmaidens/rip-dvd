import { createApplicationOperations } from "@rip-dvd/application";
import type { DataAccess } from "@rip-dvd/data-access";
import { readStructuredObject, type StructuredInputIO, StructuredInputError } from "./structured-input.js";

export function runNotifications(args: readonly string[], io: StructuredInputIO & { openAccess(): DataAccess }) {
  const [action = "status", ...rest] = args;
  const allowed: Record<string, readonly string[]> = {
    status: [], subscriptions: ["--id", "--limit"], deliveries: ["--event-id", "--limit"],
    register: ["--key", "--json", "--file", "--stdin"], remove: ["--key", "--id"], test: ["--key"],
  };
  const flags = allowed[action];
  if (!flags) throw new StructuredInputError("INVALID_ARGUMENTS", "Unknown notifications action.");
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flags.includes(flag) || options.has(flag)) throw new StructuredInputError("INVALID_ARGUMENTS", "Invalid notification options.");
    if (flag === "--stdin") { options.set(flag, "true"); continue; }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new StructuredInputError("INVALID_ARGUMENTS", "Missing notification option value.");
    options.set(flag, value);
  }
  const access = io.openAccess();
  try {
    const operations = createApplicationOperations(access);
    const limit = options.has("--limit") ? Number(options.get("--limit")) : undefined;
    switch (action) {
      case "status": return operations.notificationStatus();
      case "subscriptions": return operations.notificationSubscriptions({ id: options.get("--id"), limit });
      case "deliveries": return operations.notificationDeliveries({ eventId: options.get("--event-id"), limit });
      case "register": {
        const input = readStructuredObject(options, io);
        if (!input) throw new StructuredInputError("INVALID_ARGUMENTS", "Subscription JSON input is required.");
        return operations.registerNotificationSubscription({ ...input, mutationKey: options.get("--key") });
      }
      case "remove": return operations.removeNotificationSubscription({ mutationKey: options.get("--key"), subscriptionId: options.get("--id") });
      case "test": return operations.submitTestNotification({ mutationKey: options.get("--key") });
    }
  } finally { access.close(); }
}
