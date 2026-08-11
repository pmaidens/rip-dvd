import { expect } from "vitest";

export const VERIFICATION_TIMESTAMP = "2026-08-07T02:30:00.000Z";

export const VERIFICATION_RESULT_CASES = [
  {
    status: "accessible",
    label: "Accessible",
    message: "File is accessible.",
  },
  {
    status: "missing",
    label: "Missing",
    message: "File is missing at the recorded path.",
  },
  {
    status: "inaccessible",
    label: "Inaccessible",
    message: "The web process cannot access the recorded path.",
  },
  {
    status: "error",
    label: "Error",
    message: "Verification failed unexpectedly.",
  },
] as const;

export function expectVerificationResultList(html: string): void {
  for (const { status, message } of VERIFICATION_RESULT_CASES) {
    expect(html).toContain(`verification-${status}`);
    expect(html).toContain(message);
  }
  expect(html.match(/role="status"/g)).toHaveLength(
    VERIFICATION_RESULT_CASES.length,
  );
  expect(html.match(/aria-live="polite"/g)).toHaveLength(
    VERIFICATION_RESULT_CASES.length,
  );
  expect(html.match(/<small>Verified [^<]+<\/small>/g)).toHaveLength(
    VERIFICATION_RESULT_CASES.length,
  );
  expect(html).not.toContain(VERIFICATION_TIMESTAMP);
  expect(html).toContain("Not verified yet.");
}
