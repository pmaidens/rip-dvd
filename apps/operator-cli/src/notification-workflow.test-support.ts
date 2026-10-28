import { createECDH } from "node:crypto";
import { expect, vi } from "vitest";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function notificationWorkflow(fixture: ReturnType<typeof createOperatorWorkflowFixture>) {
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.alloc(32, 1));
  vi.stubEnv("RIP_DVD_WEB_TRUSTED_ORIGIN", "https://operator.example");
  vi.stubEnv("RIP_DVD_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("RIP_DVD_VAPID_SUBJECT", "mailto:operator@example.com");
  async function register(browser: string) {
    const result = await fixture.run(["notifications", "register", "--key", `synthetic-register-${browser}`, "--json", JSON.stringify({
      enable: true,
      subscription: { endpoint: `https://web.push.apple.com/synthetic-${browser}`, expirationTime: null,
        keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } },
    })]);
    expect(result.exitCode).toBe(0);
    return (result.result as { subscription: { id: string } }).subscription;
  }
  await register("first");
  await register("second");
  return { fixture, register };
}

