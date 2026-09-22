import {
  WORKER_KINDS,
  type ArchiveJob,
  type ArchiveJobId,
  type ArchiveAuditRun,
  type ArchiveAuditRunId,
  type ArchiveAuditRunSummary,
  type ArchiveRequest,
  type ArchiveRequestId,
  type ConsistentReadAccess,
  type DataAccess,
  type DetectedDisc,
  type DetectedDiscId,
  type DiscInspection,
  type DiscInspectionId,
  type EncodeJob,
  type EncodeJobId,
  type FilesystemVerificationRun,
  type FilesystemVerificationRunId,
  type OriginalDiscArchive,
  type OriginalDiscArchiveId,
  type OpticalDriveId,
  type WorkerIncident,
  type WorkerIncidentId,
} from "@rip-dvd/data-access";

import { describeArchiveRequestWaitingStatus } from "./archive-request-waiting-status.js";

export const OPERATION_KINDS = [
  "optical-drives",
  "detected-discs",
  "disc-inspections",
  "archive-requests",
  "archive-jobs",
  "original-disc-archives",
  "encode-jobs",
  "archive-audits",
  "filesystem-verifications",
  "worker-incidents",
  "activity",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type WaitableKind = Extract<OperationKind,
  "disc-inspections" | "archive-requests" | "archive-jobs" | "encode-jobs" | "archive-audits" | "filesystem-verifications"
>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedPolicy(limit: number) {
  return { mode: "active-and-history" as const, activeLimit: limit, historyLimit: limit };
}

export function isOperationKind(value: string): value is OperationKind {
  return OPERATION_KINDS.some((kind) => kind === value);
}

export function isWaitableKind(value: string): value is WaitableKind {
  return value === "disc-inspections" || value === "archive-requests" ||
    value === "archive-jobs" || value === "encode-jobs" || value === "archive-audits" ||
    value === "filesystem-verifications";
}

export function validOperationLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT;
}

function incidents(access: ConsistentReadAccess, limit: number) {
  return WORKER_KINDS.flatMap((workerKind) =>
    access.workerIncidents.list({ workerKind, resolvedLimit: limit })
  ).sort((left, right) =>
    (right.resolvedAt ?? right.lastObservedAt).getTime() -
      (left.resolvedAt ?? left.lastObservedAt).getTime() ||
    right.id.localeCompare(left.id)
  );
}

function visibleInspection({ claimToken: _claimToken, ...inspection }: DiscInspection) {
  return inspection;
}

function visibleArchiveJob({ claimToken: _claimToken, claimedBy: _claimedBy, ...job }: ArchiveJob) {
  return job;
}

function visibleEncodeJob({
  claimToken: _claimToken,
  claimedBy: _claimedBy,
  partialCleanupClaimToken: _partialCleanupClaimToken,
  partialCleanupLeaseToken: _partialCleanupLeaseToken,
  replacementOutputIdentity: _replacementOutputIdentity,
  outputPath: _outputPath,
  partialCleanupOutputPath: _partialCleanupOutputPath,
  ...job
}: EncodeJob) {
  return job;
}

function visibleArchive({ archivePath: _archivePath, ...archive }: OriginalDiscArchive) {
  return archive;
}

function visibleDrive({ devicePath: _devicePath, serialNumber: _serialNumber, ...drive }:
  ReturnType<ConsistentReadAccess["catalog"]["listOpticalDrives"]>[number]) {
  return {
    ...drive,
    state: !drive.isPresent ? "missing" : drive.isEnabled ? "ready" : "disabled",
  };
}

function visibleDisc({ scanData: _scanData, ...disc }: DetectedDisc) {
  return disc;
}

function visibleIncident(incident: WorkerIncident) {
  return {
    ...incident,
    status: incident.resolvedAt === null ? "active" : "recovered",
  };
}

function visibleVerificationRun({
  claimToken: _claimToken,
  claimedAt: _claimedAt,
  ...run
}: FilesystemVerificationRun) {
  return run;
}

function visibleArchiveAuditSummary({
  claimToken: _claimToken,
  claimedAt: _claimedAt,
  progressPhase,
  recordCount,
  recordsProcessed,
  ...run
}: ArchiveAuditRunSummary) {
  return {
    ...run,
    progress: { phase: progressPhase, recordCount, recordsProcessed },
  };
}

function visibleArchiveAuditRun(run: ArchiveAuditRun) {
  const { findings, counts, ...summary } = run;
  return {
    ...visibleArchiveAuditSummary(summary),
    counts,
    findings: findings.map((finding) => ({
      ...finding,
      diagnosticDetails: [
        { kind: "original-disc-archives", id: finding.archiveId },
        { kind: "detected-discs", id: finding.detectedDiscId },
        { kind: "optical-drives", id: finding.opticalDriveId },
        ...(finding.discInspectionId === null ? [] : [{
          kind: "disc-inspections", id: finding.discInspectionId,
        }]),
      ],
      availableActions: finding.classification === "consistent" ? [] : [{
        name: "submit-filesystem-verification",
        eligible: true,
        requiredInputs: ["mutationKey"],
        arguments: { target: "original_disc_archive", id: finding.archiveId },
        reason: null,
        effect: "read_only_inspection",
      }],
    })),
  };
}

function recentWork<T extends { status: string; updatedAt: Date; id: string }>(
  records: T[],
  activeStatuses: readonly string[],
  limit: number,
) {
  const newest = (left: T, right: T) =>
    right.updatedAt.getTime() - left.updatedAt.getTime() ||
    right.id.localeCompare(left.id);
  return [
    ...records.filter((item) => activeStatuses.includes(item.status)).sort(newest),
    ...records.filter((item) => !activeStatuses.includes(item.status)).sort(newest),
  ].slice(0, limit);
}

function requestActions(request: ArchiveRequest) {
  const reason = `Archive Request is ${request.status}.`;
  return [
    recoveryAction("cancel", ["pending", "running", "needs_attention"].includes(request.status), reason, "archiveRequestId"),
    recoveryAction("retry", request.status === "needs_attention", reason, "archiveRequestId"),
  ];
}

function inspectionActions(inspection: DiscInspection) {
  const eligible = inspection.isCurrent && inspection.status === "failed" &&
    inspection.manualRetryRequestedAt === null;
  const reason = inspection.manualRetryRequestedAt !== null
    ? "Retry already requested."
    : inspection.isCurrent ? `Disc Inspection is ${inspection.status}.`
    : "Disc Inspection is no longer current.";
  return [recoveryAction("retry", eligible, reason, "discInspectionId")];
}

function recoveryAction(
  name: "cancel" | "retry",
  eligible: boolean,
  reason: string,
  targetInput: "archiveRequestId" | "discInspectionId",
) {
  return {
    name,
    eligible,
    requiredInputs: ["mutationKey", targetInput],
    reason: eligible ? null : reason,
    blockingReasons: eligible ? [] : [{ code: "INVALID_TRANSITION", message: reason }],
  };
}

export function encodeRequeueAvailability(
  access: Pick<ConsistentReadAccess, "encodeJobs">,
  job: EncodeJob,
  selectionEligible: boolean,
) {
  const replacesOutput = job.status === "completed" || job.replaceExistingOutput;
  const requiredInputs = replacesOutput
    ? [
      "mutationKey", "encodeJobId", "expectedRevision",
      "acknowledgeReplacement",
    ]
    : ["mutationKey", "encodeJobId"];
  const blocked = (reason: string) => ({
    eligible: false,
    requiredInputs,
    reason,
    blockingReasons: [{ code: "INVALID_TRANSITION", message: reason }],
  });
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    return blocked(`Encode Job is ${job.status}.`);
  }
  if (!selectionEligible) {
    return blocked(
      "Requires an active Disc Selection with completed Catalog Review.",
    );
  }
  if (job.partialCleanupOutputPath !== null ||
    job.partialCleanupClaimToken !== null || job.partialCleanupLeaseToken !== null) {
    return blocked("Encode Job has pending output cleanup.");
  }
  if (job.publicationPending) {
    return blocked("Encode Job has pending output publication.");
  }
  if (access.encodeJobs.hasReservedOutputPathConflict(job)) {
    const reason = "Encode Job output is reserved by another job.";
    return {
      eligible: false,
      requiredInputs,
      reason,
      blockingReasons: [{ code: "INVALID_TRANSITION", message: reason }],
      alternate: (job.status === "failed" || job.status === "cancelled") &&
        !job.replaceExistingOutput
        ? {
          name: "requeue-with-output-path",
          eligible: true,
          requiredInputs: ["mutationKey", "encodeJobId", "outputPath"],
          reason: "Choose an unreserved output path inside the media library.",
          blockingReasons: [],
        }
        : null,
    };
  }
  return replacesOutput
    ? {
      eligible: true,
      reason: null,
      requiredInputs,
      blockingReasons: [],
      preview: {
        name: "preview-requeue",
        requiredInputs: ["encodeJobId"],
        provides: ["expectedRevision"],
      },
    }
    : { eligible: true, requiredInputs, reason: null, blockingReasons: [] };
}

function encodeActions(job: EncodeJob, requeue: ReturnType<typeof encodeRequeueAvailability>) {
  const cancellationEligible = ["queued", "running"].includes(job.status);
  const cancellationReason = cancellationEligible ? null :
    `Encode Job is ${job.status}.`;
  return [{
    name: "request-cancellation",
    eligible: cancellationEligible,
    requiredInputs: ["mutationKey", "encodeJobId"],
    reason: cancellationReason,
    blockingReasons: cancellationReason === null ? [] : [{
      code: "INVALID_TRANSITION",
      message: cancellationReason,
    }],
  }, {
    name: "requeue",
    ...requeue,
  }, {
    name: "verify-output",
    eligible: true,
    requiredInputs: ["mutationKey", "encodeJobId"],
    reason: null,
    blockingReasons: [],
  }];
}

function detectedDiscActions(disc: DetectedDisc, relevantRequest: ArchiveRequest | null) {
  const eligible = disc.status === "scanned" ||
    (disc.status === "approved" && relevantRequest?.status === "cancelled");
  const reason = relevantRequest && relevantRequest.status !== "cancelled"
    ? `Archive Request is ${relevantRequest.status}.`
    : `Detected Disc is ${disc.status}.`;
  return [{
    name: "request-archive",
    eligible,
    requiredInputs: ["mutationKey", "detectedDiscId"],
    reason: eligible ? null : reason,
    blockingReasons: eligible ? [] : [{ code: "INVALID_TRANSITION", message: reason }],
  }];
}

function activity(access: ConsistentReadAccess, limit: number) {
  const entries = [
    ...access.discInspections.list({ limit }).map((item) => ({
      kind: "disc-inspections", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.archiveRequests.list(undefined, {
      policy: boundedPolicy(limit),
    }).map((item) => ({
      kind: "archive-requests", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.archiveJobs.list(undefined, {
      policy: boundedPolicy(limit),
    }).map((item) => ({
      kind: "archive-jobs", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.encodeJobs.list(undefined, {
      policy: boundedPolicy(limit),
    }).map((item) => ({
      kind: "encode-jobs", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.archiveAudits.list({ limit }).map((item) => ({
      kind: "archive-audits", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.filesystemVerification.list({ limit }).map((item) => ({
      kind: "filesystem-verifications", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...incidents(access, limit).map((item) => ({
      kind: "worker-incidents", id: item.id,
      status: item.resolvedAt === null ? "active" : "recovered",
      occurredAt: item.resolvedAt ?? item.lastObservedAt,
    })),
  ];
  return entries.sort((left, right) =>
    right.occurredAt.getTime() - left.occurredAt.getTime() ||
    right.id.localeCompare(left.id)
  ).slice(0, limit);
}

function readList(access: ConsistentReadAccess, kind: OperationKind, limit: number) {
  switch (kind) {
    case "optical-drives":
      return access.catalog.listOpticalDrives({ limit }).map(visibleDrive);
    case "detected-discs":
      return recentWork(access.catalog.listDetectedDiscs(undefined, {
        policy: boundedPolicy(limit),
      }), ["detected", "scanned", "approved"], limit).map(visibleDisc);
    case "disc-inspections":
      return access.discInspections.list({ limit }).map(visibleInspection);
    case "archive-requests":
      return recentWork(access.archiveRequests.list(undefined, {
        policy: boundedPolicy(limit),
      }), ["pending", "running", "needs_attention", "cancellation_requested"], limit);
    case "archive-jobs":
      return recentWork(access.archiveJobs.list(undefined, {
        policy: boundedPolicy(limit),
      }), ["running"], limit).map(visibleArchiveJob);
    case "original-disc-archives":
      return access.catalog.listOriginalDiscArchives({ limit }).map(visibleArchive);
    case "encode-jobs":
      return recentWork(access.encodeJobs.list(undefined, {
        policy: boundedPolicy(limit),
      }), ["queued", "running", "cancellation_requested"], limit).map(visibleEncodeJob);
    case "archive-audits":
      return access.archiveAudits.list({ limit }).map(visibleArchiveAuditSummary);
    case "filesystem-verifications":
      return access.filesystemVerification.list({ limit }).map(visibleVerificationRun);
    case "worker-incidents":
      return incidents(access, limit).slice(0, limit).map(visibleIncident);
    case "activity":
      return activity(access, limit);
  }
}

function readDetail(access: ConsistentReadAccess, kind: Exclude<OperationKind, "activity">, id: string) {
  switch (kind) {
    case "optical-drives": {
      const drive = access.catalog.listOpticalDrives({ ids: [id as OpticalDriveId] })[0];
      if (!drive) return null;
      return {
        ...visibleDrive(drive),
        inspections: access.discInspections.list({ opticalDriveId: drive.id })
          .map(visibleInspection),
      };
    }
    case "detected-discs": {
      const disc = access.catalog.listDetectedDiscs(undefined, { ids: [id as DetectedDiscId] })[0];
      if (!disc) return null;
      const requests = access.archiveRequests.listForDetectedDisc(disc.id);
      const relevantRequest = access.archiveRequests
        .listRelevantForDetectedDiscs([disc.id])[0] ?? null;
      return {
        ...visibleDisc(disc), scanData: disc.scanData,
        inspections: access.discInspections.list({ detectedDiscId: disc.id })
          .map(visibleInspection),
        archiveRequests: requests,
        currentArchiveRequest: relevantRequest,
        archiveJobs: access.archiveJobs.list(undefined, {
          detectedDiscIds: [disc.id],
        }).map(visibleArchiveJob),
        archives: access.catalog.listOriginalDiscArchives({ detectedDiscId: disc.id })
          .map(visibleArchive),
        availableActions: detectedDiscActions(disc, relevantRequest),
      };
    }
    case "disc-inspections": {
      const inspection = access.discInspections.list({ ids: [id as DiscInspectionId] })[0];
      if (!inspection) return null;
      return {
        ...visibleInspection(inspection),
        attempts: access.discInspections.listAttempts(inspection.id),
        opticalDrive: access.catalog.listOpticalDrives({ ids: [inspection.opticalDriveId] })
          .map(visibleDrive)[0] ?? null,
        detectedDisc: inspection.detectedDiscId === null ? null :
          access.catalog.listDetectedDiscs(undefined, { ids: [inspection.detectedDiscId] })
            .map(visibleDisc)[0] ?? null,
        archiveJobs: access.archiveJobs.listForInspection(inspection.id)
          .map(visibleArchiveJob),
        availableActions: inspectionActions(inspection),
      };
    }
    case "archive-requests": {
      const request = access.archiveRequests.find(id as ArchiveRequestId);
      if (!request) return null;
      return {
        ...request,
        waiting: describeArchiveRequestWaitingStatus(
          access.archiveRequests.waitingStatus(request.id),
        ),
        detectedDisc: access.catalog.listDetectedDiscs(undefined, {
          ids: [request.detectedDiscId],
        }).map(visibleDisc)[0] ?? null,
        archiveJobs: access.archiveJobs.list(undefined, {
          archiveRequestIds: [request.id],
        }).map(visibleArchiveJob),
        availableActions: requestActions(request),
      };
    }
    case "archive-jobs": {
      const job = access.archiveJobs.find(id as ArchiveJobId);
      if (!job) return null;
      return {
        ...visibleArchiveJob(job),
        archiveRequest: access.archiveRequests.find(job.archiveRequestId),
        discInspection: job.discInspectionId === null ? null :
          access.discInspections.list({ ids: [job.discInspectionId] })
            .map(visibleInspection)[0] ?? null,
        archive: job.originalDiscArchiveId === null ? null :
          access.catalog.listOriginalDiscArchives({ ids: [job.originalDiscArchiveId] })
            .map(visibleArchive)[0] ?? null,
      };
    }
    case "original-disc-archives": {
      const archive = access.catalog.listOriginalDiscArchives({ ids: [id as OriginalDiscArchiveId] })[0];
      if (!archive) return null;
      return {
        ...visibleArchive(archive),
        detectedDisc: access.catalog.listDetectedDiscs(undefined, {
          ids: [archive.detectedDiscId],
        }).map(visibleDisc)[0] ?? null,
        archiveJobs: access.archiveJobs.listForArchive(archive.id)
          .map(visibleArchiveJob),
        availableActions: [
          { name: "verify-archive", eligible: true, reason: null },
          {
            name: "request-rearchive",
            eligible: true,
            requiredInputs: ["mutationKey", "sourceArchiveId"],
            reason: null,
            blockingReasons: [],
          },
        ],
      };
    }
    case "encode-jobs": {
      const job = access.encodeJobs.find(id as EncodeJobId);
      if (!job) return null;
      const selection = access.catalog.listDiscSelections({ ids: [job.discSelectionId] })[0];
      const requeueSelectionEligible = access.catalog.listDiscSelections({
        ids: [job.discSelectionId], encodeEligibleOnly: true,
      }).length > 0;
      const requeue = encodeRequeueAvailability(access, job, requeueSelectionEligible);
      const correctionLinks = access.encodeJobs.listCorrectionLinks([job.id]);
      return {
        ...visibleEncodeJob(job),
        failureReports: access.encodeJobs.listFailureReports([job.id]),
        discSelection: selection ?? null,
        archive: selection ? access.catalog.listOriginalDiscArchives({
          ids: [selection.originalDiscArchiveId],
        }).map(visibleArchive)[0] ?? null : null,
        history: access.encodeJobs.listForDiscSelection(job.discSelectionId)
          .map(visibleEncodeJob),
        correctionLinks: correctionLinks.map(visibleEncodeJob),
        retainedOutputs: access.encodeJobs.listRetainedOutputSummaries([job.id]),
        availableActions: encodeActions(job, requeue),
      };
    }
    case "worker-incidents": {
      const incident = access.workerIncidents.find(id as WorkerIncidentId);
      return incident ? visibleIncident(incident) : null;
    }
    case "filesystem-verifications": {
      const run = access.filesystemVerification.find(id as FilesystemVerificationRunId);
      return run === null ? null : visibleVerificationRun(run);
    }
    case "archive-audits": {
      const run = access.archiveAudits.find(id as ArchiveAuditRunId);
      return run === null ? null : visibleArchiveAuditRun(run);
    }
  }
}

export function inspectOperations(
  access: Pick<DataAccess, "readConsistentSnapshot">,
  kind: OperationKind,
  options: { id?: string; limit?: number } = {},
) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!validOperationLimit(limit) || (kind === "activity" && options.id !== undefined)) {
    throw new RangeError("Invalid operation query.");
  }
  return access.readConsistentSnapshot((snapshot) =>
    options.id === undefined
      ? { schemaVersion: 1, kind, items: readList(snapshot, kind, limit) }
      : { schemaVersion: 1, kind, item: readDetail(snapshot, kind as Exclude<OperationKind, "activity">, options.id!) }
  );
}

const TERMINAL_STATUSES: Record<WaitableKind, readonly string[]> = {
  "disc-inspections": ["completed", "failed", "aborted"],
  "archive-requests": ["fulfilled", "cancelled", "needs_attention"],
  "archive-jobs": ["completed", "failed", "cancelled", "aborted"],
  "encode-jobs": ["completed", "failed", "cancelled"],
  "archive-audits": ["completed", "failed"],
  "filesystem-verifications": ["completed", "failed"],
};

export async function waitForOperation(
  access: Pick<DataAccess, "readConsistentSnapshot">,
  kind: WaitableKind,
  id: string,
  timeoutMs: number,
  pollMs = 500,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000 ||
    !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 5_000) {
    throw new RangeError("Invalid wait duration.");
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const current = inspectOperations(access, kind, { id });
    const item = current.item as { status: string } | null;
    if (item === null) return { schemaVersion: 1, outcome: "not_found", kind, id, current: null };
    if (TERMINAL_STATUSES[kind].includes(item.status) &&
      !(kind === "disc-inspections" && item.status === "failed" &&
        "manualRetryRequestedAt" in item && item.manualRetryRequestedAt !== null)) {
      return { schemaVersion: 1, outcome: "settled", kind, id, current: item };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return { schemaVersion: 1, outcome: "timeout", kind, id, current: item };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, pollMs)));
  }
}
