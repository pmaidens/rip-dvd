import { describe, expect, it } from "vitest";

import { normalizeErrorMessage } from "./normalize-error-message.js";

describe("normalizeErrorMessage", () => {
  it("uses the message from an Error", () => {
    expect(normalizeErrorMessage(new Error("encode failed"))).toBe(
      "encode failed",
    );
  });

  it("stringifies a non-Error value", () => {
    expect(normalizeErrorMessage(404)).toBe("404");
  });
});
