/** Archive Jobs are execution history and are no longer a mutation surface. */
export const dynamic = "force-dynamic";

export async function createArchiveJobsRoute(
  request: Request,
  _getAccess?: () => unknown,
  _getTrustedOrigin?: () => string,
): Promise<Response> {
  return Response.json(
    {
      error: request.method === "POST"
        ? "Create an Archive Request instead"
        : "Method not allowed",
    },
    {
      status: request.method === "POST" ? 410 : 405,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function POST(request: Request): Promise<Response> {
  return createArchiveJobsRoute(request);
}
