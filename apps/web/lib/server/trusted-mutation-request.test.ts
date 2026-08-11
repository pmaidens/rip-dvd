import { describe, expect, it } from "vitest";

import { trustedMutationRequestProblem } from "./trusted-mutation-request";

interface RequestCase {
  name: string;
  trustedOrigin?: string;
  requestUrl?: string;
  headers: Record<string, string>;
  expectedStatus: number | null;
  expectedBody?: { error: string };
}

const trustedHeaders = {
  "Content-Type": "application/json",
  Host: "localhost:3000",
  Origin: "http://localhost:3000",
};

const requestCases: RequestCase[] = [
  {
    name: "the default trusted origin",
    headers: trustedHeaders,
    expectedStatus: null,
  },
  {
    name: "JSON with parameters and an absent Fetch Metadata header",
    headers: {
      ...trustedHeaders,
      "Content-Type": "Application/JSON; Charset=UTF-8",
    },
    expectedStatus: null,
  },
  {
    name: "an explicitly configured HTTPS origin with a custom port",
    trustedOrigin: "https://dvd.example.test:8443",
    requestUrl: "https://dvd.example.test:8443/api/example",
    headers: {
      "Content-Type": "application/json",
      Host: "DVD.EXAMPLE.TEST:8443",
      Origin: "https://dvd.example.test:8443/",
      "Sec-Fetch-Site": "same-origin",
    },
    expectedStatus: null,
  },
  {
    name: "a browser navigation",
    headers: { ...trustedHeaders, "Sec-Fetch-Site": "none" },
    expectedStatus: null,
  },
  {
    name: "a missing content type",
    headers: {
      Host: trustedHeaders.Host,
      Origin: trustedHeaders.Origin,
    },
    expectedStatus: 415,
    expectedBody: { error: "JSON content type required" },
  },
  {
    name: "a non-JSON content type",
    headers: { ...trustedHeaders, "Content-Type": "text/plain" },
    expectedStatus: 415,
    expectedBody: { error: "JSON content type required" },
  },
  {
    name: "a missing Origin",
    headers: {
      "Content-Type": trustedHeaders["Content-Type"],
      Host: trustedHeaders.Host,
    },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "an invalid Origin",
    headers: { ...trustedHeaders, Origin: "not an origin" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "a hostile Origin with the trusted Host",
    headers: { ...trustedHeaders, Origin: "https://attacker.example" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "a missing Host",
    headers: {
      "Content-Type": trustedHeaders["Content-Type"],
      Origin: trustedHeaders.Origin,
    },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "a hostile Host with the trusted Origin",
    headers: { ...trustedHeaders, Host: "attacker.example" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "the trusted hostname with the wrong port",
    headers: { ...trustedHeaders, Host: "localhost:3001" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "a cross-site fetch",
    headers: { ...trustedHeaders, "Sec-Fetch-Site": "cross-site" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
  {
    name: "a same-site fetch",
    headers: { ...trustedHeaders, "Sec-Fetch-Site": "same-site" },
    expectedStatus: 403,
    expectedBody: { error: "Cross-origin mutation rejected" },
  },
];

describe("trustedMutationRequestProblem", () => {
  it.each(requestCases)(
    "accepts or rejects $name",
    async ({ trustedOrigin, requestUrl, headers, expectedStatus, expectedBody }) => {
      const problem = trustedMutationRequestProblem(
        new Request(requestUrl ?? "http://localhost:3000/api/example", {
          method: "POST",
          headers,
          body: "{}",
        }),
        trustedOrigin ?? "http://localhost:3000",
      );

      if (expectedStatus === null) {
        expect(problem).toBeNull();
        return;
      }

      expect(problem?.status).toBe(expectedStatus);
      expect(problem?.headers.get("Cache-Control")).toBe("no-store");
      await expect(problem?.json()).resolves.toEqual(expectedBody);
    },
  );
});
