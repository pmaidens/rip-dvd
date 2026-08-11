import { describe, expect, it } from "vitest";

import { createRawDvdContentIdHasher } from "./dvd-content-id.js";

describe("raw DVD content IDs", () => {
  it("preserves the current streamed-content identity vector", () => {
    const hasher = createRawDvdContentIdHasher(9);

    hasher.update(Buffer.from("dvd-"));
    hasher.update(Buffer.from("image"));

    expect(hasher.digest()).toBe(
      "sha256:e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61",
    );
  });

  it("preserves the identity vector used for legacy archive aliases", () => {
    const hasher = createRawDvdContentIdHasher(14);

    hasher.update(Buffer.from("same dvd bytes"));

    expect(hasher.digest()).toBe(
      "sha256:c173ea0693af01962a78a28bb2106b93920c0381b6dc06b9fb3f4c71a2e65cef",
    );
  });
});
