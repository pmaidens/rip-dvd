import { afterEach, expect, it, vi } from "vitest";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { createECDH } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Agent } from "node:https";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import type { TLSSocket } from "node:tls";
import { drizzle } from "drizzle-orm/node-sqlite";
import { sql } from "drizzle-orm";
import { createNotificationEventWriter } from "@rip-dvd/data-access";
import { createWebPushSender, dispatchNotifications, readNotificationConfiguration, recordNotificationOutcome } from "@rip-dvd/application";


const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

it("discovers notification administration and reports configuration without secrets", async () => {
  vi.stubEnv("RIP_DVD_WEB_TRUSTED_ORIGIN", "https://operator.example");
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  expect((await fixture.run(["commands"])).stdout).toContain('"notifications"');
  const status = await fixture.run(["notifications", "status"]);
  expect(status.exitCode).toBe(0);
  expect(status.result).toMatchObject({ schemaVersion: 1, configured: false, reason: "missing_configuration" });
  expect(status.stdout).not.toContain("privateKey");
});


function configure() {
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.alloc(32, 1));
  vi.stubEnv("RIP_DVD_WEB_TRUSTED_ORIGIN", "https://operator.example");
  vi.stubEnv("RIP_DVD_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_SUBJECT", "mailto:operator@example.com");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  return { fixture, subscription: { endpoint: "https://web.push.apple.com/synthetic-browser-a", expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } } };
}

async function register(fixture: ReturnType<typeof createOperatorWorkflowFixture>, subscription: unknown, key: string, enable = true) {
  const result = await fixture.run(["notifications", "register", "--key", key, "--json", JSON.stringify({ subscription, enable })]);
  expect(result.exitCode).toBe(0);
  return (result.result as { subscription: { id: string; active: boolean } }).subscription;
}

it("queues once, survives process restart, and reports provider acceptance without exposing subscription secrets", async () => {
  const { fixture, subscription } = configure();
  const registered = await register(fixture, subscription, "synthetic-register-a");
  expect(registered.active).toBe(true);
  const submitted = await fixture.run(["notifications", "test", "--key", "synthetic-test-a"]);
  expect(submitted.exitCode).toBe(0);
  expect((await fixture.run(["notifications", "test", "--key", "synthetic-test-a"])).result).toEqual(submitted.result);
  const before = await fixture.run(["notifications", "deliveries"]);
  expect(before.result).toMatchObject({ deliveries: [{ status: "queued", subscriptionId: registered.id }] });
  // Start a fresh process with the same SQLite file and one controlled sender.
  const app = pathToFileURL(resolve("../../packages/application/dist/index.js")).href;
  const data = pathToFileURL(resolve("../../packages/data-access/dist/index.js")).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createDataAccess } from ${JSON.stringify(data)};
    import { dispatchNotifications } from ${JSON.stringify(app)};
    const access = createDataAccess({ databasePath: process.argv[1] });
    const sent = [];
    await dispatchNotifications(access, async (_subscription, payload) => { sent.push(payload); });
    access.close();
    console.log(JSON.stringify(sent));
  `, fixture.databasePath], { encoding: "utf8" });
  expect(JSON.parse(output)).toMatchObject([{ version: 1, title: "Rip DVD test", destination: "/notifications", tag: expect.stringMatching(/^rip-dvd-/) }]);
  const after = await fixture.run(["notifications", "deliveries"]);
  expect(after.result).toMatchObject({ deliveries: [{ status: "accepted", failureCode: null }] });
  const inspected = await fixture.run(["notifications", "subscriptions"]);
  for (const sensitive of [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]) expect(inspected.stdout + after.stdout).not.toContain(sensitive);
  const access = fixture.openAccess();
  try { expect(await dispatchNotifications(access, async () => { throw new Error("must not resend"); })).toEqual({ accepted: 0, failed: 0 }); }
  finally { access.close(); }
});

it("does not replay historical events to new or re-enabled browsers and keeps reconciliation opted out", async () => {
  const { fixture, subscription } = configure();
  await fixture.run(["notifications", "test", "--key", "synthetic-no-recipients"]);
  const first = await register(fixture, subscription, "synthetic-register-b");
  await fixture.run(["notifications", "test", "--key", "synthetic-before-disable"]);
  const removed = await fixture.run(["notifications", "remove", "--key", "synthetic-remove-b", "--id", first.id]);
  expect(removed.result).toMatchObject({ subscription: { active: false } });
  expect(await register(fixture, subscription, "synthetic-reconcile-b", false)).toMatchObject({ active: false });
  await register(fixture, subscription, "synthetic-reenable-b");
  await register(fixture, { ...subscription, endpoint: "https://fcm.googleapis.com/synthetic-browser-c" }, "synthetic-register-c");
  const sent: unknown[] = [];
  const access = fixture.openAccess();
  try {
    expect(await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); })).toEqual({ accepted: 0, failed: 0 });
    await fixture.run(["notifications", "test", "--key", "synthetic-after-enable"]);
    expect(await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); })).toEqual({ accepted: 2, failed: 0 });
  } finally { access.close(); }
  expect(sent).toHaveLength(2);
});

it("records synthetic outcomes inside an existing outcome transaction, rolls back, and suppresses repeated logical work", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-register-transaction");
  const sqlite = new DatabaseSync(fixture.databasePath);
  const database = drizzle({ client: sqlite });
  sqlite.exec("CREATE TABLE synthetic_outcomes (id TEXT PRIMARY KEY)");
  const record = (id: string, rollback = false) => database.transaction((tx) => {
    tx.run(sql`INSERT OR IGNORE INTO synthetic_outcomes VALUES (${id})`);
    const event = recordNotificationOutcome(createNotificationEventWriter(tx, () => new Date()), {
      kind: "archive_saved", sourceEventId: id, archiveJobId: "synthetic-job", label: null, remainingSource: true,
    });
    if (rollback) throw new Error("synthetic rollback");
    return event;
  });
  try {
    expect(() => record("synthetic-rollback", true)).toThrow("synthetic rollback");
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    const committed = record("synthetic-commit");
    expect(record("synthetic-commit")).toEqual(committed);
    const access = fixture.openAccess();
    const sent: unknown[] = [];
    try { await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); }); }
    finally { access.close(); }
    expect(sent).toMatchObject([{ label: "Unlabelled disc", body: "Original Disc Archive saved. Source remains unrecovered; recovery may continue." }]);
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ eventId: committed.eventId, status: "accepted" }] });
  } finally { sqlite.close(); }
});

it("rejects unsafe destinations and malformed keys, bounds inspection, and enforces mutation conflicts", async () => {
  const { fixture, subscription } = configure();
  for (const endpoint of ["http://web.push.apple.com/synthetic", "https://127.0.0.1/synthetic", "https://web.push.apple.com.evil.example/synthetic", "https://web.push.apple.com:444/synthetic", "https://user:pass@web.push.apple.com/synthetic"]) {
    const rejected = await fixture.run(["notifications", "register", "--key", "synthetic-unsafe", "--json", JSON.stringify({ subscription: { ...subscription, endpoint }, enable: true })]);
    expect(rejected.result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    expect(rejected.stdout).not.toContain(endpoint);
  }
  await register(fixture, subscription, "synthetic-conflict");
  const conflict = await fixture.run(["notifications", "register", "--key", "synthetic-conflict", "--json", JSON.stringify({ subscription, enable: false })]);
  expect(conflict.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
  expect((await fixture.run(["notifications", "deliveries", "--limit", "101"])).result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
});

it("reclaims an interrupted bounded claim after restart and fences the previous owner", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-register-lease");
  await fixture.run(["notifications", "test", "--key", "synthetic-test-lease"]);
  const first = fixture.openAccess();
  const timestamp = new Date();
  const claim = first.notifications.claim({ now: timestamp, leaseMs: 1_000 })!;
  first.close();
  const second = fixture.openAccess();
  try {
    expect(await dispatchNotifications(second, async () => undefined, { now: () => timestamp })).toEqual({ accepted: 0, failed: 0 });
    expect(await dispatchNotifications(second, async () => undefined, { now: () => new Date(timestamp.getTime() + 1_001) })).toEqual({ accepted: 1, failed: 0 });
    expect(second.notifications.settle(claim, { status: "failed", failureCode: "sender_rejected" }, new Date())).toBeNull();
  } finally { second.close(); }
  expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "accepted" }] });
});

it("retains a throttled delivery across restart and honors provider retry guidance", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-throttle-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-throttle-test"]);
  const timestamp = new Date();
  const first = fixture.openAccess();
  const sent: unknown[] = [];
  try {
    await dispatchNotifications(first, async (_recipient, payload) => {
      sent.push(payload);
      throw { statusCode: 429, headers: { "retry-after": "120" }, body: subscription.endpoint };
    }, { now: () => timestamp });
  } finally { first.close(); }
  const inspected = await fixture.run(["notifications", "deliveries"]);
  expect(inspected.result).toMatchObject({ deliveries: [{ status: "retrying", failureCode: "throttled", attemptCount: 1,
    nextAttemptAt: new Date(timestamp.getTime() + 120_000).toISOString() }] });
  expect(inspected.stdout).not.toContain(subscription.endpoint);
  const restarted = fixture.openAccess();
  try {
    const send = async (_recipient: unknown, payload: unknown) => { sent.push(payload); };
    expect(await dispatchNotifications(restarted, send, { now: () => new Date(timestamp.getTime() + 119_999) })).toEqual({ accepted: 0, failed: 0 });
    expect(await dispatchNotifications(restarted, send, { now: () => new Date(timestamp.getTime() + 120_000) })).toEqual({ accepted: 1, failed: 0 });
  } finally { restarted.close(); }
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

it("expires stale queued messages after restart and bounds retries even after repeated crashes", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-bounded-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-bounded-test"]);
  let timestamp = new Date();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const access = fixture.openAccess();
    try {
      expect(access.notifications.claim({ now: timestamp, leaseMs: 1_000 })).toMatchObject({ attemptCount: attempt });
    } finally { access.close(); }
    timestamp = new Date(timestamp.getTime() + 1_001);
  }
  const access = fixture.openAccess();
  try {
    const send = async () => { throw new Error("Must not exceed attempt cap or send expired work"); };
    expect(await dispatchNotifications(access, send, { now: () => timestamp })).toEqual({ accepted: 0, failed: 0 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "failed", failureCode: "attempt_limit", attemptCount: 8 }] });
    await fixture.run(["notifications", "test", "--key", "synthetic-expired-test"]);
    expect(await dispatchNotifications(access, send, { now: () => new Date(timestamp.getTime() + 86_400_000) })).toEqual({ accepted: 0, failed: 0 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: expect.arrayContaining([
      expect.objectContaining({ status: "expired", failureCode: "message_expired", attemptCount: 0 }),
    ]) });
  } finally { access.close(); }
});

it("caps transient retries and respects HTTP-date guidance beyond the delivery lifetime", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-retry-cap-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-retry-cap-test"]);
  const timestamp = new Date();
  const access = fixture.openAccess();
  try {
    for (const offset of [0, 5_000, 15_000, 35_000, 75_000, 155_000, 315_000, 635_000]) {
      await dispatchNotifications(access, async () => { throw { statusCode: 503 }; }, { now: () => new Date(timestamp.getTime() + offset) });
    }
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "failed", attemptCount: 8, failureCode: "attempt_limit" }] });
    await fixture.run(["notifications", "test", "--key", "synthetic-guidance-expiry"]);
    await dispatchNotifications(access, async () => { throw { statusCode: 503, headers: { "retry-after": new Date(timestamp.getTime() + 172_800_000).toUTCString() } }; }, { now: () => timestamp });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: expect.arrayContaining([
      expect.objectContaining({ status: "expired", failureCode: "message_expired", attemptCount: 1 }),
    ]) });
  } finally { access.close(); }
});

it("prevents old retries after disable, cleanup, re-enable and repeated source processing", async () => {
  const { fixture, subscription } = configure();
  const browser = await register(fixture, subscription, "synthetic-cleanup-register");
  const source = { kind: "archive_failed" as const, sourceEventId: "synthetic-cleanup-source", archiveJobId: "synthetic-job" };
  const timestamp = new Date();
  const access = fixture.openAccess();
  try {
    const first = access.notifications.transaction((writer) => recordNotificationOutcome(writer, source));
    await dispatchNotifications(access, async () => { throw { code: "ECONNRESET" }; }, { now: () => timestamp });
    await fixture.run(["notifications", "remove", "--key", "synthetic-cleanup-disable", "--id", browser.id]);
    await register(fixture, subscription, "synthetic-cleanup-reenable");
    await register(fixture, { ...subscription, endpoint: "https://web.push.apple.com/synthetic-new-browser" }, "synthetic-cleanup-new-browser");
    await dispatchNotifications(access, async () => { throw new Error("Must not replay old recipients"); }, { now: () => new Date(timestamp.getTime() + 10_000) });
    access.notifications.maintain({ now: new Date(timestamp.getTime() + 8 * 86_400_000), limit: 1 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    expect(access.notifications.transaction((writer) => recordNotificationOutcome(writer, source))).toEqual(first);
    expect(() => access.notifications.transaction((writer) => recordNotificationOutcome(writer, { ...source, label: "Changed facts" }))).toThrow("conflicting facts");
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    await fixture.run(["notifications", "test", "--key", "synthetic-cleanup-future"]);
    expect(await dispatchNotifications(access, async () => undefined)).toEqual({ accepted: 2, failed: 0 });
  } finally { access.close(); }
});

it("bounds history deletion per pass and retains subscription opt-out", async () => {
  const { fixture, subscription } = configure();
  const browser = await register(fixture, subscription, "synthetic-retention-register");
  for (const key of ["synthetic-retention-first", "synthetic-retention-second", "synthetic-retention-third"]) {
    await fixture.run(["notifications", "test", "--key", key]);
  }
  const access = fixture.openAccess();
  const timestamp = new Date();
  try {
    await dispatchNotifications(access, async () => undefined, { now: () => timestamp });
    await fixture.run(["notifications", "remove", "--key", "synthetic-retention-disable", "--id", browser.id]);
    const later = new Date(timestamp.getTime() + 8 * 86_400_000);
    for (const remaining of [2, 1, 0]) {
      access.notifications.maintain({ now: later, limit: 1 });
      expect(((await fixture.run(["notifications", "deliveries"])).result as { deliveries: unknown[] }).deliveries).toHaveLength(remaining);
    }
    expect(await register(fixture, subscription, "synthetic-retention-reconcile", false)).toMatchObject({ active: false });
  } finally { access.close(); }
});

it("aborts an in-flight sender promptly and recovers the uncertain delivery after its lease", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-abort-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-abort-test"]);
  const access = fixture.openAccess();
  const controller = new AbortController();
  const timestamp = new Date();
  try {
    const running = dispatchNotifications(access, async (_recipient, _payload, options) => {
      expect(options.ttlSeconds).toBeGreaterThan(0);
      return new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        controller.abort();
      });
    }, { signal: controller.signal, now: () => timestamp });
    expect(await running).toEqual({ accepted: 0, failed: 0 });
    expect(await dispatchNotifications(access, async () => undefined, { now: () => timestamp })).toEqual({ accepted: 0, failed: 0 });
    expect(await dispatchNotifications(access, async () => undefined, { now: () => new Date(timestamp.getTime() + 30_001) })).toEqual({ accepted: 1, failed: 0 });
  } finally { access.close(); }
});

it("times out a silent sender and schedules bounded retry work", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-deadline-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-deadline-test"]);
  const timestamp = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(timestamp);
  const access = fixture.openAccess();
  try {
    const running = dispatchNotifications(access, async () => new Promise<void>(() => undefined));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toEqual({ accepted: 0, failed: 0 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "retrying", attemptCount: 1,
      failureCode: "timeout", nextAttemptAt: new Date(timestamp + 15_000).toISOString() }] });
  } finally { access.close(); }
});

it("deactivates locally expired subscriptions before sending", async () => {
  const { fixture, subscription } = configure();
  const timestamp = Date.now();
  await register(fixture, { ...subscription, expirationTime: timestamp + 60_000 }, "synthetic-expiration-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-expiration-test"]);
  const access = fixture.openAccess();
  try {
    expect(await dispatchNotifications(access, async () => { throw new Error("Must not send expired subscription"); }, {
      now: () => new Date(timestamp + 60_001),
    })).toEqual({ accepted: 0, failed: 1 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "failed", failureCode: "subscription_expired" }] });
    expect((await fixture.run(["notifications", "subscriptions"])).result).toMatchObject({ subscriptions: [{ active: false }] });
  } finally { access.close(); }
});

it("does not let an old in-flight expired-subscription response disable a re-enabled browser", async () => {
  const { fixture, subscription } = configure();
  const browser = await register(fixture, subscription, "synthetic-inflight-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-inflight-test"]);
  const access = fixture.openAccess();
  try {
    await dispatchNotifications(access, async () => {
      await fixture.run(["notifications", "remove", "--key", "synthetic-inflight-disable", "--id", browser.id]);
      await register(fixture, subscription, "synthetic-inflight-reenable");
      throw { statusCode: 410 };
    });
    expect((await fixture.run(["notifications", "subscriptions"])).result).toMatchObject({ subscriptions: [{ active: true, generation: 2 }] });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "failed", failureCode: "subscription_disabled", nextAttemptAt: null }] });
    await fixture.run(["notifications", "test", "--key", "synthetic-inflight-future"]);
    expect(await dispatchNotifications(access, async () => undefined)).toEqual({ accepted: 1, failed: 0 });
  } finally { access.close(); }
});

it.each(["alone", "with competing maintenance"])("invalidates a definitively expired subscription when the message expires during sending %s", async (mode) => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-expiry-race-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-expiry-race-test"]);
  const access = fixture.openAccess();
  const competing = fixture.openAccess();
  try {
    const expiry = access.notifications.deliveries({ limit: 1 })[0]!.expiresAt;
    let timestamp = new Date(expiry.getTime() - 1);
    await dispatchNotifications(access, async () => {
      timestamp = new Date(expiry.getTime() + 1);
      if (mode === "with competing maintenance") {
        expect(await dispatchNotifications(competing, async () => { throw new Error("Must not send expired messages"); }, { now: () => timestamp })).toEqual({ accepted: 0, failed: 0 });
      }
      throw { statusCode: 410 };
    }, { now: () => timestamp });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [{ status: "expired", failureCode: "message_expired" }] });
    expect((await fixture.run(["notifications", "subscriptions"])).result).toMatchObject({ subscriptions: [{ active: false }] });
  } finally { competing.close(); access.close(); }
});

it.each(["shutdown", "deadline"] as const)("closes the maintained push sender's active connection on %s", async (reason) => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-network-abort-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-network-abort-test"]);
  let started!: () => void;
  let closed!: () => void;
  const responseStarted = new Promise<void>((resolve) => { started = resolve; });
  const responseClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(201);
    response.write("Synthetic unfinished provider response");
    response.on("close", closed);
    started();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected controlled provider port");
  // Redirect only the external socket boundary. Exercise real Web Push encryption and sending.
  const connection = vi.spyOn(Agent.prototype, "createConnection").mockImplementation(() => connect({ host: "127.0.0.1", port: address.port }) as TLSSocket);
  const configuration = readNotificationConfiguration();
  if (!configuration.ready) throw new Error("Expected synthetic push configuration");
  const controller = new AbortController();
  const access = fixture.openAccess();
  try {
    if (reason === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = dispatchNotifications(access, createWebPushSender(configuration.configuration), { signal: controller.signal });
    await responseStarted;
    if (reason === "shutdown") controller.abort();
    else await vi.advanceTimersByTimeAsync(10_000);
    await running;
    vi.useRealTimers();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([responseClosed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Push connection remained open after cancellation")), 1_000); })]);
    } finally { clearTimeout(timeout); }
  } finally {
    vi.useRealTimers();
    connection.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    access.close();
  }
});

it("uses one formatter for the agreed recovery facts without changing domain lifecycles", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-register-recovery");
  const access = fixture.openAccess();
  const sent: { body: string; destination: string; tag: string }[] = [];
  try {
    access.notifications.transaction((writer) => {
      recordNotificationOutcome(writer, { kind: "archive_failed", sourceEventId: "synthetic-failure", archiveJobId: "synthetic-job", label: "Synthetic disc" });
      recordNotificationOutcome(writer, { kind: "recovery_completed", sourceEventId: "synthetic-completed", originalDiscArchiveId: "synthetic-archive" });
      recordNotificationOutcome(writer, { kind: "recovery_attention", sourceEventId: "synthetic-attention", originalDiscArchiveId: "synthetic-archive" });
      recordNotificationOutcome(writer, { kind: "recovery_stopped", sourceEventId: "synthetic-stopped", originalDiscArchiveId: "synthetic-archive", remainingSource: true });
    });
    await dispatchNotifications(access, async (_recipient, payload) => { sent.push(payload); });
  } finally { access.close(); }
  expect(sent.map(({ body }) => body)).toEqual(expect.arrayContaining([
    "Archive Job failed. Inspect the attempt for details.",
    "Archive Recovery completed. All remaining source recovered.",
    "Archive Recovery needs attention. Inspect the recovery for details.",
    "Archive Recovery stopped. Source remains unrecovered.",
  ]));
  expect(new Set(sent.map(({ tag }) => tag)).size).toBe(4);
  expect(sent.every(({ destination }) => destination.startsWith("/"))).toBe(true);
});

it("stops claiming on shutdown and leaves remaining work durable", async () => {
  const { fixture, subscription } = configure();
  await register(fixture, subscription, "synthetic-shutdown-register");
  await fixture.run(["notifications", "test", "--key", "synthetic-shutdown-first"]);
  await fixture.run(["notifications", "test", "--key", "synthetic-shutdown-next"]);
  const access = fixture.openAccess();
  const controller = new AbortController();
  try {
    expect(await dispatchNotifications(access, async () => { controller.abort(); }, { signal: controller.signal })).toEqual({ accepted: 1, failed: 0 });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: expect.arrayContaining([
      expect.objectContaining({ status: "accepted" }), expect.objectContaining({ status: "queued" }),
    ]) });
    expect(await dispatchNotifications(access, async () => undefined)).toEqual({ accepted: 1, failed: 0 });
  } finally { access.close(); }
});

it("replays committed registrations and tests after expiry or configuration changes, while checking new mutations", async () => {
  const { fixture, subscription } = configure();
  const expirationTime = Date.now() + 60_000;
  const expiring = { ...subscription, expirationTime };
  const first = await register(fixture, expiring, "synthetic-expiring-registration");
  const submitted = await fixture.run(["notifications", "test", "--key", "synthetic-config-replay"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(expirationTime + 1);
  const replayArgs = ["notifications", "register", "--key", "synthetic-expiring-registration", "--json", JSON.stringify({ subscription: expiring, enable: true })];
  expect((await fixture.run(replayArgs)).result).toMatchObject({ subscription: first });
  expect((await fixture.run(["notifications", "register", "--key", "synthetic-expired-new", "--json", JSON.stringify({ subscription: expiring, enable: true })])).result)
    .toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  vi.stubEnv("RIP_DVD_VAPID_PRIVATE_KEY", "");
  expect((await fixture.run(replayArgs)).result).toMatchObject({ subscription: first });
  expect((await fixture.run(["notifications", "test", "--key", "synthetic-config-replay"])).result).toEqual(submitted.result);
  expect((await fixture.run(["notifications", "test", "--key", "synthetic-config-new"])).result).toMatchObject({ error: { code: "NOTIFICATIONS_UNAVAILABLE" } });
  expect((await fixture.run(["notifications", "register", "--key", "synthetic-expiring-registration", "--json", JSON.stringify({ subscription: expiring, enable: false })])).result)
    .toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});
