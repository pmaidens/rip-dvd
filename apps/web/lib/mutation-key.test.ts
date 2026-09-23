import { afterEach, expect, it, vi } from "vitest";

import { createMutationKey } from "./mutation-key";

afterEach(() => vi.unstubAllGlobals());

it("creates distinct UUID v4 mutation keys without a secure-context API", () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const keys = Array.from({ length: 100 }, () => createMutationKey());
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) {
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});
