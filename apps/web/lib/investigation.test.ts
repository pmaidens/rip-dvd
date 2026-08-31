import { describe, expect, it } from "vitest";

import type { DashboardInvestigation } from "./investigation";
import { investigationReport } from "./investigation";

const investigation: DashboardInvestigation = {
  incidentId: "archive-job-failure:job-1",
  worker: "Archive Worker",
  subjectType: "Archive Job",
  subjectId: "job-1",
  attempt: 2,
  reasonCode: "archive_read.transport_error",
  failedPhase: "Copying",
  occurredAt: "2026-08-31T06:00:00.000Z",
  retryability: "after_action",
  retryabilityDetail:
    "The current Archive Request can be retried after completing the suggested action.",
  explanation: "Communication with the Optical Drive failed.",
  suggestedAction:
    "Check the Optical Drive connection and host passthrough, then retry the Archive Request.",
  technicalEvidence: [
    { label: "Read stage", value: "Initial copy" },
    { label: "Failing LBA", value: "2048" },
  ],
};

describe("investigationReport", () => {
  it("copies every visible investigation field and labelled evidence item", () => {
    const report = investigationReport(investigation);

    expect(report).toContain("Incident identifier: archive-job-failure:job-1");
    expect(report).toContain("Worker: Archive Worker");
    expect(report).toContain("Subject: Archive Job job-1");
    expect(report).toContain("Archive Job attempt: 2");
    expect(report).toContain("Reason code: archive_read.transport_error");
    expect(report).toContain("Failed phase: Copying");
    expect(report).toContain(
      "Retryability: Appropriate after the suggested action",
    );
    expect(report).toContain(
      "Explanation: Communication with the Optical Drive failed.",
    );
    expect(report).toContain("- Read stage: Initial copy");
    expect(report).toContain("- Failing LBA: 2048");
  });

  it("states when no structured evidence was recorded", () => {
    expect(investigationReport({
      ...investigation,
      technicalEvidence: [],
    })).toContain("- No structured technical evidence was recorded.");
  });
});
