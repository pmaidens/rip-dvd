import { describe, expect, it } from "vitest";

import {
  createDiscSelectionSourceIdentity,
  discSelectionSourceDescription,
  DomainInvariantError,
  type DiscSelectionSourceIdentityInput,
} from "./index.js";

describe("Disc Selection source identity", () => {
  it.each([
    { kind: "main_feature" } as const,
    { kind: "dvd_title", titleNumber: 2 } as const,
    {
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 4,
      chapterEnd: 7,
    } as const,
  ])("creates the canonical $kind identity", (input) => {
    const identity = createDiscSelectionSourceIdentity(input);

    expect(identity).toEqual(input);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it.each([
    [{ kind: "main_feature" } as const, "DVD main feature"],
    [{ kind: "dvd_title", titleNumber: 2 } as const, "DVD title 2"],
    [{
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 4,
      chapterEnd: 7,
    } as const, "DVD title 3, chapters 4–7"],
  ])("describes the canonical source identity %#", (input, description) => {
    expect(
      discSelectionSourceDescription(
        createDiscSelectionSourceIdentity(input),
      ),
    ).toBe(description);
  });

  it.each([
    null,
    { kind: "blu_ray_title", titleNumber: 1 },
    { kind: "main_feature", titleNumber: 1 },
    { kind: "dvd_title", titleNumber: 0 },
    { kind: "dvd_title", titleNumber: 1, chapterStart: 1 },
    { kind: "dvd_chapters", titleNumber: 1, chapterStart: 1 },
    { kind: "dvd_chapters", titleNumber: 1, chapterStart: 0, chapterEnd: 1 },
    { kind: "dvd_chapters", titleNumber: 1, chapterStart: 3, chapterEnd: 2 },
  ])("rejects an invalid identity: %j", (input) => {
    expect(() =>
      createDiscSelectionSourceIdentity(
        input as unknown as DiscSelectionSourceIdentityInput,
      )
    ).toThrow(DomainInvariantError);
  });
});
