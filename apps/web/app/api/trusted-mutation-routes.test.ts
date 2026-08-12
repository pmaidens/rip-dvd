import type { DataAccess } from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import { createArchiveRequestCancellationRoute } from "./archive-requests/[id]/route";
import { createArchiveRequestRetryRoute } from "./archive-requests/[id]/retry/route";
import { createArchiveRequestsRoute } from "./archive-requests/route";
import { createCatalogReviewRoute } from "./catalog-reviews/[id]/route";
import { createDiscInspectionRetryRoute } from "./disc-inspections/[id]/retry/route";
import { createEncodeJobsRoute } from "./encode-jobs/route";
import { createEncodingProfilesRoute } from "./encoding-profiles/route";
import { createFilesystemVerificationRoute } from "./filesystem-verification/route";

type GetTrustedOrigin = () => string;

interface MutationRouteCase {
  method?: "DELETE" | "POST";
  name: string;
  path: string;
  unavailableError: string;
  run: (
    request: Request,
    getAccess: () => DataAccess,
    getTrustedOrigin: GetTrustedOrigin,
  ) => Promise<Response>;
}

interface RejectionCase {
  name: string;
  headers: Record<string, string>;
  expectedStatus: number;
  expectedError: string;
}

const mutationRoutes = [
  {
    name: "Archive Requests",
    path: "/api/archive-requests",
    unavailableError: "Archive Request creation is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createArchiveRequestsRoute(request, getAccess, getTrustedOrigin),
  },
  {
    method: "DELETE",
    name: "Archive Request cancellation",
    path: "/api/archive-requests/archive-request-id",
    unavailableError: "Archive Request cancellation is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createArchiveRequestCancellationRoute(
        request,
        "archive-request-id",
        getAccess,
        getTrustedOrigin,
      ),
  },
  {
    name: "Archive Request retry",
    path: "/api/archive-requests/archive-request-id/retry",
    unavailableError: "Archive Request retry is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createArchiveRequestRetryRoute(
        request,
        "archive-request-id",
        getAccess,
        getTrustedOrigin,
      ),
  },
  {
    name: "Disc Inspection retry",
    path: "/api/disc-inspections/disc-inspection-id/retry",
    unavailableError: "Disc Inspection retry is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createDiscInspectionRetryRoute(
        request,
        "disc-inspection-id",
        getAccess,
        getTrustedOrigin,
      ),
  },
  {
    name: "Encode Jobs",
    path: "/api/encode-jobs",
    unavailableError: "Encode Job queueing is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createEncodeJobsRoute(request, getAccess, () => ({
        mediaLibraryPath: "/media/movies",
        webTrustedOrigin: getTrustedOrigin(),
      })),
  },
  {
    name: "filesystem verification",
    path: "/api/filesystem-verification",
    unavailableError: "Filesystem verification is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createFilesystemVerificationRoute(
        request,
        getAccess,
        getTrustedOrigin,
      ),
  },
  {
    name: "catalog reviews",
    path: "/api/catalog-reviews/archive-id",
    unavailableError: "Catalog review mutation is unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createCatalogReviewRoute(
        request,
        "archive-id",
        getAccess,
        getTrustedOrigin,
      ),
  },
  {
    name: "Encoding Profiles",
    path: "/api/encoding-profiles",
    unavailableError: "Encoding Profiles are unavailable",
    run: (request, getAccess, getTrustedOrigin) =>
      createEncodingProfilesRoute(request, getAccess, getTrustedOrigin),
  },
] satisfies MutationRouteCase[];

const defaultTrustedHeaders = {
  "Content-Type": "application/json",
  Host: "localhost:3000",
  Origin: "http://localhost:3000",
};

const rejectionCases: RejectionCase[] = [
  {
    name: "a missing Origin",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
    },
    expectedStatus: 403,
    expectedError: "Cross-origin mutation rejected",
  },
  {
    name: "a missing Host",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    expectedStatus: 403,
    expectedError: "Cross-origin mutation rejected",
  },
  {
    name: "a hostile Origin",
    headers: {
      ...defaultTrustedHeaders,
      Origin: "https://attacker.example",
    },
    expectedStatus: 403,
    expectedError: "Cross-origin mutation rejected",
  },
  {
    name: "a cross-site fetch",
    headers: {
      ...defaultTrustedHeaders,
      "Sec-Fetch-Site": "cross-site",
    },
    expectedStatus: 403,
    expectedError: "Cross-origin mutation rejected",
  },
  {
    name: "a non-JSON request",
    headers: {
      ...defaultTrustedHeaders,
      "Content-Type": "text/plain",
    },
    expectedStatus: 415,
    expectedError: "JSON content type required",
  },
];

describe.each(mutationRoutes)("$name mutation boundary", (route) => {
  it.each(rejectionCases)(
    "rejects $name before opening data access",
    async ({ headers, expectedStatus, expectedError }) => {
      const getAccess = vi.fn<() => DataAccess>();
      const response = await route.run(
        new Request(`http://localhost:3000${route.path}`, {
          method: route.method ?? "POST",
          headers,
          body: "{}",
        }),
        getAccess,
        () => "http://localhost:3000",
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: expectedError });
      expect(getAccess).not.toHaveBeenCalled();
    },
  );

  it("rejects the default authority when a custom origin is configured", async () => {
    const getAccess = vi.fn<() => DataAccess>();
    const response = await route.run(
      new Request(`http://localhost:3000${route.path}`, {
        method: route.method ?? "POST",
        headers: defaultTrustedHeaders,
        body: "{}",
      }),
      getAccess,
      () => "https://dvd.example.test:8443",
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin mutation rejected",
    });
    expect(getAccess).not.toHaveBeenCalled();
  });

  it("preserves its safe response when trusted-origin config is unavailable", async () => {
    const getAccess = vi.fn<() => DataAccess>();
    const response = await route.run(
      new Request(`http://localhost:3000${route.path}`, {
        method: route.method ?? "POST",
        headers: defaultTrustedHeaders,
        body: "{}",
      }),
      getAccess,
      () => {
        throw new Error("config unavailable");
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: route.unavailableError,
    });
    expect(getAccess).not.toHaveBeenCalled();
  });
});
