import { createECDH } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { createServer, request } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

// A test-only proxy changes worker bytes while the production app stays open.
const workerOverride = resolve("test-results/notification-worker-override.js");
const workerRequests = resolve("test-results/notification-worker-requests.log");
const publicPort = Number(process.env.PORT);
process.env.PORT = String(publicPort + 1);
createServer((incoming, response) => {
  if (incoming.url === "/sw.js") {
    appendFileSync(workerRequests, "check\n");
    try {
      const script = readFileSync(workerOverride, "utf8");
      response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache, max-age=0, must-revalidate", "Service-Worker-Allowed": "/" });
      response.end(script);
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const upstream = request({ hostname: "127.0.0.1", port: publicPort + 1, path: incoming.url,
    method: incoming.method, headers: incoming.headers }, (result) => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => { response.writeHead(502); response.end(); });
  incoming.pipe(upstream);
}).listen(publicPort, "127.0.0.1");

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
