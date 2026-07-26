import type {
  DataAccess,
  EncodingProfileId,
} from "@rip-dvd/data-access";
import {
  DomainInvariantError,
  RecordNotFoundError,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  toEncodingProfileDto,
  type DvdVideoEncodingSettings,
} from "../../../lib/encoding-profiles";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function mutationRequestProblem(request: Request): Response | null {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return response({ error: "JSON content type required" }, 415);
  }

  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (
    (origin !== null && origin !== requestOrigin) ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return response({ error: "Cross-origin mutation rejected" }, 403);
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseDvdVideoSettings(
  value: unknown,
): DvdVideoEncodingSettings | null {
  const settings = asRecord(value);
  const preset = requiredString(settings?.preset);
  if (!settings || !preset || settings.container !== "mkv") {
    return null;
  }
  return { preset, container: "mkv" };
}

export async function createEncodingProfilesRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Promise<Response> {
  try {
    if (request.method === "GET") {
      const access = getAccess();
      return response({
        profiles: access.encodingProfiles
          .list({ mediaDomain: "dvd_video" })
          .map(toEncodingProfileDto),
      });
    }

    if (request.method === "POST") {
      const problem = mutationRequestProblem(request);
      if (problem) {
        return problem;
      }
      const access = getAccess();
      const body = asRecord(await request.json().catch(() => null));
      const sourceProfileId = requiredString(body?.sourceProfileId);
      const key = requiredString(body?.key);
      const displayName = requiredString(body?.displayName);
      const settings = parseDvdVideoSettings(body?.settings);
      if (!body || !settings) {
        return response({ error: "Invalid Encoding Profile" }, 400);
      }
      if (sourceProfileId) {
        const profile = access.encodingProfiles.createVersion({
          sourceProfileId: sourceProfileId as EncodingProfileId,
          mediaDomain: "dvd_video",
          settings,
        });
        return response({ profile: toEncodingProfileDto(profile) }, 201);
      }
      if (!key || !displayName) {
        return response({ error: "Invalid Encoding Profile" }, 400);
      }
      const profile = access.encodingProfiles.create({
        key,
        displayName,
        mediaDomain: "dvd_video",
        settings,
      });
      return response({ profile: toEncodingProfileDto(profile) }, 201);
    }

    if (request.method === "PATCH") {
      const problem = mutationRequestProblem(request);
      if (problem) {
        return problem;
      }
      const access = getAccess();
      const body = asRecord(await request.json().catch(() => null));
      const id = requiredString(body?.id);
      if (!body || !id || typeof body.isActive !== "boolean") {
        return response({ error: "Invalid Encoding Profile state" }, 400);
      }
      const profile = access.encodingProfiles.setActive({
        id: id as EncodingProfileId,
        mediaDomain: "dvd_video",
        isActive: body.isActive,
      });
      return response({ profile: toEncodingProfileDto(profile) });
    }

    return response({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      return response({ error: error.message }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Encoding Profile not found" }, 404);
    }
    return response({ error: "Encoding Profiles are unavailable" }, 503);
  }
}

export function GET(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}

export function POST(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}

export function PATCH(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}
