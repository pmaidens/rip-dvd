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
