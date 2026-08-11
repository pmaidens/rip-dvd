import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FilesystemVerificationResult,
  type FilesystemVerificationDisplay,
} from "./filesystem-verification-result";
import {
  VERIFICATION_RESULT_CASES,
  VERIFICATION_TIMESTAMP,
} from "./filesystem-verification-result.test-support";

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

  it.each(VERIFICATION_RESULT_CASES)(
    "renders the $status status, message, timestamp, and live-region semantics",
    ({ status, label, message }) => {
      const html = renderToStaticMarkup(
        <FilesystemVerificationResult
          status={status}
          message={message}
          verifiedAt={VERIFICATION_TIMESTAMP}
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
      expect(html).not.toContain(VERIFICATION_TIMESTAMP);
    },
  );
});
