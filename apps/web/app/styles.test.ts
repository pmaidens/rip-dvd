import { readFileSync } from "node:fs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { EncodeJobId } from "@rip-dvd/data-access";

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

describe("dashboard error treatments", () => {
  it("keeps mutation errors and worker failure disclosures visibly styled", () => {
    const declarations = selectorDeclarations(".job-error, .job-failure");

    expect(declarations).toMatch(/color:\s*#e89a90/);
    expect(declarations).toMatch(/font-size:\s*0\.78rem/);
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
            fingerprint: `sha256:${"e".repeat(64)}`,
            titles: [],
            detectedAt: "2026-07-22T07:58:00.000Z",
          },
        ],
      },
      archiveJobs: { status: "loaded", items: [] },
      encodeJobs: {
        status: "loaded",
        items: [
          {
            id: "encode-long" as EncodeJobId,
            mediaTitle: longMediaTitle,
            mediaYear: null,
            encodingProfileName: longProfileName,
            status: "running",
            progressPhase: null,
            progressPercent: 50,
            progressEtaSeconds: null,
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
    expect(selectorDeclarations(".investigation-panel")).toMatch(
      /width:\s*min\(48rem,\s*calc\(100vw\s*-\s*2rem\)\)/,
    );
    expect(
      selectorDeclarations(
        ".investigation-summary dd, .investigation-evidence dd",
      ),
    ).toMatch(/overflow-wrap:\s*anywhere/);
    expect(selectorDeclarations(".investigation-report textarea")).toMatch(
      /max-width:\s*100%/,
    );
    expect(styles.replace(/\s+/g, " ")).toMatch(
      /@media \(max-width: 47rem\).*\.investigation-panel \{ width: calc\(100vw - 1rem\);.*\.investigation-summary, \.investigation-evidence dl \{ grid-template-columns: minmax\(0, 1fr\);/,
    );
  });
});

describe("Catalog Review Mapping Proposal layout", () => {
  it("places the active proposal beside title evidence on desktop and below it on mobile", () => {
    expect(selectorDeclarations(".catalog-title-evidence-active")).toMatch(
      /display:\s*grid/,
    );
    expect(selectorDeclarations(".catalog-title-evidence-active")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(18rem,\s*0\.9fr\)/,
    );
    expect(styles.replace(/\s+/g, " ")).toMatch(
      /@media \(max-width: 47rem\).*\.catalog-title-evidence-active \{ grid-template-columns: 1fr;/,
    );
  });

  it("stacks the bulk episodic controls and keeps episode cards wrap-safe on mobile", () => {
    expect(selectorDeclarations(".catalog-episodic-selection")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(selectorDeclarations(".catalog-episodic-episode")).toMatch(
      /min-width:\s*0/,
    );
    expect(selectorDeclarations(".catalog-episodic-episode")).toMatch(
      /overflow-wrap:\s*anywhere/,
    );
    expect(styles.replace(/\s+/g, " ")).toMatch(
      /@media \(max-width: 47rem\).*\.catalog-episodic-selection \{ grid-template-columns: 1fr;/,
    );
  });

  it("places the episodic proposal beside selected evidence and below it on mobile", () => {
    expect(selectorDeclarations(".catalog-episodic-workspace")).toMatch(
      /display:\s*grid/,
    );
    expect(selectorDeclarations(".catalog-episodic-workspace")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(18rem,\s*0\.9fr\)/,
    );
    expect(styles.replace(/\s+/g, " ")).toMatch(
      /@media \(max-width: 47rem\).*\.catalog-episodic-workspace \{ grid-template-columns: 1fr;/,
    );
  });
});

describe("automatic Catalog proposal layout", () => {
  it("stacks proposal details on mobile and keeps the action keyboard-visible", () => {
    expect(selectorDeclarations(".catalog-automation-heading")).toMatch(
      /display:\s*flex/,
    );
    expect(selectorDeclarations("button:focus-visible")).toMatch(
      /outline:\s*3px solid #d2a14b/,
    );
    expect(styles.replace(/\s+/g, " ")).toMatch(
      /@media \(max-width: 47rem\).*\.catalog-automation-summary, \.catalog-automation-episodes \{ grid-template-columns: 1fr;.*\.catalog-automation\.is-ready, \.catalog-automation-heading \{ align-items: stretch; flex-direction: column;/,
    );
  });
});

describe("Catalog Review evidence presentation", () => {
  it("keeps title evidence wrap-safe with keyboard-visible disclosures", () => {
    expect(selectorDeclarations(".catalog-title-evidence")).toMatch(
      /min-width:\s*0/,
    );
    expect(selectorDeclarations(".catalog-title-evidence")).toMatch(
      /overflow-wrap:\s*anywhere/,
    );
    expect(selectorDeclarations(".catalog-volume-labels code")).toMatch(
      /overflow-wrap:\s*anywhere/,
    );
    expect(
      selectorDeclarations(".catalog-stream-details summary:focus-visible"),
    ).toMatch(/outline:\s*3px solid #d2a14b/);
    expect(styles).toMatch(
      /@media \(max-width: 47rem\)[\s\S]*?\.catalog-stream-groups\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 47rem\)[\s\S]*?\.catalog-title-evidence-heading\s*\{[^}]*flex-direction:\s*column/,
    );
  });
});

describe("Catalog Review Coverage presentation", () => {
  it("keeps coverage controls wrap-safe and keyboard-visible", () => {
    expect(selectorDeclarations(".catalog-coverage-filters")).toMatch(
      /flex-wrap:\s*wrap/,
    );
    expect(
      selectorDeclarations(
        ".catalog-coverage-collapsed summary:focus-visible",
      ),
    ).toMatch(/outline:\s*3px solid #d2a14b/);
  });
});
