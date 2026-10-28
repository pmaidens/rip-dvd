import {
  activeEncodeWorkIdentities,
  archiveRecoveryWorkIdentity,
  createEncodeWorkConflictCurrent,
  DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT,
  ENCODE_WORK_CONFLICT,
  DVD_RECOVERY_EVIDENCE_ADMISSION,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  dvdRecoveryEvidenceFormatForArchive,
  type DvdArchiveEvidenceHeader,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  WORKER_KINDS,
  withAuthoritativeDvdArchiveIntegrity,
  type ArchiveJob,
  type ArchiveJobId,
  type ArchiveRecovery,
  type ArchiveRecoveryId,
  type DvdRecoveryReconciliation,
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
  type EncodeWorkConflictCurrent,
  type FilesystemVerificationRun,
  type FilesystemVerificationRunId,
  type OriginalDiscArchive,
  type OriginalDiscArchiveId,
  type OpticalDriveId,
  type WorkerIncident,
  type WorkerIncidentId,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { describeArchiveRequestWaitingStatus } from "./archive-request-waiting-status.js";
import {
  encodeOutputArtifactReferences,
  retainedEncodeOutputArtifactIdentity,
} from "./encode-output-inspection.js";
import { describeDvdRecoveryStorage } from "./dvd-recovery-storage.js";
import {
  dvdRecoveryReconciliationBlockingReasons,
} from "./dvd-recovery-reconciliation.js";
import { dvdRecoveryStopAction } from "./dvd-recovery-stop.js";
import { dvdRecoveryResumeAction } from "./dvd-recovery-resume.js";
import { visibleArchiveRecovery } from "./archive-recovery-view.js";
import { presentArchiveRecoveryRangeEvidence } from "./archive-recovery-ranges.js";
import {
  ArchiveArtifactChangedError,
  describeArchiveArtifact,
  enrichArchiveArtifactSourceIdentity,
  type ArchiveArtifact,
} from "./archive-artifact.js";

export const OPERATION_KINDS = [
  "optical-drives",
  "detected-discs",
  "disc-inspections",
  "archive-requests",
  "archive-jobs",
  "archive-recoveries",
  "original-disc-archives",
  "encode-jobs",
  "archive-audits",
  "filesystem-verifications",
  "worker-incidents",
  "activity",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type WaitableKind = Extract<OperationKind,
  "disc-inspections" | "archive-requests" | "archive-jobs" | "archive-recoveries" | "encode-jobs" | "archive-audits" | "filesystem-verifications"
>;

export interface OperationInspectionOptions {
  id?: string;
  limit?: number;
  offset?: number;
  originalsLibraryPath?: string;
  archiveImageOwnership?: Pick<ArchiveImageOwnership, "inspect">;
}

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
    value === "archive-jobs" || value === "archive-recoveries" ||
    value === "encode-jobs" || value === "archive-audits" ||
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

function visibleDvdRecoveryReconciliation(
  reconciliation: DvdRecoveryReconciliation | null,
) {
  if (reconciliation === null) return null;
  const { claimToken: _claimToken, ...visible } = reconciliation;
  return visible;
}

function archiveRecoveryOperation(
  access: ConsistentReadAccess,
  recovery: ArchiveRecovery,
  options: Pick<
    OperationInspectionOptions,
    "originalsLibraryPath" | "archiveImageOwnership"
  > = {},
  includeProgress = false,
) {
  const reconciliation = access.dvdRecoveryReconciliations
    .findLatestForRecovery(recovery.id);
  const reconciliationBlockingReasons =
    dvdRecoveryReconciliationBlockingReasons(recovery, reconciliation);
  const reconciliationIsActive = reconciliation?.status === "queued" ||
    reconciliation?.status === "running";
  const recoveryPassIsQueued = recovery.status === "eligible" &&
    recovery.work?.status === "requested";
  const reportedRecoveryStatus = recoveryPassIsQueued
    ? "running"
    : recovery.status;
  const recoveryOwnsStatus = recoveryPassIsQueued ||
    recovery.status === "running" ||
    recovery.status === "stopping" || !reconciliationIsActive &&
      (recovery.status === "waiting_for_disc" ||
        recovery.status === "paused" || recovery.status === "stopped" ||
        recovery.status === "faulted" || recovery.status === "completed");
  const encodeJobs = access.catalog.listDiscSelections({
    originalDiscArchiveId: recovery.originalDiscArchiveId,
    includeHistorical: true,
  }).flatMap(({ id }) => access.encodeJobs.listForDiscSelection(id));
  const rangeEvidence = includeProgress
    ? access.catalog.readDvdArchiveRecoveryRangeEvidence(recovery.id, {
        rangeOffset: 0,
        rangeLimit: 1,
      })
    : null;
  const presentedRangeEvidence = rangeEvidence === null
    ? null
    : presentArchiveRecoveryRangeEvidence(rangeEvidence);
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [recovery.originalDiscArchiveId],
  })[0];
  const ownership = archive === undefined ||
      options.originalsLibraryPath === undefined
    ? null
    : (options.archiveImageOwnership ?? defaultArchiveImageOwnership).inspect({
        archiveId: archive.id,
        imagePath: archive.archivePath,
        originalsLibraryPath: options.originalsLibraryPath,
      });
  return {
    ...visibleArchiveRecovery(recovery),
    recoveryStatus: recovery.status,
    status: recoveryOwnsStatus
      ? reportedRecoveryStatus
      : reconciliation?.status ?? "idle",
    reconciliation: visibleDvdRecoveryReconciliation(reconciliation),
    checkpoint: access.catalog.findDvdArchiveEvidenceHeader(
      recovery.originalDiscArchiveId,
    ),
    ...(includeProgress
      ? {
          progress: presentedRangeEvidence?.progress ?? null,
          history: presentedRangeEvidence?.history ?? null,
        }
      : {}),
    availableActions: [
      {
        name: "reconcile",
        eligible: reconciliationBlockingReasons.length === 0,
        requiredInputs: ["mutationKey", "archiveRecoveryId"],
        reason: reconciliationBlockingReasons[0]?.message ?? null,
        blockingReasons: reconciliationBlockingReasons.map(({ message }) =>
          message
        ),
      },
      dvdRecoveryStopAction(recovery, encodeJobs),
      dvdRecoveryResumeAction({
        recovery,
        checkpoint: access.catalog.findDvdArchiveEvidenceHeader(
          recovery.originalDiscArchiveId,
        ),
        reconciliation,
        ownershipReasons: ownership?.stableRead.blockingReasons ?? [],
        storageReason: describeDvdRecoveryStorage(
          access.dvdRecoveryStorage.readCurrent(),
        ).blockingReasons[0] ?? null,
        encodeJobs,
      }),
    ],
  };
}

function presentEncodeJob(
  job: EncodeJob,
  correctionLinks: readonly EncodeJob[],
  retainedOutputs: Parameters<typeof encodeOutputArtifactReferences>[2],
  retainedHistoryTruncated: boolean,
) {
  const artifacts = encodeOutputArtifactReferences(
    job,
    correctionLinks,
    retainedOutputs,
  );
  const publishedArtifact = artifacts.find(({ state }) => state === "published");
  const {
    claimToken: _claimToken,
    claimedBy: _claimedBy,
    partialCleanupClaimToken: _partialCleanupClaimToken,
    partialCleanupLeaseToken: _partialCleanupLeaseToken,
    replacementOutputIdentity: _replacementOutputIdentity,
    outputValidationFilesystemIdentity: _outputValidationFilesystemIdentity,
    outputPath: _outputPath,
    partialCleanupOutputPath: _partialCleanupOutputPath,
    ...visibleJob
  } = job;
  return {
    ...visibleJob,
    encodeOutputArtifacts: artifacts,
    ...(retainedHistoryTruncated
      ? { encodeOutputArtifactsTruncated: true }
      : {}),
    ...(publishedArtifact === undefined
      ? {}
      : { encodeOutputArtifactIdentity: publishedArtifact.identity }),
  };
}

function inBatches<T, R>(
  values: readonly T[],
  read: (batch: readonly T[]) => readonly R[],
): R[] {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += 400) {
    results.push(...read(values.slice(index, index + 400)));
  }
  return results;
}

function correctionLinksForJobs(
  access: ConsistentReadAccess,
  ids: readonly EncodeJobId[],
) {
  return [...new Map(inBatches(
    [...new Set(ids)],
    (batch) => access.encodeJobs.listCorrectionLinks(batch),
  ).map((job) => [job.id, job])).values()];
}

function retainedOutputPageForJobs(
  access: ConsistentReadAccess,
  ids: readonly EncodeJobId[],
) {
  const pages = inBatches(
    [...new Set(ids)],
    (batch) => [access.encodeJobs.listRetainedOutputSummaryPageBySource(
      batch,
      { limit: 100 },
    )],
  );
  return {
    outputs: [...new Map(pages.flatMap(({ outputs }) => outputs)
      .map((output) => [output.id, output])).values()],
    truncatedSourceEncodeJobIds: [...new Set(pages.flatMap(
      ({ truncatedSourceEncodeJobIds }) => truncatedSourceEncodeJobIds,
    ))],
  };
}

function visibleEncodeJobs(
  access: ConsistentReadAccess,
  jobs: readonly EncodeJob[],
  options: {
    correctionLinks?: readonly EncodeJob[];
    retainedOutputs?: Parameters<typeof encodeOutputArtifactReferences>[2];
    truncatedSourceEncodeJobIds?: readonly EncodeJobId[];
  } = {},
) {
  if (jobs.length === 0) return [];
  const correctionLinks = options.correctionLinks ??
    correctionLinksForJobs(access, jobs.map(({ id }) => id));
  const relatedJobIds = correctionLinks.map(({ id }) => id);
  const retainedPage = options.retainedOutputs === undefined
    ? retainedOutputPageForJobs(access, relatedJobIds)
    : null;
  const retainedOutputs = options.retainedOutputs ??
    (retainedPage?.outputs ?? []);
  const truncatedJobIds = new Set(
    options.truncatedSourceEncodeJobIds ??
      retainedPage?.truncatedSourceEncodeJobIds ?? [],
  );
  return jobs.map((job) => presentEncodeJob(
    job,
    correctionLinks,
    retainedOutputs,
    truncatedJobIds.has(job.id),
  ));
}

function visibleArchive(
  archive: OriginalDiscArchive,
  evidenceHeadersByArchiveId: ReadonlyMap<
    OriginalDiscArchiveId,
    DvdArchiveEvidenceHeader
  >,
) {
  const evidenceHeader = evidenceHeadersByArchiveId.get(archive.id) ?? null;
  const {
    archivePath: _archivePath,
    integrityEvidenceRevision: _integrityEvidenceRevision,
    ...authoritativeArchive
  } = withAuthoritativeDvdArchiveIntegrity(archive, evidenceHeader);
  return {
    ...authoritativeArchive,
    storage: {
      recordedSizeBytes: archive.sizeBytes,
      verification: {
        status: archive.verificationStatus ?? "unknown",
        message: archive.verificationMessage,
        observedAt: archive.verifiedAt,
      },
    },
  };
}

function evidenceHeadersForArchives(
  access: Pick<ConsistentReadAccess, "catalog">,
  archives: readonly OriginalDiscArchive[],
) {
  const evidenceHeaders = new Map<
    OriginalDiscArchiveId,
    DvdArchiveEvidenceHeader
  >();
  const archiveIds = [...new Set(archives.map((archive) => archive.id))];
  for (
    let offset = 0;
    offset < archiveIds.length;
    offset += DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT
  ) {
    const batch = access.catalog.findDvdArchiveEvidenceHeaders(
      archiveIds.slice(
        offset,
        offset + DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT,
      ),
    );
    for (const [archiveId, evidenceHeader] of batch) {
      evidenceHeaders.set(archiveId, evidenceHeader);
    }
  }
  return evidenceHeaders;
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
  if (request.evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT) {
    const cancelEligible = ["pending", "running", "needs_attention"].includes(
      request.status,
    );
    return [
      recoveryAction(
        "cancel",
        cancelEligible,
        `Archive Request is ${request.status}.`,
        "archiveRequestId",
      ),
      recoveryAction(
        "retry",
        false,
        DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        "archiveRequestId",
        DVD_RECOVERY_EVIDENCE_ADMISSION.code,
      ),
    ];
  }
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
  blockingCode = "INVALID_TRANSITION",
) {
  return {
    name,
    eligible,
    requiredInputs: ["mutationKey", targetInput],
    reason: eligible ? null : reason,
    blockingReasons: eligible ? [] : [{ code: blockingCode, message: reason }],
  };
}

export function encodeRequeueAvailability(
  access: Pick<ConsistentReadAccess, "encodeJobs">,
  job: EncodeJob,
  selectionEligible: boolean,
  selectionBlockingReason: {
    code: string;
    message: string;
    current?: EncodeWorkConflictCurrent;
  } = {
    code: "INVALID_TRANSITION",
    message: "Requires an active Disc Selection with completed Catalog Review.",
  },
) {
  const replacesOutput = job.status === "completed" || job.replaceExistingOutput;
  const requiredInputs = replacesOutput
    ? [
      "mutationKey", "encodeJobId", "expectedRevision",
      "acknowledgeReplacement",
    ]
    : ["mutationKey", "encodeJobId"];
  const blocked = (reason: string, code = "INVALID_TRANSITION") => ({
    eligible: false,
    requiredInputs,
    reason,
    blockingReasons: [{ code, message: reason }],
  });
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    return blocked(`Encode Job is ${job.status}.`);
  }
  if (!selectionEligible) {
    return {
      eligible: false,
      requiredInputs,
      reason: selectionBlockingReason.message,
      blockingReasons: [selectionBlockingReason],
    };
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

function readList(
  access: ConsistentReadAccess,
  kind: OperationKind,
  limit: number,
  options: Pick<
    OperationInspectionOptions,
    "originalsLibraryPath" | "archiveImageOwnership"
  >,
) {
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
    case "archive-recoveries":
      return access.catalog.listArchiveRecoveries({ limit })
        .map((recovery) => archiveRecoveryOperation(access, recovery, options));
    case "original-disc-archives": {
      const archives = access.catalog.listOriginalDiscArchives({ limit });
      const evidenceHeaders = evidenceHeadersForArchives(access, archives);
      return archives.map((archive) => visibleArchive(archive, evidenceHeaders));
    }
    case "encode-jobs":
      return visibleEncodeJobs(access, recentWork(access.encodeJobs.list(undefined, {
        policy: boundedPolicy(limit),
      }), ["queued", "running", "cancellation_requested"], limit));
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

function readDetail(
  access: ConsistentReadAccess,
  kind: Exclude<OperationKind, "activity">,
  id: string,
  options: {
    limit: number;
    offset: number;
    originalsLibraryPath?: string;
    archiveImageOwnership?: Pick<ArchiveImageOwnership, "inspect">;
  },
) {
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
      const archives = access.catalog.listOriginalDiscArchives({
        detectedDiscId: disc.id,
      });
      const evidenceHeaders = evidenceHeadersForArchives(access, archives);
      return {
        ...visibleDisc(disc), scanData: disc.scanData,
        inspections: access.discInspections.list({ detectedDiscId: disc.id })
          .map(visibleInspection),
        archiveRequests: requests,
        currentArchiveRequest: relevantRequest,
        archiveJobs: access.archiveJobs.list(undefined, {
          detectedDiscIds: [disc.id],
        }).map(visibleArchiveJob),
        archives: archives.map((archive) =>
          visibleArchive(archive, evidenceHeaders)
        ),
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
      const archives = job.originalDiscArchiveId === null
        ? []
        : access.catalog.listOriginalDiscArchives({
            ids: [job.originalDiscArchiveId],
          });
      const evidenceHeaders = evidenceHeadersForArchives(access, archives);
      return {
        ...visibleArchiveJob(job),
        detectedDisc: access.catalog.listDetectedDiscs(undefined, {
          ids: [job.detectedDiscId],
        }).map(visibleDisc)[0] ?? null,
        archiveRequest: access.archiveRequests.find(job.archiveRequestId),
        discInspection: job.discInspectionId === null ? null :
          access.discInspections.list({ ids: [job.discInspectionId] })
            .map(visibleInspection)[0] ?? null,
        archive: archives.map((archive) =>
          visibleArchive(archive, evidenceHeaders)
        )[0] ?? null,
      };
    }
    case "archive-recoveries": {
      const recovery = access.catalog.findArchiveRecoveryById(
        id as ArchiveRecoveryId,
      );
      return recovery === null
        ? null
        : archiveRecoveryOperation(access, recovery, options, true);
    }
    case "original-disc-archives": {
      const archive = access.catalog.listOriginalDiscArchives({ ids: [id as OriginalDiscArchiveId] })[0];
      if (!archive) return null;
      const previousArchive = archive.rearchiveSourceArchiveId === null
        ? null
        : access.catalog.listOriginalDiscArchives({
            ids: [archive.rearchiveSourceArchiveId],
          })[0] ?? null;
      const newArchives = access.catalog.listOriginalDiscArchives({
        rearchiveSourceArchiveId: archive.id,
      });
      const relatedArchives = [
        archive,
        ...(previousArchive === null ? [] : [previousArchive]),
        ...newArchives,
      ];
      const evidenceHeaders = evidenceHeadersForArchives(
        access,
        relatedArchives,
      );
      const discSelections = access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
        includeHistorical: true,
      });
      const activeDiscSelectionIds = new Set(
        access.catalog.listDiscSelections({
          originalDiscArchiveId: archive.id,
        }).map(({ id }) => id),
      );
      const encodeJobs = discSelections.flatMap((selection) =>
        access.encodeJobs.listForDiscSelection(selection.id)
      );
      const conflictingEncodeJobs = activeEncodeWorkIdentities(encodeJobs);
      const rearchiveEligible = archive.discKind === "dvd";
      const rearchiveReason = rearchiveEligible
        ? null
        : "Fresh re-archive requests are supported only for DVD archives";
      const evidenceHeader = evidenceHeaders.get(archive.id) ?? null;
      const evidenceFormat = dvdRecoveryEvidenceFormatForArchive(
        evidenceHeader,
        access.archiveJobs.listForArchive(archive.id),
      );
      const structuralAssessment = evidenceFormat === null
        ? null
        : access.dvdStructuralAssessments.inspect(archive.id);
      const recoveryStorage = evidenceFormat === null
        ? null
        : describeDvdRecoveryStorage(
          access.dvdRecoveryStorage.readCurrent(),
        );
      const ownership = evidenceFormat === null ||
          options.originalsLibraryPath === undefined
        ? null
        : (options.archiveImageOwnership ?? defaultArchiveImageOwnership)
          .inspect({
            archiveId: archive.id,
            imagePath: archive.archivePath,
            originalsLibraryPath: options.originalsLibraryPath,
          });
      const recovery = evidenceFormat === null
        ? null
        : access.catalog.findArchiveRecovery(archive.id);
      const archiveArtifact = evidenceFormat === null
        ? null
        : describeArchiveArtifact(access, archive, {
            ...options,
            ...(ownership === null
              ? {}
              : { ownershipInspection: ownership }),
          });
      const encodeWorkConflict = conflictingEncodeJobs.length === 0
        ? null
        : {
          code: ENCODE_WORK_CONFLICT.code,
          message: ENCODE_WORK_CONFLICT.message,
          current: { encodeJobs: conflictingEncodeJobs },
        };
      return {
        ...visibleArchive(archive, evidenceHeaders),
        ...(structuralAssessment === null
          ? {}
          : { structuralAssessment }),
        ...(archiveArtifact === null ? {} : { archiveArtifact }),
        ...(recoveryStorage === null
          ? {}
          : {
            archiveRecovery: {
              record: recovery === null
                ? null
                : visibleArchiveRecovery(recovery),
              available: false,
              blockingReasons: [
                ...(ownership?.stableRead.blockingReasons ?? []),
                ...(encodeWorkConflict === null ? [] : [encodeWorkConflict]),
                {
                  code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
                  message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
                },
                ...recoveryStorage.blockingReasons,
              ],
              currentWork: {
                recovery: recovery?.work === undefined || recovery.work === null
                  ? null
                  : archiveRecoveryWorkIdentity(recovery.work),
                encodeJobs: conflictingEncodeJobs,
              },
              storage: recoveryStorage,
              ...(ownership === null ? {} : { ownership }),
            },
          }),
        detectedDisc: access.catalog.listDetectedDiscs(undefined, {
          ids: [archive.detectedDiscId],
        }).map(visibleDisc)[0] ?? null,
        archiveJobs: access.archiveJobs.listForArchive(archive.id)
          .map(visibleArchiveJob),
        lineage: {
          previousArchive: previousArchive === null
            ? null
            : visibleArchive(previousArchive, evidenceHeaders),
          newArchives: newArchives.map((newArchive) =>
            visibleArchive(newArchive, evidenceHeaders)
          ),
          rearchiveRequests: access.archiveRequests
            .listForRearchiveSources([archive.id]),
        },
        references: {
          discSelections: discSelections.map((selection) => ({
            ...selection,
            catalogStatus: activeDiscSelectionIds.has(selection.id)
              ? "active"
              : "historical",
          })),
          encodeJobs: visibleEncodeJobs(access, encodeJobs),
        },
        availableActions: [
          { name: "verify-archive", eligible: true, reason: null },
          {
            name: "request-rearchive",
            eligible: rearchiveEligible,
            requiredInputs: ["mutationKey", "sourceArchiveId"],
            reason: rearchiveReason,
            blockingReasons: rearchiveReason === null
              ? []
              : [rearchiveReason],
          },
        ],
      };
    }
    case "encode-jobs": {
      const job = access.encodeJobs.find(id as EncodeJobId);
      if (!job) return null;
      const selection = access.catalog.listDiscSelections({ ids: [job.discSelectionId] })[0];
      const archives = selection === undefined
        ? []
        : access.catalog.listOriginalDiscArchives({
            ids: [selection.originalDiscArchiveId],
          });
      const evidenceHeaders = evidenceHeadersForArchives(access, archives);
      const requeueSelectionEligible = access.catalog.listDiscSelections({
        ids: [job.discSelectionId], encodeEligibleOnly: true,
      }).length > 0;
      const evidenceBlocked = selection !== undefined &&
        dvdRecoveryEvidenceFormatForArchive(
          evidenceHeaders.get(selection.originalDiscArchiveId),
          access.archiveJobs.listForArchive(selection.originalDiscArchiveId),
        ) !== null;
      const recovery = selection === undefined
        ? null
        : access.catalog.findArchiveRecovery(selection.originalDiscArchiveId);
      const recoveryWork = recovery?.work ?? null;
      const recoveryConflict = recoveryWork === null || recovery === null
        ? null
        : {
          ...ENCODE_WORK_CONFLICT,
          current: createEncodeWorkConflictCurrent(
            recovery,
            access.catalog.listDiscSelections({
              originalDiscArchiveId: recovery.originalDiscArchiveId,
              includeHistorical: true,
            }).flatMap(({ id }) => access.encodeJobs.listForDiscSelection(id)),
          ),
        };
      const requeue = encodeRequeueAvailability(
        access,
        job,
        requeueSelectionEligible && recoveryConflict === null,
        recoveryConflict !== null
          ? recoveryConflict
          : evidenceBlocked
          ? DVD_RECOVERY_EVIDENCE_ENCODING
          : undefined,
      );
      const history = access.encodeJobs.listForDiscSelection(
        job.discSelectionId,
      );
      const correctionLinks = correctionLinksForJobs(
        access,
        [...new Set([job.id, ...history.map(({ id }) => id)])],
      );
      const relatedRetainedPage = retainedOutputPageForJobs(
        access,
        correctionLinks.map(({ id }) => id),
      );
      const outputPage = access.encodeJobs.listRetainedOutputHistoryPage(
        job.id,
        options,
      );
      const retainedOutputs = [
        ...relatedRetainedPage.outputs.filter(
          ({ sourceEncodeJobId }) => sourceEncodeJobId !== job.id,
        ),
        ...outputPage.outputs,
      ];
      const directCorrectionJobIds = new Set([
        job.id,
        ...(job.predecessorEncodeJobId === null
          ? []
          : [job.predecessorEncodeJobId]),
        ...correctionLinks.flatMap((candidate) =>
          candidate.predecessorEncodeJobId === job.id
            ? [candidate.id]
            : []
        ),
      ]);
      const directCorrectionLinks = correctionLinks.filter(({ id }) =>
        directCorrectionJobIds.has(id)
      );
      const directRetainedOutputs = retainedOutputs.filter((output) =>
        output.predecessorEncodeJobId === job.id ||
        output.replacementEncodeJobId === job.id
      );
      const relatedJobs = [...new Map(
        [job, ...history, ...correctionLinks].map((candidate) => [
          candidate.id,
          candidate,
        ]),
      ).values()];
      const visibleById = new Map(visibleEncodeJobs(access, relatedJobs, {
        correctionLinks,
        retainedOutputs,
        truncatedSourceEncodeJobIds: [
          ...relatedRetainedPage.truncatedSourceEncodeJobIds,
          ...(outputPage.nextOffset === null ? [] : [job.id]),
        ],
      }).map((candidate) => [candidate.id, candidate]));
      const visibleJob = visibleById.get(job.id)!;
      const claimPage = access.encodeJobs.listClaimSnapshots(job.id, { limit: options.limit + 1, offset: options.offset });
      const pageArtifacts = visibleJob.encodeOutputArtifacts.filter(
        ({ state }) => state === "retained" || options.offset === 0,
      );
      return {
        ...visibleJob,
        encodeOutputArtifacts: pageArtifacts,
        encodeOutputArtifactPage: {
          offset: options.offset,
          limit: options.limit,
          nextOffset: outputPage.nextOffset,
        },
        claimSnapshots: claimPage.slice(0, options.limit),
        claimSnapshotPage: { limit: options.limit, offset: options.offset, nextOffset: claimPage.length > options.limit ? options.offset + options.limit : null },
        failureReports: access.encodeJobs.listFailureReports([job.id]),
        discSelection: selection ?? null,
        archive: archives.map((archive) =>
          visibleArchive(archive, evidenceHeaders)
        )[0] ?? null,
        history: history.map((candidate) => visibleById.get(candidate.id)!),
        correctionLinks: directCorrectionLinks.map((candidate) =>
          visibleById.get(candidate.id)!
        ),
        retainedOutputs: directRetainedOutputs.map((output) => ({
          ...output,
          artifactIdentity: retainedEncodeOutputArtifactIdentity(output.id),
        })),
        ...(recovery === null
          ? {}
          : {
            currentWork: {
              recovery: {
                id: recovery.id,
                originalDiscArchiveId: recovery.originalDiscArchiveId,
                work: recovery.work === null
                  ? null
                  : archiveRecoveryWorkIdentity(recovery.work),
              },
            },
          }),
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
  options: OperationInspectionOptions = {},
) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  if (!validOperationLimit(limit) || !Number.isSafeInteger(offset) || offset < 0 ||
    (options.offset !== undefined &&
      (kind !== "encode-jobs" || options.id === undefined)) ||
    (kind === "activity" && options.id !== undefined)) {
    throw new RangeError("Invalid operation query.");
  }
  return access.readConsistentSnapshot((snapshot) =>
    options.id === undefined
      ? { schemaVersion: 1, kind, items: readList(snapshot, kind, limit, options) }
      : {
        schemaVersion: 1,
        kind,
        item: readDetail(
          snapshot,
          kind as Exclude<OperationKind, "activity">,
          options.id!,
          {
            limit,
            offset,
            ...(options.originalsLibraryPath === undefined
              ? {}
              : { originalsLibraryPath: options.originalsLibraryPath }),
            ...(options.archiveImageOwnership === undefined
              ? {}
              : { archiveImageOwnership: options.archiveImageOwnership }),
          },
        ),
      }
  );
}

export async function inspectOperationsWithArtifacts(
  access: DataAccess,
  kind: OperationKind,
  options: OperationInspectionOptions = {},
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspection = inspectOperations(access, kind, options);
    if (
      kind !== "original-disc-archives" || options.id === undefined ||
      !("item" in inspection) || inspection.item === null ||
      inspection.item === undefined ||
      !("archiveArtifact" in inspection.item)
    ) {
      return inspection;
    }
    const item = inspection.item as typeof inspection.item & {
      archiveArtifact: ArchiveArtifact;
    };
    try {
      const enrichedArtifact = await enrichArchiveArtifactSourceIdentity(
        access,
        item.archiveArtifact,
      );
      const refreshedInspection = inspectOperations(access, kind, options);
      if (
        !("item" in refreshedInspection) ||
        refreshedInspection.item === null ||
        refreshedInspection.item === undefined ||
        !("archiveArtifact" in refreshedInspection.item)
      ) {
        throw new ArchiveArtifactChangedError();
      }
      const refreshedItem = refreshedInspection.item as
        typeof refreshedInspection.item & { archiveArtifact: ArchiveArtifact };
      const refreshedEnrichedArtifact = await enrichArchiveArtifactSourceIdentity(
        access,
        refreshedItem.archiveArtifact,
      );
      if (
        JSON.stringify(enrichedArtifact) !==
          JSON.stringify(refreshedEnrichedArtifact)
      ) {
        throw new ArchiveArtifactChangedError();
      }
      return {
        ...refreshedInspection,
        item: {
          ...refreshedItem,
          archiveArtifact: refreshedEnrichedArtifact,
        },
      };
    } catch (error) {
      if (!(error instanceof ArchiveArtifactChangedError) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new ArchiveArtifactChangedError();
}

const TERMINAL_STATUSES: Record<WaitableKind, readonly string[]> = {
  "disc-inspections": ["completed", "failed", "aborted"],
  "archive-requests": ["fulfilled", "cancelled", "needs_attention"],
  "archive-jobs": ["completed", "failed", "cancelled", "aborted"],
  "archive-recoveries": [
    "paused",
    "completed",
    "failed",
    "stopped",
    "faulted",
  ],
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
