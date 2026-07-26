import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DashboardView,
  type DashboardLoadState,
} from "../components/operations-dashboard";

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

function selectorDeclarations(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizedStyles = styles.replace(/\s+/g, " ");
  const block = normalizedStyles.match(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`),
  );
  if (!block) {
    throw new Error(`No style block found for ${selector}`);
  }
  return block[1];
}

function selectorColor(selector: string): string {
  const color = selectorDeclarations(selector).match(
    /(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i,
  )?.[1];
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

describe("dashboard 320px fallback", () => {
  it("keeps long unbroken database-backed values shrinkable and wrap-safe", () => {
    const longDriveName = `Drive_${"A".repeat(96)}`;
    const longVolumeLabel = `DISC_${"B".repeat(96)}`;
    const longMediaTitle = `Movie_${"C".repeat(96)}`;
    const longProfileName = `Profile_${"D".repeat(96)}`;
    const state: DashboardLoadState = {
      opticalDrives: {
        status: "loaded",
        items: [
          {
            id: "drive-long",
            displayName: longDriveName,
            hardwareName: null,
            state: "ready",
            lastSeenAt: "2026-07-22T07:59:00.000Z",
          },
        ],
      },
      detectedDiscs: {
        status: "loaded",
        items: [
          {
            id: "disc-long",
            volumeLabel: longVolumeLabel,
            discKind: "dvd",
            status: "scanned",
            opticalDriveName: longDriveName,
            detectedAt: "2026-07-22T07:58:00.000Z",
          },
        ],
      },
      archiveJobs: { status: "loaded", items: [] },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-long",
            mediaTitle: longMediaTitle,
            mediaYear: null,
            encodingProfileName: longProfileName,
            status: "running",
            progressPercent: 50,
          },
        ],
      },
      catalogReview: { status: "loaded", items: [] },
    };
    const html = renderToStaticMarkup(
      React.createElement(DashboardView, { state }),
    );

    expect(html).toContain(longDriveName);
    expect(html).toContain(longVolumeLabel);
    expect(html).toContain(longMediaTitle);
    expect(html).toContain(longProfileName);
    expect(html.match(/class="status /g)).toHaveLength(3);
    expect(selectorDeclarations("body")).toMatch(/min-width:\s*320px/);
    expect(styles).toMatch(
      /@media \(max-width: 47rem\)[\s\S]*?\.dashboard-grid\s*\{[^}]*display:\s*block/,
    );
    expect(selectorDeclarations(".item-heading > div")).toMatch(
      /min-width:\s*0/,
    );
    expect(
      selectorDeclarations(".item-heading h3, .item-heading p"),
    ).toMatch(/overflow-wrap:\s*anywhere/);
    expect(selectorDeclarations(".status, .attention-mark")).toMatch(
      /flex:\s*0\s+0\s+auto/,
    );
  });
});
