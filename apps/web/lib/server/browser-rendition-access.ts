import { createHash, timingSafeEqual } from "node:crypto";
import { browserRenditionConfig } from "@rip-dvd/config";
import { BrowserRenditionRejectedError, InvalidBrowserRenditionInputError, InvalidEncodeOutputArtifactIdentityError, InvalidMutationKeyError } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError } from "@rip-dvd/data-access";

export type RenditionAccessConfig = ReturnType<typeof browserRenditionConfig>;
export function renditionResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function authorizeBrowserRendition(request: Request, config = browserRenditionConfig()): Response | null {
  if (!config.enabled || config.password === null) return renditionResponse({ error: { code: "BROWSER_RENDITIONS_DISABLED", message: "Browser Viewing Renditions require enabled authenticated access." } }, 503);
  const received = request.headers.get("Authorization") ?? "";
  const expected = `Basic ${Buffer.from(`operator:${config.password}`, "utf8").toString("base64")}`;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(received), hash(expected))) return new Response(null, { status: 401, headers: {
    "WWW-Authenticate": 'Basic realm="Browser Viewing Renditions", charset="UTF-8"', "Cache-Control": "no-store",
  } });
  return null;
}
export function renditionError(error: unknown) {
  if (error instanceof InvalidBrowserRenditionInputError || error instanceof InvalidEncodeOutputArtifactIdentityError || error instanceof InvalidMutationKeyError) return renditionResponse({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
  if (error instanceof MutationKeyConflictError) return renditionResponse({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
  if (error instanceof BrowserRenditionRejectedError) return renditionResponse({ error: { code: error.code, message: error.message, current: error.current } }, 409);
  if (error instanceof RecordNotFoundError) return renditionResponse({ error: { code: "NOT_FOUND", message: "Encode Output or Browser Viewing Rendition not found." } }, 404);
  return renditionResponse({ error: { code: "BROWSER_RENDITION_UNAVAILABLE", message: "Browser Viewing Rendition operation is unavailable." } }, 503);
}
