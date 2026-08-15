import { describe, expect, it } from "vitest";

import {
  createDamagedDvdRecoveryResult,
  formatUnvalidatedDvdRecovery,
  validateDvdRecoveryResult,
  validateResumedDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";

describe("DVD recovery results", () => {
  it("requires validation for normalized unreadable sector evidence", () => {
    const result = createDamagedDvdRecoveryResult(8_192, [
      { startLba: 1, sectorCount: 1 },
      { startLba: 3, sectorCount: 1 },
    ]);

    expect(result).toEqual({
      outcome: "damaged",
      declaredByteCount: 8_192,
      recoveredByteCount: 4_096,
      recoveryPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 2,
      badAreaCount: 2,
      unrecoveredSectorRanges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 3, sectorCount: 1 },
      ],
    });
    expect(validateDvdRecoveryResult(result, 8_192)).toEqual({
      outcome: "requires_validation",
      recoveryResult: result,
    });
  });

  it.each([
    {
      label: "overlapping ranges",
      ranges: [
        { startLba: 1, sectorCount: 2 },
        { startLba: 2, sectorCount: 1 },
      ],
    },
    {
      label: "adjacent unnormalized ranges",
      ranges: [
        { startLba: 1, sectorCount: 1 },
        { startLba: 2, sectorCount: 1 },
      ],
    },
    {
      label: "out-of-bounds ranges",
      ranges: [{ startLba: 4, sectorCount: 1 }],
    },
  ])("rejects $label", ({ ranges }) => {
    expect(() =>
      validateDvdRecoveryResult(
        {
          outcome: "damaged",
          declaredByteCount: 8_192,
          recoveredByteCount: 4_096,
          recoveryPolicyVersion: "dvd-recovery-v1",
          badSectorCount: 2,
          badAreaCount: ranges.length,
          unrecoveredSectorRanges: ranges,
        },
        8_192,
      ),
    ).toThrow("DVD recovery result is invalid");
  });

  it("bounds operator diagnostics while retaining complete structured evidence", () => {
    const ranges = Array.from({ length: 10 }, (_, index) => ({
      startLba: index * 2,
      sectorCount: 1,
    }));
    const result = createDamagedDvdRecoveryResult(20 * 2_048, ranges);

    expect(formatUnvalidatedDvdRecovery(result)).toBe(
      "DVD rescue requires validation: 10 unreadable sectors in 10 areas; LBAs 0, 2, 4, 6, 8, 10, 12, 14, and 2 more",
    );
    expect(result.unrecoveredSectorRanges).toEqual(ranges);
  });

  it("rejects a resumed result that introduces newly unreadable sectors", () => {
    const prior = createDamagedDvdRecoveryResult(4 * 2_048, [
      { startLba: 1, sectorCount: 1 },
    ]);

    expect(() =>
      validateResumedDvdRecoveryResult(
        createDamagedDvdRecoveryResult(4 * 2_048, [
          { startLba: 2, sectorCount: 1 },
        ]),
        prior,
        4 * 2_048,
      ),
    ).toThrow("Resumed DVD recovery result is invalid");
  });
});
