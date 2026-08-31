export type InvestigationRetryability =
  | "appropriate"
  | "after_action"
  | "not_appropriate";

export interface InvestigationEvidence {
  label: string;
  value: string;
}

export interface DashboardInvestigation {
  incidentId: string;
  worker: string;
  subjectType: string;
  subjectId: string;
  attempt: number | null;
  reasonCode: string;
  failedPhase: string;
  occurredAt: string;
  retryability: InvestigationRetryability;
  retryabilityDetail: string;
  explanation: string;
  suggestedAction: string;
  technicalEvidence: readonly InvestigationEvidence[];
}

const RETRYABILITY_LABELS: Record<InvestigationRetryability, string> = {
  appropriate: "Appropriate",
  after_action: "Appropriate after the suggested action",
  not_appropriate: "Not appropriate",
};

export function investigationRetryabilityLabel(
  retryability: InvestigationRetryability,
): string {
  return RETRYABILITY_LABELS[retryability];
}

export function formatInvestigationTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function investigationReport(
  investigation: DashboardInvestigation,
): string {
  const evidence = investigation.technicalEvidence.length === 0
    ? ["- No structured technical evidence was recorded."]
    : investigation.technicalEvidence.map(
        ({ label, value }) => `- ${label}: ${value}`,
      );
  return [
    `${investigation.subjectType} investigation`,
    `Incident identifier: ${investigation.incidentId}`,
    `Worker: ${investigation.worker}`,
    `Subject: ${investigation.subjectType} ${investigation.subjectId}`,
    ...(investigation.attempt === null
      ? []
      : [`${investigation.subjectType} attempt: ${investigation.attempt}`]),
    `Reason code: ${investigation.reasonCode}`,
    `Failed phase: ${investigation.failedPhase}`,
    `Occurred: ${formatInvestigationTimestamp(investigation.occurredAt)}`,
    `Retryability: ${investigationRetryabilityLabel(investigation.retryability)}`,
    `Retryability detail: ${investigation.retryabilityDetail}`,
    `Explanation: ${investigation.explanation}`,
    `Suggested action: ${investigation.suggestedAction}`,
    "Technical evidence:",
    ...evidence,
  ].join("\n");
}
