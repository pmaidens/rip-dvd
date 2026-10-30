import { authorizeBrowserRendition } from "../../lib/server/browser-rendition-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request) {
  const denied = authorizeBrowserRendition(request);
  if (denied) return denied;
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Browser playback access</title><h1>Signed in for browser playback</h1><p>You can close this tab and return to Encoding.</p></html>', { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
