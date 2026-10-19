import { createECDH } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Synthetic keys only. This server never contacts a push provider.
const key = createECDH("prime256v1");
key.setPrivateKey(Buffer.alloc(32, 1));
process.env.RIP_DVD_VAPID_PUBLIC_KEY = key.getPublicKey().toString("base64url");
process.env.RIP_DVD_VAPID_PRIVATE_KEY = key.getPrivateKey().toString("base64url");
process.env.RIP_DVD_VAPID_SUBJECT = "mailto:operator@example.com";
// The first server seeds the shared browser-only fixture before this one opens it.
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (await fetch("http://127.0.0.1:3100/api/health").then((response) => response.ok).catch(() => false)) break;
  await setTimeout(500);
}
await import("./start-catalog-review-server.mjs");
