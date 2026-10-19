import type { DataAccess, NotificationPayload, NotificationSubscriptionInput } from "@rip-dvd/data-access";

export type NotificationSender = (subscription: NotificationSubscriptionInput, payload: NotificationPayload) => Promise<void>;

/** One bounded pass. Transport failures only affect delivery records. */
export async function dispatchNotifications(
  access: DataAccess,
  send: NotificationSender,
  options: { limit?: number; now?: () => Date; signal?: AbortSignal } = {},
): Promise<{ accepted: number; failed: number }> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid dispatch limit");
  const now = options.now ?? (() => new Date());
  access.notifications.heartbeat(now());
  const result = { accepted: 0, failed: 0 };
  for (let index = 0; index < limit && !options.signal?.aborted; index += 1) {
    access.notifications.heartbeat(now());
    const claim = access.notifications.claim({ now: now(), leaseMs: 30_000 });
    if (!claim) break;
    if (!access.notifications.isDispatchable(claim)) continue;
    try {
      await send(claim.subscription, claim.payload);
      if (access.notifications.finish(claim, "accepted", now())) result.accepted += 1;
    } catch {
      if (access.notifications.finish(claim, "failed", now())) result.failed += 1;
    }
  }
  return result;
}
