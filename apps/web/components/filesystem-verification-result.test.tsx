import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FilesystemVerificationResult,
  type FilesystemVerificationDisplay,
} from "./filesystem-verification-result";

describe("FilesystemVerificationResult", () => {
  it("renders an unverified result when any display field is absent", () => {
    const incompleteResults: FilesystemVerificationDisplay[] = [
      { status: null, message: null, verifiedAt: null },
      {
        status: "accessible",
        message: null,
        verifiedAt: "2026-08-07T02:30:00.000Z",
      },
      {
        status: "accessible",
        message: "File is accessible.",
        verifiedAt: null,
      },
    ];

    for (const result of incompleteResults) {
      expect(
        renderToStaticMarkup(<FilesystemVerificationResult {...result} />),
      ).toBe('<p class="verification-result">Not verified yet.</p>');
    }
  });

  it.each([
    ["accessible", "Accessible", "File is accessible."],
    ["missing", "Missing", "File is missing at the recorded path."],
    [
      "inaccessible",
      "Inaccessible",
      "The web process cannot access the recorded path.",
    ],
    ["error", "Error", "Verification failed unexpectedly."],
  ] as const)(
    "renders the %s status, message, timestamp, and live-region semantics",
    (status, label, message) => {
      const html = renderToStaticMarkup(
        <FilesystemVerificationResult
          status={status}
          message={message}
          verifiedAt="2026-08-07T02:30:00.000Z"
        />,
      );

      expect(html).toContain(
        `class="verification-result verification-${status}"`,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain(`<strong>${label}</strong>`);
      expect(html).toContain(`<span>${message}</span>`);
      expect(html).toMatch(/<small>Verified [^<]+<\/small>/);
      expect(html).not.toContain("2026-08-07T02:30:00.000Z");
    },
  );
});
