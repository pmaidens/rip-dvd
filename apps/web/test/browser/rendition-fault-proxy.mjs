import { createServer, request as upstreamRequest } from "node:http";

if (process.env.RIP_DVD_RENDITION_BROWSER_GATE !== "true") {
  throw new Error("The synthetic rendition fault proxy requires the explicit browser gate.");
}
const upstream = new URL(process.env.RIP_DVD_RENDITION_BROWSER_UPSTREAM ?? "http://127.0.0.1:3112");
if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname) || upstream.username || upstream.password) {
  throw new Error("The synthetic rendition upstream must be a local HTTP server.");
}
const authorization = `Basic ${Buffer.from("operator:synthetic-browser-password").toString("base64")}`;
const faults = new Map();
function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
const server = createServer(async (incoming, outgoing) => {
  const path = new URL(incoming.url, "http://localhost").pathname;
  if (path === "/__rendition-browser-fault/health") return json(outgoing, { ready: true });
  const control = /^\/__rendition-browser-fault\/([a-f0-9-]{36})$/.exec(path);
  if (control) {
    if (incoming.headers.authorization !== authorization) {
      outgoing.writeHead(401, { "WWW-Authenticate": 'Basic realm="Synthetic rendition fixture"', "Cache-Control": "no-store" });
      return outgoing.end();
    }
    const id = control[1];
    if (incoming.method === "GET") return json(outgoing, faults.get(id) ?? { failMedia: false, injectedResponses: 0 });
    if (incoming.method !== "POST") return json(outgoing, { error: "Unsupported fixture operation" }, 405);
    try {
      let text = "";
      for await (const chunk of incoming) {
        text += chunk;
        if (text.length > 1024) return json(outgoing, { error: "Fixture input too large" }, 413);
      }
      const input = JSON.parse(text);
      if (typeof input.failMedia !== "boolean" || Object.keys(input).some((key) => key !== "failMedia")) {
        return json(outgoing, { error: "Invalid fixture input" }, 400);
      }
      faults.set(id, { failMedia: input.failMedia, injectedResponses: 0 });
      return json(outgoing, { accepted: true });
    } catch { return json(outgoing, { error: "Invalid fixture input" }, 400); }
  }
  const media = /^\/api\/browser-renditions\/([a-f0-9-]{36})\/media$/.exec(path);
  const fault = media && faults.get(media[1]);
  const failMedia = fault?.failMedia === true && ["GET", "HEAD"].includes(incoming.method);
  // The real endpoint authorizes and checks media identity before fault injection.
  const forwarded = upstreamRequest({
    hostname: upstream.hostname, port: upstream.port,
    path: incoming.url, method: failMedia ? "HEAD" : incoming.method,
    headers: { ...incoming.headers, connection: "close" },
  }, (response) => {
    if (failMedia && response.statusCode === 200) {
      response.resume();
      fault.injectedResponses += 1;
      outgoing.writeHead(416, { "Content-Range": "bytes */0", "Content-Length": "0", "Content-Type": "video/mp4", "Cache-Control": "no-store" });
      outgoing.end();
    } else {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    }
  });
  forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
  outgoing.on("close", () => { if (!outgoing.writableFinished) forwarded.destroy(); });
  if (failMedia) { incoming.resume(); forwarded.end(); }
  else incoming.pipe(forwarded);
});
server.listen(Number(process.env.PORT ?? 3113), process.env.HOSTNAME ?? "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(); server.closeAllConnections();
});
