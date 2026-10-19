import type { NotificationDeliveryResult } from "@rip-dvd/data-access";

/** Keep only allowlisted diagnostics. Provider messages, bodies and URLs are sensitive. */
export function notificationDeliveryFailure(error: unknown, attempt: number, now: Date): Exclude<NotificationDeliveryResult, { status: "accepted" }> {
  const detail = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = detail.statusCode;
  if (status === 404 || status === 410) return { status: "failed", failureCode: "subscription_expired" };
  let failureCode: "timeout" | "network_error" | "throttled" | "provider_unavailable";
  if (status === 429) failureCode = "throttled";
  else if (typeof status === "number" && status >= 500 && status <= 599) failureCode = "provider_unavailable";
  else if (status === 408 || detail.code === "ETIMEDOUT" || detail.name === "TimeoutError" || detail.message === "Socket timeout") failureCode = "timeout";
  else if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(String(detail.code))) failureCode = "network_error";
  else return { status: "failed", failureCode: "sender_rejected" };

  const headers = detail.headers !== null && typeof detail.headers === "object" ? detail.headers as Record<string, unknown> : {};
  const guidance = headers["retry-after"];
  let retryAt = 0;
  if (typeof guidance === "string") {
    retryAt = /^\d+$/.test(guidance) ? now.getTime() + Number(guidance) * 1_000 : Date.parse(guidance);
  }
  const backoff = Math.min(60 * 60 * 1_000, 5_000 * 2 ** (attempt - 1));
  // A provider delay beyond the message lifetime expires the delivery at persistence.
  return { status: "retrying", failureCode, nextAttemptAt: new Date(Math.min(8_640_000_000_000_000,
    Math.max(now.getTime() + backoff, Number.isNaN(retryAt) ? 0 : retryAt))) };
}
