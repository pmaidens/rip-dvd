import { describe, expect, it } from "vitest";

import {
  HANDBRAKE_PRESET_GROUPS,
  HANDBRAKE_PRESETS,
  isHandBrakePreset,
} from "./handbrake-presets";

describe("HandBrake presets", () => {
  it("contains every unique HandBrake 1.6.1 built-in preset", () => {
    expect(HANDBRAKE_PRESET_GROUPS.map((group) => group.label)).toEqual([
      "General",
      "Web",
      "Devices",
      "Matroska",
      "Hardware",
      "Production",
    ]);
    expect(HANDBRAKE_PRESETS).toHaveLength(89);
    expect(new Set(HANDBRAKE_PRESETS).size).toBe(HANDBRAKE_PRESETS.length);
  });

  it("recognizes only exact built-in preset names", () => {
    expect(isHandBrakePreset("Fast 480p30")).toBe(true);
    expect(isHandBrakePreset(" Fast 480p30 ")).toBe(false);
    expect(isHandBrakePreset("Not a HandBrake preset")).toBe(false);
  });
});
