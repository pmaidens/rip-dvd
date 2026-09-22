import { inspectOperations, isOperationKind, validOperationLimit } from "@rip-dvd/application";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function createOperationsResponse(access: DataAccess, request: Request): Response {
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  const id = params.get("id") ?? undefined;
  const limitText = params.get("limit");
  const limit = limitText === null ? undefined : Number(limitText);
  if (kind === null || !isOperationKind(kind) ||
    (id !== undefined && (id.length === 0 || id.length > 256)) ||
    (limit !== undefined && !validOperationLimit(limit)) ||
    (id !== undefined && limit !== undefined) ||
    (id !== undefined && kind === "activity")) {
    return Response.json({ error: { code: "INVALID_ARGUMENTS" } }, {
      status: 400, headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const result = inspectOperations(access, kind, { id, limit });
    if ("item" in result && result.item === null) {
      return Response.json({ error: { code: "NOT_FOUND" } }, {
        status: 404, headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: { code: "INSPECTION_UNAVAILABLE" } }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}

export function GET(request: Request): Response {
  try {
    return createOperationsResponse(getDataAccess(), request);
  } catch {
    return Response.json({ error: { code: "INSPECTION_UNAVAILABLE" } }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
