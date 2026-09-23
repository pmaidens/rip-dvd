import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint();

it.each([
  "crypto.randomUUID()",
  "window.crypto.randomUUID()",
  "globalThis.crypto['randomUUID']()",
  "const source = crypto; source.randomUUID()",
  "const { randomUUID: makeKey } = crypto; makeKey()",
])("rejects secure-context UUID access: %s", async (code) => {
  const [result] = await eslint.lintText(code, { filePath: "components/example.tsx" });
  expect(result!.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleId: "no-restricted-properties", severity: 2 }),
  ]));
});

it.each(["components/example.tsx", "lib/example.ts", "app/example/page.tsx"])(
  "enforces the restriction in %s", async (filePath) => {
    const [result] = await eslint.lintText("crypto.randomUUID()", { filePath });
    expect(result!.errorCount).toBe(1);
  },
);

it("allows the HTTP-safe random source and shared helper", async () => {
  const [result] = await eslint.lintText(
    'import { createMutationKey } from "../lib/mutation-key"; createMutationKey(); crypto.getRandomValues(new Uint8Array(16));',
    { filePath: "components/example.tsx" },
  );
  expect(result!.errorCount).toBe(0);
});
