import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  return (
    0.2126 * channelToLinear(channels[0]) +
    0.7152 * channelToLinear(channels[1]) +
    0.0722 * channelToLinear(channels[2])
  );
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function selectorColor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  const color = block?.[1].match(/(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i)?.[1];
  if (!color) {
    throw new Error(`No color found for ${selector}`);
  }
  return color;
}

describe("dashboard secondary text contrast", () => {
  it("keeps small card text above WCAG AA across highlighted card backgrounds", () => {
    const lightestCardBackground = "#10211c";

    for (const selector of [
      ".section-eyebrow",
      ".section-message",
      ".item-time",
      ".item-footer",
    ]) {
      expect(
        contrastRatio(selectorColor(selector), lightestCardBackground),
        selector,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps footer text above WCAG AA over the lightest page gradient", () => {
    const lightestPageBackground = "#2a2418";

    expect(
      contrastRatio(
        selectorColor(".dashboard-footer"),
        lightestPageBackground,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
