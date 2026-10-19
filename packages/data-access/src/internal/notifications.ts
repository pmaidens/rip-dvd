import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { DomainInvariantError, MutationKeyConflictError, RecordNotFoundError } from "../errors.js";
import type { NotificationAccess, NotificationEventInput, NotificationEventWriter, NotificationSubscriptionSummary } from "../notification-types.js";
import * as schema from "./schema.js";

const { notificationSubscriptions: subscriptions, notificationEvents: events,
  notificationDeliveries: deliveries, notificationDispatcher: dispatcher, mutationInvocations } = schema;
type Database = NodeSQLiteDatabase;
export type NotificationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Uses the caller's transaction. Never commits or performs network I/O. */
export function createNotificationEventWriter(
  transaction: NotificationTransaction,
  now: () => Date,
): NotificationEventWriter {
  return {
    recordEvent(input: NotificationEventInput) {
      const existing = transaction.select().from(events)
        .where(eq(events.sourceEventId, input.sourceEventId)).get();
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
          throw new DomainInvariantError("Notification source event identity has conflicting facts");
        }
        const recipients = transaction.select({ id: deliveries.id }).from(deliveries)
          .where(eq(deliveries.eventId, existing.id)).all();
        return { eventId: existing.id, recipientCount: recipients.length };
      }
      const timestamp = now();
      const eventId = randomUUID();
      transaction.insert(events).values({ id: eventId, ...input, createdAt: timestamp }).run();
      // Snapshot eligibility once. New or re-enabled browsers never receive this event.
      const recipients = transaction.select().from(subscriptions).where(eq(subscriptions.active, true)).all();
      for (const recipient of recipients) {
        transaction.insert(deliveries).values({ id: randomUUID(), eventId,
          subscriptionId: recipient.id, generation: recipient.generation,
          status: "queued", createdAt: timestamp }).run();
      }
      return { eventId, recipientCount: recipients.length };
    },
  };
}

function summary({ id, active, generation, createdAt, updatedAt }: typeof subscriptions.$inferSelect): NotificationSubscriptionSummary {
  return { id, active, generation, createdAt, updatedAt };
}

export function createNotificationAccess(database: Database, now: () => Date): NotificationAccess {
  function mutation<T>(key: string, operation: string, input: unknown, write: (transaction: NotificationTransaction) => T): T {
    let result: T;
    database.transaction((transaction) => {
      result = run(transaction);
    }, { behavior: "immediate" });
    return result!;
    function run(transaction: NotificationTransaction): T {
      const semanticInput = JSON.stringify(input);
      const previous = transaction.select().from(mutationInvocations).where(eq(mutationInvocations.key, key)).get();
      if (previous) {
        if (previous.operation !== operation || previous.semanticInput !== semanticInput) throw new MutationKeyConflictError();
        return JSON.parse(previous.outcome, (field, value: unknown) =>
          (field === "createdAt" || field === "updatedAt") && typeof value === "string" ? new Date(value) : value) as T;
      }
      const outcome = write(transaction);
      transaction.insert(mutationInvocations).values({ key, operation, semanticInput,
        outcome: JSON.stringify(outcome), createdAt: now() }).run();
      return outcome;
    }
  }
  return {
    register(input, validateNewMutation) {
      return mutation(input.mutationKey, "notification_register", { subscription: input.subscription, enable: input.enable }, (tx) => {
        validateNewMutation?.();
        const existing = tx.select().from(subscriptions).where(eq(subscriptions.endpoint, input.subscription.endpoint)).get();
        const timestamp = now();
        if (existing) {
          const active = input.enable || existing.active;
          const generation = existing.generation + (!existing.active && active ? 1 : 0);
          const updated = tx.update(subscriptions).set({ subscription: input.subscription, active, generation, updatedAt: timestamp })
            .where(eq(subscriptions.id, existing.id)).returning().get()!;
          return { subscription: summary(updated) };
        }
        const inserted = tx.insert(subscriptions).values({ id: randomUUID(), endpoint: input.subscription.endpoint,
          subscription: input.subscription, active: input.enable, generation: 1, createdAt: timestamp, updatedAt: timestamp }).returning().get()!;
        return { subscription: summary(inserted) };
      });
    },
    disable(input) {
      return mutation(input.mutationKey, "notification_disable", { subscriptionId: input.subscriptionId }, (tx) => {
        const updated = tx.update(subscriptions).set({ active: false, updatedAt: now() })
          .where(eq(subscriptions.id, input.subscriptionId)).returning().get();
        if (!updated) throw new RecordNotFoundError("notification subscription", input.subscriptionId);
        tx.update(deliveries).set({ status: "failed", failureCode: "subscription_disabled", completedAt: now(), claimToken: null, leaseUntil: null })
          .where(and(eq(deliveries.subscriptionId, input.subscriptionId), eq(deliveries.status, "queued"))).run();
        return { subscription: summary(updated) };
      });
    },
    subscriptions(input) {
      return database.select().from(subscriptions).where(input.id ? eq(subscriptions.id, input.id) : undefined)
        .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id)).limit(input.limit).all().map(summary);
    },
    deliveries(input) {
      return database.select({ id: deliveries.id, eventId: deliveries.eventId, subscriptionId: deliveries.subscriptionId,
        status: deliveries.status, failureCode: deliveries.failureCode, createdAt: deliveries.createdAt, completedAt: deliveries.completedAt })
        .from(deliveries).where(input.eventId ? eq(deliveries.eventId, input.eventId) : undefined)
        .orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(input.limit).all();
    },
    submitTest(input, validateNewMutation) {
      return mutation(input.mutationKey, "notification_test", input.event, (tx) => {
        validateNewMutation?.();
        return createNotificationEventWriter(tx, now).recordEvent(input.event);
      });
    },
    transaction(write) {
      let result: ReturnType<typeof write>;
      database.transaction((tx) => {
        result = write(createNotificationEventWriter(tx, now));
        if (result instanceof Promise) throw new DomainInvariantError("Notification outcome transactions must be synchronous");
      }, { behavior: "immediate" });
      return result!;
    },
    claim(input) {
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 60_000) throw new RangeError("Invalid notification lease");
      return database.transaction((tx) => {
        const row = tx.select({ delivery: deliveries, subscription: subscriptions, event: events }).from(deliveries)
          .innerJoin(subscriptions, eq(subscriptions.id, deliveries.subscriptionId))
          .innerJoin(events, eq(events.id, deliveries.eventId))
          .where(and(eq(deliveries.status, "queued"), eq(subscriptions.active, true), eq(subscriptions.generation, deliveries.generation),
            or(isNull(deliveries.leaseUntil), lte(deliveries.leaseUntil, input.now))))
          .orderBy(asc(deliveries.createdAt), asc(deliveries.id)).limit(1).get();
        if (!row) return null;
        const token = randomUUID();
        tx.update(deliveries).set({ claimToken: token, leaseUntil: new Date(input.now.getTime() + input.leaseMs) })
          .where(eq(deliveries.id, row.delivery.id)).run();
        return { id: row.delivery.id, token, subscription: row.subscription.subscription, payload: row.event.payload };
      }, { behavior: "immediate" });
    },
    isDispatchable(claim) {
      return Boolean(database.select({ id: deliveries.id }).from(deliveries)
        .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
        .where(and(eq(deliveries.id, claim.id), eq(deliveries.claimToken, claim.token), eq(deliveries.status, "queued"),
          eq(subscriptions.active, true), eq(subscriptions.generation, deliveries.generation))).get());
    },
    finish(claim, status, timestamp) {
      return database.update(deliveries).set({ status, failureCode: status === "failed" ? "sender_rejected" : null,
        completedAt: timestamp, claimToken: null, leaseUntil: null })
        .where(and(eq(deliveries.id, claim.id), eq(deliveries.claimToken, claim.token), eq(deliveries.status, "queued")))
        .returning({ id: deliveries.id }).get() !== undefined;
    },
    heartbeat(timestamp) {
      database.insert(dispatcher).values({ id: 1, heartbeatAt: timestamp }).onConflictDoUpdate({ target: dispatcher.id, set: { heartbeatAt: timestamp } }).run();
    },
    lastHeartbeat() {
      return database.select().from(dispatcher).where(eq(dispatcher.id, 1)).get()?.heartbeatAt ?? null;
    },
  };
}
