import { describe, expect, it } from "vitest";

import {
  classifyArchiveReadFailureEvidence,
  isArchiveReadFailureEvidenceConsistent,
} from "./archive-read-failure.js";

const currentReadFailure = {
  scsiStatus: 0x02,
  hostStatus: 0,
  driverStatus: 0x08,
  senseKey: 0x03,
  asc: 0x11,
  ascq: 0x00,
};

describe("archive read failure classification", () => {
  it.each([
    { asc: 0x02, ascq: 0x00 },
    { asc: 0x11, ascq: 0x05 },
    { asc: 0x7f, ascq: 0x7f },
  ])("treats current medium error $asc/$ascq as recoverable", ({ asc, ascq }) => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        asc,
        ascq,
      }),
    ).toBe("recognized_medium_error");
  });

  it("accepts masked CHECK CONDITION and DRIVER_SENSE suggestions", () => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        scsiStatus: 0x03,
        driverStatus: 0x28,
      }),
    ).toBe("recognized_medium_error");
  });

  it("treats every nonzero host status as transport failure", () => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        hostStatus: 0x13,
      }),
    ).toBe("transport_error");
  });

  it("uses the driver base status when suggestion bits are present", () => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        driverStatus: 0x16,
      }),
    ).toBe("transport_error");
  });

  it("accepts newer DVD protection ASCQ assignments", () => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        senseKey: 0x05,
        asc: 0x6f,
        ascq: 0x0a,
      }),
    ).toBe("protection_error");
  });

  it("keeps unrecognized driver base statuses unknown", () => {
    expect(
      classifyArchiveReadFailureEvidence({
        ...currentReadFailure,
        driverStatus: 0x23,
      }),
    ).toBe("unknown");
  });

  it("uses masked status fields for out-of-range consistency", () => {
    expect(
      isArchiveReadFailureEvidenceConsistent({
        category: "out_of_range",
        scsiStatus: 0x03,
        hostStatus: 0,
        driverStatus: 0x28,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      }),
    ).toBe(true);
  });
});
