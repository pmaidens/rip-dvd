export interface NotificationSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface NotificationPayload {
  version: 1;
  title: string;
  label: string;
  body: string;
  tag: string;
  destination: string;
}

export interface NotificationEventInput {
  sourceEventId: string;
  payload: NotificationPayload;
}

export interface NotificationEventWriter {
  recordEvent(input: NotificationEventInput): { eventId: string; recipientCount: number };
}

export interface NotificationSubscriptionSummary {
  id: string;
  active: boolean;
  generation: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationDeliverySummary {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: "queued" | "retrying" | "accepted" | "expired" | "failed";
  failureCode: NotificationFailureCode | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}

export type NotificationFailureCode = "subscription_disabled" | "subscription_expired" | "sender_rejected"
  | "network_error" | "timeout" | "throttled" | "provider_unavailable" | "attempt_limit" | "message_expired";

export type NotificationDeliveryResult =
  | { status: "accepted" }
  | { status: "failed"; failureCode: NotificationFailureCode }
  | { status: "retrying"; failureCode: NotificationFailureCode; nextAttemptAt: Date };

export interface NotificationDeliveryClaim {
  id: string;
  token: string;
  subscription: NotificationSubscriptionInput;
  payload: NotificationPayload;
  attemptCount: number;
  expiresAt: Date;
}

export interface NotificationAccess {
  /** Mutable admission checks run inside the new mutation, after replay/conflict resolution. */
  register(input: { mutationKey: string; subscription: NotificationSubscriptionInput; enable: boolean }, validateNewMutation?: () => void): { subscription: NotificationSubscriptionSummary };
  disable(input: { mutationKey: string; subscriptionId: string }): { subscription: NotificationSubscriptionSummary };
  subscriptions(input: { id?: string; limit: number }): NotificationSubscriptionSummary[];
  deliveries(input: { eventId?: string; limit: number }): NotificationDeliverySummary[];
  submitTest(input: { mutationKey: string; event: NotificationEventInput }, validateNewMutation?: () => void): { eventId: string; recipientCount: number };
  /** Synchronous outcome work and event snapshots commit or roll back together. */
  transaction<T>(write: (events: NotificationEventWriter) => T): T;
  claim(input: { now: Date; leaseMs: number }): NotificationDeliveryClaim | null;
  isDispatchable(claim: NotificationDeliveryClaim, now?: Date): boolean;
  settle(claim: NotificationDeliveryClaim, result: NotificationDeliveryResult, now: Date): NotificationDeliverySummary["status"] | null;
  /** Bounded expiry and retained-history deletion. Deduplication receipts survive cleanup. */
  maintain(input: { now: Date; limit: number }): void;
  heartbeat(now: Date): void;
  lastHeartbeat(): Date | null;
}
