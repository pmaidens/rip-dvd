import { ECDH } from "node:crypto";
import type { NotificationSubscriptionInput } from "@rip-dvd/data-access";

export class InvalidNotificationInputError extends Error {
  constructor(message = "Invalid notification input.") { super(message); this.name = "InvalidNotificationInputError"; }
}

export function notificationRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidNotificationInputError();
  return value as Record<string, unknown>;
}

export function notificationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new InvalidNotificationInputError("Invalid notification ID.");
  return value;
}

export function notificationLimit(value: unknown = 50): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) throw new InvalidNotificationInputError("Notification limit must be between 1 and 100.");
  return value;
}

export function base64Key(value: unknown, size: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) throw new InvalidNotificationInputError("Invalid push key.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== value) throw new InvalidNotificationInputError("Invalid push key.");
  return bytes;
}

export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new InvalidNotificationInputError("Invalid push destination.");
  let url: URL;
  try { url = new URL(value); } catch { throw new InvalidNotificationInputError("Invalid push destination."); }
  const allowed = url.hostname === "fcm.googleapis.com" || url.hostname === "web.push.apple.com" ||
    url.hostname === "updates.push.services.mozilla.com";
  if (!allowed || url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.hash || url.pathname === "/") {
    throw new InvalidNotificationInputError("Push destination must use a supported HTTPS push service.");
  }
  return url.href;
}

export function validateNotificationSubscription(value: unknown): NotificationSubscriptionInput {
  const input = notificationRecord(value);
  const keys = notificationRecord(input.keys);
  const p256dh = base64Key(keys.p256dh, 65);
  try { ECDH.convertKey(p256dh, "prime256v1"); } catch { throw new InvalidNotificationInputError("Invalid push public key."); }
  base64Key(keys.auth, 16);
  if (input.expirationTime !== undefined && input.expirationTime !== null &&
    (typeof input.expirationTime !== "number" || !Number.isSafeInteger(input.expirationTime) || input.expirationTime <= Date.now())) {
    throw new InvalidNotificationInputError("Invalid subscription expiry.");
  }
  return { endpoint: validatePushEndpoint(input.endpoint),
    expirationTime: input.expirationTime as number | null | undefined ?? null,
    keys: { p256dh: p256dh.toString("base64url"), auth: keys.auth as string } };
}
