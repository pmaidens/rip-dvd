import {
  inspectOperationsWithArtifacts,
  isOperationKind,
  validOperationLimit,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function createOperationsResponse(
  access: DataAccess,
  request: Request,
  originalsLibraryPath?: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  const id = params.get("id") ?? undefined;
  const limitText = params.get("limit");
  const limit = limitText === null ? undefined : Number(limitText);
  const offsetText = params.get("offset");
  const offset = offsetText === null ? undefined : Number(offsetText);
  if (kind === null || !isOperationKind(kind) ||
    (id !== undefined && (id.length === 0 || id.length > 256)) ||
    (limit !== undefined && !validOperationLimit(limit)) ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 ||
      kind !== "encode-jobs" || id === undefined)) ||
    (id !== undefined && limit !== undefined && kind !== "encode-jobs") ||
    (id !== undefined && kind === "activity")) {
    return Response.json({ error: { code: "INVALID_ARGUMENTS" } }, {
      status: 400, headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const result = await inspectOperationsWithArtifacts(access, kind, {
      id,
      limit,
      offset,
      originalsLibraryPath,
    });
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

export async function GET(request: Request): Promise<Response> {
  try {
    return await createOperationsResponse(
      getDataAccess(),
      request,
      loadConfig().originalsLibraryPath,
    );
  } catch {
    return Response.json({ error: { code: "INSPECTION_UNAVAILABLE" } }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
