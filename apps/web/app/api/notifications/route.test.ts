import { beginSettledDiscInspectionForTest } from "@rip-dvd/data-access/test-support";
import { dispatchNotifications } from "@rip-dvd/application";
import { createOperationsResponse } from "../operations/route";
import { createECDH } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../operator-cli/src/operator-workflow.test-support.js";
import { handleNotifications } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.unstubAllEnvs(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

it("keeps direct JSON CLI and HTTP notification operations equivalent with real persistence", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.alloc(32, 1));
  vi.stubEnv("RIP_DVD_WEB_TRUSTED_ORIGIN", "https://operator.example");
  vi.stubEnv("RIP_DVD_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_SUBJECT", "mailto:operator@example.com");
  const access = fixture.openAccess();
  const request = (action: string, method = "GET", body?: unknown, origin = "https://operator.example") => handleNotifications(
    new Request(`https://operator.example/api/notifications${action ? `?action=${action}` : ""}`, {
      method, headers: { Host: "operator.example", Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }), () => access, () => "https://operator.example",
  );
  try {
    expect(await (await request("status")).json()).toEqual((await fixture.run(["notifications", "status"])).result);
    const subscription = { endpoint: "https://web.push.apple.com/synthetic-http", expirationTime: null,
      keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } };
    const input = { subscription, enable: true, mutationKey: "synthetic-http-register" };
    const registered = await (await request("", "POST", input)).json();
    expect(registered).toEqual((await fixture.run(["notifications", "register", "--key", input.mutationKey, "--json", JSON.stringify(input)])).result);
    const event = await (await request("test", "POST", { mutationKey: "synthetic-http-test" })).json();
    expect(event).toEqual((await fixture.run(["notifications", "test", "--key", "synthetic-http-test"])).result);
    expect(await (await request("deliveries")).json()).toEqual((await fixture.run(["notifications", "deliveries"])).result);
    const timestamp = new Date();
    await dispatchNotifications(access, async () => { throw { statusCode: 429, headers: { "retry-after": "60" }, body: "Sensitive provider detail" }; }, { now: () => timestamp });
    const retrying = await (await request("deliveries")).json();
    expect(retrying).toMatchObject({ deliveries: [{ status: "retrying", failureCode: "throttled", attemptCount: 1,
      nextAttemptAt: new Date(timestamp.getTime() + 60_000).toISOString() }] });
    expect(retrying).toEqual((await fixture.run(["notifications", "deliveries"])).result);
    await dispatchNotifications(access, async () => undefined, { now: () => new Date(timestamp.getTime() + 60_000) });
    const accepted = await (await request("deliveries")).json();
    expect(accepted).toMatchObject({ deliveries: [{ status: "accepted", failureCode: null, attemptCount: 2, nextAttemptAt: null }] });
    expect(accepted).toEqual((await fixture.run(["notifications", "deliveries"])).result);
    expect(await (await request("subscriptions")).json()).toEqual((await fixture.run(["notifications", "subscriptions"])).result);
    const remove = { mutationKey: "synthetic-http-remove", subscriptionId: registered.subscription.id };
    expect(await (await request("", "DELETE", remove)).json()).toEqual((await fixture.run(["notifications", "remove", "--key", remove.mutationKey, "--id", remove.subscriptionId])).result);
    expect((await request("", "POST", { ...input, enable: false })).status).toBe(409);
    expect((await request("", "POST", input, "https://outside.example")).status).toBe(403);
    expect((await request("", "POST", { ...input, mutationKey: "synthetic-invalid", subscription: { ...subscription, endpoint: "https://127.0.0.1/private" } })).status).toBe(400);
    const nonJson = await handleNotifications(new Request("https://operator.example/api/notifications", { method: "POST", headers: { Host: "operator.example", Origin: "https://operator.example", "Content-Type": "text/plain" }, body: "{}" }), () => access, () => "https://operator.example");
    expect(nonJson.status).toBe(415);
  } finally { access.close(); }
});


it("shows a labeled Archive Job notification target through both CLI and HTTP detail", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const access = fixture.openAccess();
  try {
    access.notifications.register({ mutationKey: "synthetic-outcome-parity", enable: true,
      subscription: { endpoint: "https://web.push.apple.com/synthetic-parity", expirationTime: null,
        keys: { p256dh: "synthetic-key", auth: "synthetic-auth" } } });
    const drive = access.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-notification-drive", isEnabled: true, isPresent: true });
    const disc = access.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-notification-target", volumeLabel: "Synthetic labeled disc" });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const settled = beginSettledDiscInspectionForTest(access, { opticalDriveId: drive.id, mediaGeneration: "synthetic-notification-target", mediaCapacityBytes: 2048 });
    const inspection = access.discInspections.record(settled.claim, { type: "complete", detectedDiscId: disc.id });
    settled.restoreSystemTime();
    const job = access.archiveJobs.startForInspection(inspection.id, "synthetic-notification-worker")!;
    access.archiveJobs.fail(job, "Synthetic navigation outcome");
    const deliveries = await fixture.run(["notifications", "deliveries"]);
    expect(deliveries.result).toMatchObject({ deliveries: [{ status: "queued" }] });
    const httpDeliveries = await handleNotifications(new Request("https://operator.example/api/notifications?action=deliveries"), () => access);
    expect(await httpDeliveries.json()).toEqual(deliveries.result);
    const cli = await fixture.run(["inspect", "archive-jobs", job.id]);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toMatchObject({ item: { detectedDisc: { volumeLabel: "Synthetic labeled disc" } } });
    const http = await createOperationsResponse(access, new Request(`https://operator.example/api/operations?kind=archive-jobs&id=${job.id}`));
    expect(await http.json()).toEqual(cli.result);
  } finally { access.close(); }
});
