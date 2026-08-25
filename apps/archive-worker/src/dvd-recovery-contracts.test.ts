import { describe, expect, it } from "vitest";

import {
  createDamagedDvdRecoveryResult,
  DVD_READ_FAILURE_CLASSIFIER_VERSION,
  DVD_SECTOR_BOUNDARY_PROOF_VERSION,
  formatUnvalidatedDvdRecovery,
  isProvenDvdBoundaryCandidate,
  parseDvdReadFailureResultProtocol,
  type DvdReadFailureResult,
  validateDvdRecoveryResult,
  validateResumedDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";

function readFailureProtocolPayload(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    protocolVersion: 1,
    classifierVersion: DVD_READ_FAILURE_CLASSIFIER_VERSION,
    category: "unknown",
    scsiStatus: 0x02,
    hostStatus: 0,
    driverStatus: 0x08,
    senseResponseCode: 0x70,
    senseKey: 0x05,
    asc: 0x21,
    ascq: 0,
    informationLba: null,
    requestedLba: 0,
    requestedBlockCount: 4,
    retryOrdinal: 0,
    ...overrides,
  });
}

describe("DVD recovery results", () => {
  it.each([
    {
      category: "not_ready",
      status: { hostStatus: 0, senseKey: 0x02, asc: 0x04, ascq: 0x01 },
    },
    {
      category: "unit_attention",
      status: { hostStatus: 0, senseKey: 0x06, asc: 0x28, ascq: 0x00 },
    },
    {
      category: "hardware_error",
      status: { hostStatus: 0, senseKey: 0x04, asc: 0x44, ascq: 0x00 },
    },
    {
      category: "transport_error",
      status: { hostStatus: 0x07, senseKey: 0x04, asc: 0x44, ascq: 0x00 },
    },
    {
      category: "protection_error",
      status: { hostStatus: 0, senseKey: 0x05, asc: 0x6f, ascq: 0x04 },
    },
    {
      category: "recognized_medium_error",
      status: { hostStatus: 0, senseKey: 0x03, asc: 0x11, ascq: 0x05 },
    },
  ] as const)(
    "rejects $category evidence labeled as an unknown terminal failure",
    ({ status }) => {
      expect(() =>
        parseDvdReadFailureResultProtocol(
          readFailureProtocolPayload(status),
          4 * 2_048,
        ),
      ).toThrow("DVD read failure helper result is malformed");
    },
  );

  it.each([
    { driverStatus: 0x01, label: "0x01" },
    { driverStatus: 0x02, label: "0x02" },
    { driverStatus: 0x04, label: "0x04" },
    { driverStatus: 0x06, label: "0x06" },
  ])(
    "rejects driver transport status $label labeled as unknown",
    ({ driverStatus }) => {
      expect(() =>
        parseDvdReadFailureResultProtocol(
          readFailureProtocolPayload({
            driverStatus,
            senseResponseCode: null,
            senseKey: null,
            asc: null,
            ascq: null,
          }),
          4 * 2_048,
        ),
      ).toThrow("DVD read failure helper result is malformed");
    },
  );

  it.each([
    { driverStatus: 0x03, label: "0x03" },
    { driverStatus: 0x05, label: "0x05" },
    { driverStatus: 0x07, label: "0x07" },
  ])(
    "does not treat driver status $label as transport evidence",
    ({ driverStatus }) => {
      expect(
        parseDvdReadFailureResultProtocol(
          readFailureProtocolPayload({
            driverStatus,
            senseResponseCode: null,
            senseKey: null,
            asc: null,
            ascq: null,
          }),
          4 * 2_048,
        ),
      ).toMatchObject({ category: "unknown", driverStatus });
    },
  );
  it("accepts a bounded out-of-range terminal result", () => {
    expect(
      parseDvdReadFailureResultProtocol(
        JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v1",
          category: "out_of_range",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 112,
          senseKey: 5,
          asc: 33,
          ascq: 0,
          informationLba: 35,
          requestedLba: 31,
          requestedBlockCount: 9,
          retryOrdinal: 0,
          declaredByteCount: 40 * 2_048,
          firstFailingLba: 35,
          retainedImageByteCount: 31 * 2_048,
        }),
        40 * 2_048,
      ),
    ).toEqual({
      protocolVersion: 1,
      classifierVersion: "scsi-read-classifier-v1",
      category: "out_of_range",
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 112,
      senseKey: 5,
      asc: 33,
      ascq: 0,
      informationLba: 35,
      requestedLba: 31,
      requestedBlockCount: 9,
      retryOrdinal: 0,
      declaredByteCount: 40 * 2_048,
      firstFailingLba: 35,
      retainedImageByteCount: 31 * 2_048,
    });
  });

  it("accepts a versioned sector-precise boundary candidate", () => {
    const result = parseDvdReadFailureResultProtocol(
      JSON.stringify({
        protocolVersion: 1,
        classifierVersion: "scsi-read-classifier-v1",
        category: "out_of_range",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 112,
        senseKey: 5,
        asc: 33,
        ascq: 0,
        informationLba: 35,
        requestedLba: 35,
        requestedBlockCount: 1,
        retryOrdinal: 1,
        boundaryProofVersion: DVD_SECTOR_BOUNDARY_PROOF_VERSION,
        candidateConfirmationCount: 2,
        precedingSectorLba: 34,
        declaredByteCount: 40 * 2_048,
        firstFailingLba: 35,
        retainedImageByteCount: 35 * 2_048,
      }),
      40 * 2_048,
    );

    expect(isProvenDvdBoundaryCandidate(result)).toBe(true);
  });

  it("rejects an object that claims the proof version without the proof shape", () => {
    const result = {
      category: "out_of_range",
      boundaryProofVersion: DVD_SECTOR_BOUNDARY_PROOF_VERSION,
      candidateConfirmationCount: 1,
      firstFailingLba: 35,
      precedingSectorLba: 34,
      retainedImageByteCount: 35 * 2_048,
      requestedLba: 35,
      requestedBlockCount: 1,
      retryOrdinal: 1,
    } as unknown as DvdReadFailureResult;

    expect(isProvenDvdBoundaryCandidate(result)).toBe(false);
  });

  it.each([
    [
      "zero candidate",
      {
        firstFailingLba: 0,
        informationLba: 0,
        precedingSectorLba: 0,
        retainedImageByteCount: 0,
        requestedLba: 0,
      },
    ],
    ["wrong preceding sector", { precedingSectorLba: 33 }],
    ["one confirmation", { candidateConfirmationCount: 1 }],
    [
      "unconfirmed request range",
      { requestedLba: 31, requestedBlockCount: 9 },
    ],
    ["short retained prefix", { retainedImageByteCount: 34 * 2_048 }],
  ])("rejects a proven boundary candidate with %s", (_label, replacement) => {
    expect(() =>
      parseDvdReadFailureResultProtocol(
        JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v1",
          category: "out_of_range",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 112,
          senseKey: 5,
          asc: 33,
          ascq: 0,
          informationLba: 35,
          requestedLba: 35,
          requestedBlockCount: 1,
          retryOrdinal: 1,
          boundaryProofVersion: DVD_SECTOR_BOUNDARY_PROOF_VERSION,
          candidateConfirmationCount: 2,
          precedingSectorLba: 34,
          declaredByteCount: 40 * 2_048,
          firstFailingLba: 35,
          retainedImageByteCount: 35 * 2_048,
          ...replacement,
        }),
        40 * 2_048,
      ),
    ).toThrow("DVD read failure helper result is malformed");
  });

  it.each([
    ["wrong declared size", { declaredByteCount: 39 * 2_048 }],
    ["conflicting boundary", { firstFailingLba: 34 }],
    ["unaligned retained prefix", { retainedImageByteCount: 31 * 2_048 + 1 }],
    ["retained suffix past failure", { retainedImageByteCount: 36 * 2_048 }],
    ["wrong sense category", { senseKey: 3 }],
  ])("rejects out-of-range evidence with %s", (_label, replacement) => {
    expect(() =>
      parseDvdReadFailureResultProtocol(
        JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v1",
          category: "out_of_range",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 112,
          senseKey: 5,
          asc: 33,
          ascq: 0,
          informationLba: 35,
          requestedLba: 31,
          requestedBlockCount: 9,
          retryOrdinal: 0,
          declaredByteCount: 40 * 2_048,
          firstFailingLba: 35,
          retainedImageByteCount: 31 * 2_048,
          ...replacement,
        }),
        40 * 2_048,
      ),
    ).toThrow("DVD read failure helper result is malformed");
  });

  it("rejects out-of-range evidence mislabeled as unknown", () => {
    expect(() =>
      parseDvdReadFailureResultProtocol(
        JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v1",
          category: "unknown",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 112,
          senseKey: 5,
          asc: 33,
          ascq: 0,
          informationLba: 35,
          requestedLba: 31,
          requestedBlockCount: 9,
          retryOrdinal: 0,
        }),
        40 * 2_048,
      ),
    ).toThrow("DVD read failure helper result is malformed");
  });

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
