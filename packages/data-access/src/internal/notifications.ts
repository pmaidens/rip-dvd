import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { DomainInvariantError, MutationKeyConflictError, RecordNotFoundError } from "../errors.js";
import type { NotificationAccess, NotificationEventInput, NotificationEventWriter, NotificationSubscriptionSummary } from "../notification-types.js";
import { NOTIFICATION_HISTORY_MS, NOTIFICATION_LIFETIME_MS, NOTIFICATION_MAX_ATTEMPTS } from "../notification-delivery-policy.js";
import * as schema from "./schema.js";

const { notificationSubscriptions: subscriptions, notificationEvents: events,
  notificationDeliveries: deliveries, notificationDispatcher: dispatcher, notificationEventReceipts: receipts, mutationInvocations } = schema;
type Database = NodeSQLiteDatabase;
export type NotificationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const pending = () => inArray(deliveries.status, ["queued", "retrying"]);
const payloadDigest = (payload: NotificationEventInput["payload"]) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/** Uses the caller's transaction. Never commits or performs network I/O. */
export function createNotificationEventWriter(
  transaction: NotificationTransaction,
  now: () => Date,
): NotificationEventWriter {
  return {
    recordEvent(input: NotificationEventInput) {
      const receipt = transaction.select().from(receipts).where(eq(receipts.sourceEventId, input.sourceEventId)).get();
      if (receipt) {
        if (receipt.payloadDigest !== payloadDigest(input.payload)) throw new DomainInvariantError("Notification source event identity has conflicting facts");
        return { eventId: receipt.eventId, recipientCount: receipt.recipientCount };
      }
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
      transaction.insert(receipts).values({ sourceEventId: input.sourceEventId, eventId,
        payloadDigest: payloadDigest(input.payload), recipientCount: recipients.length }).run();
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
        tx.update(deliveries).set({ status: "failed", failureCode: "subscription_disabled", completedAt: now(), nextAttemptAt: null, claimToken: null, leaseUntil: null })
          .where(and(eq(deliveries.subscriptionId, input.subscriptionId), pending())).run();
        return { subscription: summary(updated) };
      });
    },
    subscriptions(input) {
      return database.select().from(subscriptions).where(input.id ? eq(subscriptions.id, input.id) : undefined)
        .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id)).limit(input.limit).all().map(summary);
    },
    deliveries(input) {
      return database.select({ id: deliveries.id, eventId: deliveries.eventId, subscriptionId: deliveries.subscriptionId,
        status: deliveries.status, failureCode: deliveries.failureCode, attemptCount: deliveries.attemptCount,
        nextAttemptAt: deliveries.nextAttemptAt, createdAt: deliveries.createdAt, completedAt: deliveries.completedAt })
        .from(deliveries).where(input.eventId ? eq(deliveries.eventId, input.eventId) : undefined)
        .orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(input.limit).all()
        .map((row) => ({ ...row, expiresAt: new Date(row.createdAt.getTime() + NOTIFICATION_LIFETIME_MS) }));
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
          .where(and(pending(), eq(subscriptions.active, true), eq(subscriptions.generation, deliveries.generation),
            gt(deliveries.createdAt, new Date(input.now.getTime() - NOTIFICATION_LIFETIME_MS)),
            lt(deliveries.attemptCount, NOTIFICATION_MAX_ATTEMPTS),
            or(isNull(deliveries.nextAttemptAt), lte(deliveries.nextAttemptAt, input.now)),
            or(isNull(deliveries.leaseUntil), lte(deliveries.leaseUntil, input.now))))
          .orderBy(asc(deliveries.createdAt), asc(deliveries.id)).limit(1).get();
        if (!row) return null;
        const token = randomUUID();
        tx.update(deliveries).set({ claimToken: token, leaseUntil: new Date(input.now.getTime() + input.leaseMs),
          attemptCount: row.delivery.attemptCount + 1 })
          .where(eq(deliveries.id, row.delivery.id)).run();
        return { id: row.delivery.id, token, subscription: row.subscription.subscription, payload: row.event.payload,
          attemptCount: row.delivery.attemptCount + 1, expiresAt: new Date(row.delivery.createdAt.getTime() + NOTIFICATION_LIFETIME_MS) };
      }, { behavior: "immediate" });
    },
    isDispatchable(claim, timestamp = now()) {
      return Boolean(database.select({ id: deliveries.id }).from(deliveries)
        .innerJoin(subscriptions, eq(deliveries.subscriptionId, subscriptions.id))
        .where(and(eq(deliveries.id, claim.id), eq(deliveries.claimToken, claim.token), pending(),
          gt(deliveries.leaseUntil, timestamp), gt(deliveries.createdAt, new Date(timestamp.getTime() - NOTIFICATION_LIFETIME_MS)),
          eq(subscriptions.active, true), eq(subscriptions.generation, deliveries.generation))).get());
    },
    settle(claim, result, timestamp) {
      return database.transaction((tx) => {
        const row = tx.select().from(deliveries).where(and(eq(deliveries.id, claim.id), eq(deliveries.claimToken, claim.token),
          pending(), gt(deliveries.leaseUntil, timestamp))).get();
        if (!row) return null;
        const expired = timestamp.getTime() >= row.createdAt.getTime() + NOTIFICATION_LIFETIME_MS
          || (result.status === "retrying" && result.nextAttemptAt.getTime() >= row.createdAt.getTime() + NOTIFICATION_LIFETIME_MS);
        const exhausted = result.status === "retrying" && row.attemptCount >= NOTIFICATION_MAX_ATTEMPTS;
        const status = expired ? "expired" : exhausted ? "failed" : result.status;
        const failureCode = expired ? "message_expired" : exhausted ? "attempt_limit" : result.status === "accepted" ? null : result.failureCode;
        tx.update(deliveries).set({ status, failureCode,
          nextAttemptAt: status === "retrying" && result.status === "retrying" ? result.nextAttemptAt : null,
          completedAt: status === "retrying" ? null : timestamp, claimToken: null, leaseUntil: null })
          .where(eq(deliveries.id, claim.id)).run();
        if (result.status === "failed" && result.failureCode === "subscription_expired") {
          // An obsolete in-flight generation cannot deactivate a newly enabled one.
          tx.update(subscriptions).set({ active: false, updatedAt: timestamp })
            .where(and(eq(subscriptions.id, row.subscriptionId), eq(subscriptions.generation, row.generation))).run();
          tx.update(deliveries).set({ status: "failed", failureCode: "subscription_expired", completedAt: timestamp, nextAttemptAt: null, claimToken: null, leaseUntil: null })
            .where(and(eq(deliveries.subscriptionId, row.subscriptionId), eq(deliveries.generation, row.generation), pending())).run();
        }
        return status;
      }, { behavior: "immediate" });
    },
    maintain(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("Invalid notification maintenance limit");
      database.transaction((tx) => {
        const expired = tx.select().from(deliveries).where(and(pending(),
          or(isNull(deliveries.leaseUntil), lte(deliveries.leaseUntil, input.now)), or(
          lte(deliveries.createdAt, new Date(input.now.getTime() - NOTIFICATION_LIFETIME_MS)),
          eq(deliveries.attemptCount, NOTIFICATION_MAX_ATTEMPTS))))
          .orderBy(asc(deliveries.createdAt)).limit(input.limit).all();
        for (const row of expired) {
          const lifetimeEnded = row.createdAt.getTime() + NOTIFICATION_LIFETIME_MS <= input.now.getTime();
          tx.update(deliveries).set({ status: lifetimeEnded ? "expired" : "failed", failureCode: lifetimeEnded ? "message_expired" : "attempt_limit",
            completedAt: input.now, nextAttemptAt: null, claimToken: null, leaseUntil: null }).where(eq(deliveries.id, row.id)).run();
        }
        function retainReceipt(eventId: string) {
          const event = tx.select().from(events).where(eq(events.id, eventId)).get()!;
          const count = tx.select({ count: sql<number>`count(*)` }).from(deliveries).where(eq(deliveries.eventId, eventId)).get()!.count;
          tx.insert(receipts).values({ sourceEventId: event.sourceEventId, eventId, payloadDigest: payloadDigest(event.payload), recipientCount: count })
            .onConflictDoNothing().run();
        }
        const cutoff = new Date(input.now.getTime() - NOTIFICATION_HISTORY_MS);
        const old = tx.select({ id: deliveries.id, eventId: deliveries.eventId }).from(deliveries)
          .where(lte(deliveries.completedAt, cutoff)).orderBy(asc(deliveries.completedAt)).limit(input.limit).all();
        for (const eventId of new Set(old.map((row) => row.eventId))) retainReceipt(eventId);
        if (old.length) tx.delete(deliveries).where(inArray(deliveries.id, old.map((row) => row.id))).run();
        const empty = tx.select({ id: events.id }).from(events).where(and(lte(events.createdAt, cutoff),
          notExists(tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.eventId, events.id)))))
          .orderBy(asc(events.createdAt)).limit(input.limit).all();
        for (const row of empty) { retainReceipt(row.id); tx.delete(events).where(eq(events.id, row.id)).run(); }
      }, { behavior: "immediate" });
    },
    heartbeat(timestamp) {
      database.insert(dispatcher).values({ id: 1, heartbeatAt: timestamp }).onConflictDoUpdate({ target: dispatcher.id, set: { heartbeatAt: timestamp } }).run();
    },
    lastHeartbeat() {
      return database.select().from(dispatcher).where(eq(dispatcher.id, 1)).get()?.heartbeatAt ?? null;
    },
  };
}
