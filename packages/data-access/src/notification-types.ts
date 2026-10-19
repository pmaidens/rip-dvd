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
  status: "queued" | "accepted" | "failed";
  failureCode: "subscription_disabled" | "sender_rejected" | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface NotificationDeliveryClaim {
  id: string;
  token: string;
  subscription: NotificationSubscriptionInput;
  payload: NotificationPayload;
}

export interface NotificationAccess {
  register(input: { mutationKey: string; subscription: NotificationSubscriptionInput; enable: boolean }): { subscription: NotificationSubscriptionSummary };
  disable(input: { mutationKey: string; subscriptionId: string }): { subscription: NotificationSubscriptionSummary };
  subscriptions(input: { id?: string; limit: number }): NotificationSubscriptionSummary[];
  deliveries(input: { eventId?: string; limit: number }): NotificationDeliverySummary[];
  submitTest(input: { mutationKey: string; event: NotificationEventInput }): { eventId: string; recipientCount: number };
  /** Synchronous outcome work and event snapshots commit or roll back together. */
  transaction<T>(write: (events: NotificationEventWriter) => T): T;
  claim(input: { now: Date; leaseMs: number }): NotificationDeliveryClaim | null;
  isDispatchable(claim: NotificationDeliveryClaim): boolean;
  finish(claim: NotificationDeliveryClaim, status: "accepted" | "failed", now: Date): boolean;
  heartbeat(now: Date): void;
  lastHeartbeat(): Date | null;
}
