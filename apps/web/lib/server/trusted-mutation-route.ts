import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
} from "@rip-dvd/data-access";

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
