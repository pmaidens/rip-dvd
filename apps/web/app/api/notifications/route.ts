import { createApplicationOperations, InvalidMutationKeyError, InvalidNotificationInputError, NotificationsUnavailableError } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../lib/server/trusted-mutation-request";
import { noStoreJsonResponse } from "../../../lib/server/trusted-mutation-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function handleNotifications(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  try {
    if (request.method !== "GET") {
      const problem = trustedMutationRequestProblem(request, getOrigin());
      if (problem) return problem;
    }
    const operations = createApplicationOperations(getAccess());
    const parameters = new URL(request.url).searchParams;
    let result: unknown;
    if (request.method === "GET") {
      const action = parameters.get("action") ?? "status";
      const limit = parameters.has("limit") ? Number(parameters.get("limit")) : undefined;
      if (action === "status") result = operations.notificationStatus();
      else if (action === "subscriptions") result = operations.notificationSubscriptions({ id: parameters.get("id") ?? undefined, limit });
      else if (action === "deliveries") result = operations.notificationDeliveries({ eventId: parameters.get("eventId") ?? undefined, limit });
      else throw new InvalidNotificationInputError();
    } else {
      const body: unknown = await request.json().catch(() => null);
      if (request.method === "DELETE") result = operations.removeNotificationSubscription(body);
      else if (request.method === "POST" && parameters.get("action") === "test") result = operations.submitTestNotification(body);
      else if (request.method === "POST" && !parameters.has("action")) result = operations.registerNotificationSubscription(body);
      else throw new InvalidNotificationInputError();
    }
    return noStoreJsonResponse(result);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) return noStoreJsonResponse({ error: { code: "INVALID_MUTATION_KEY", message: error.message } }, 400);
    if (error instanceof InvalidNotificationInputError) return noStoreJsonResponse({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    if (error instanceof MutationKeyConflictError) return noStoreJsonResponse({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    if (error instanceof RecordNotFoundError) return noStoreJsonResponse({ error: { code: "NOT_FOUND", message: "Notification subscription not found." } }, 404);
    return noStoreJsonResponse({ error: { code: "NOTIFICATIONS_UNAVAILABLE", message: error instanceof NotificationsUnavailableError ? error.message : "Notifications are unavailable." } }, 503);
  }
}

export function GET(request: Request): Promise<Response> { return handleNotifications(request); }
export function POST(request: Request): Promise<Response> { return handleNotifications(request); }
export function DELETE(request: Request): Promise<Response> { return handleNotifications(request); }
