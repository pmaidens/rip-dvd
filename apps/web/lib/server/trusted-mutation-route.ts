import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
} from "@rip-dvd/data-access";
import { InvalidMutationKeyError, parseMutationKey } from "@rip-dvd/application";

import { trustedMutationRequestProblem } from "./trusted-mutation-request";

export function noStoreJsonResponse(
  body: unknown,
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function requiredMutationKey(request: Request): Promise<string | Response> {
  const body = await request.json().catch(() => null) as unknown;
  const value = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).mutationKey : undefined;
  try {
    return parseMutationKey(value);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      return noStoreJsonResponse({ error: {
        code: "INVALID_MUTATION_KEY", message: error.message,
      } }, 400);
    }
    throw error;
  }
}

export function recoveryMutationResponse(
  mutate: () => unknown,
  status = 200,
): Response {
  try {
    return noStoreJsonResponse(mutate(), status);
  } catch (error) {
    if (error instanceof MutationKeyConflictError) {
      return noStoreJsonResponse({ error: {
        code: "MUTATION_KEY_CONFLICT", message: error.message,
      } }, 409);
    }
    if (error instanceof InvalidStatusTransitionError || error instanceof DomainInvariantError) {
      return noStoreJsonResponse({ error: {
        code: "ACTION_BLOCKED", message: error.message,
        blockingReasons: [{ code: "INVALID_TRANSITION", message: error.message }],
      } }, 409);
    }
    throw error;
  }
}

interface TrustedMutationRouteOptions {
  getTrustedOrigin(): string;
  method: "DELETE" | "POST";
  notFoundError: string;
  unavailableError: string;
}

export async function runTrustedMutationRoute(
  request: Request,
  options: TrustedMutationRouteOptions,
  mutate: () => Promise<Response> | Response,
): Promise<Response> {
  if (request.method !== options.method) {
    return noStoreJsonResponse({ error: "Method not allowed" }, 405);
  }

  let trustedOrigin: string;
  try {
    trustedOrigin = options.getTrustedOrigin();
  } catch {
    return noStoreJsonResponse({ error: options.unavailableError }, 503);
  }

  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }

  try {
    return await mutate();
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return noStoreJsonResponse({ error: options.notFoundError }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return noStoreJsonResponse({ error: error.message }, 409);
    }
    return noStoreJsonResponse({ error: options.unavailableError }, 503);
  }
}
