import { normalizeHttpOrigin } from "@rip-dvd/config";

function problem(body: { error: string }, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function trustedMutationRequestProblem(
  request: Request,
  trustedOrigin: string,
): Response | null {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return problem({ error: "JSON content type required" }, 415);
  }

  const canonicalTrustedOrigin = normalizeHttpOrigin(trustedOrigin);
  const requestOrigin = request.headers.get("Origin");
  const host = request.headers.get("Host")?.trim().toLowerCase();
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (
    canonicalTrustedOrigin === null ||
    requestOrigin === null ||
    normalizeHttpOrigin(requestOrigin) !== canonicalTrustedOrigin ||
    host === undefined ||
    host !== new URL(canonicalTrustedOrigin).host.toLowerCase() ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return problem({ error: "Cross-origin mutation rejected" }, 403);
  }

  return null;
}
