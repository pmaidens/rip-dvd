import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readmes = [
  ["root README", new URL("../../../README.md", import.meta.url)],
  ["data-access README", new URL("../README.md", import.meta.url)],
] as const;

describe.each(readmes)("%s", (_name, readmeUrl) => {
  it("documents Disc Selection history and unsafe legacy quarantine", () => {
    const readme = readFileSync(readmeUrl, "utf8").replace(/\s+/g, " ");

    expect(readme).toMatch(
      /\*\*Ordinary retry identity\.\*\*[\s\S]{0,500}cannot be repaired or removed[\s\S]{0,500}same logical Encode Job/i,
    );
    expect(readme).toMatch(
      /\*\*Unsafe legacy quarantine\.\*\*[\s\S]{0,700}deactivates[\s\S]{0,700}rather than deleting[\s\S]{0,700}remain as history/i,
    );
    expect(readme).toMatch(
      /\*\*Retained completed provenance\.\*\*[\s\S]{0,500}remain terminal[\s\S]{0,500}continue to reserve their output paths/i,
    );
    expect(readme).toMatch(
      /\*\*Released failed-job reservations\.\*\*[\s\S]{0,500}permanently ineligible[\s\S]{0,500}output-path reservations are released/i,
    );
  });
});
