import {
  DVD_RECOVERY_EVIDENCE_ADMISSION,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  WORKER_KINDS,
  withAuthoritativeDvdArchiveIntegrity,
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
import {
  encodeOutputArtifactReferences,
  retainedEncodeOutputArtifactIdentity,
} from "./encode-output-inspection.js";

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
  access: Pick<ConsistentReadAccess, "catalog">,
  archive: OriginalDiscArchive,
) {
  const evidenceHeader = access.catalog.findDvdArchiveEvidenceHeader(
    archive.id,
  );
  const {
    archivePath: _archivePath,
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
    return [
      recoveryAction(
        "cancel",
        false,
        DVD_RECOVERY_EVIDENCE_ADMISSION.message,
        "archiveRequestId",
        DVD_RECOVERY_EVIDENCE_ADMISSION.code,
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
    return blocked(
      selectionBlockingReason.message,
      selectionBlockingReason.code,
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
      return access.catalog.listOriginalDiscArchives({ limit })
        .map((archive) => visibleArchive(access, archive));
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
  options: { limit: number; offset: number },
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
          .map((archive) => visibleArchive(access, archive)),
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
            .map((archive) => visibleArchive(access, archive))[0] ?? null,
      };
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
      const rearchiveEligible = archive.discKind === "dvd";
      const rearchiveReason = rearchiveEligible
        ? null
        : "Fresh re-archive requests are supported only for DVD archives";
      return {
        ...visibleArchive(access, archive),
        detectedDisc: access.catalog.listDetectedDiscs(undefined, {
          ids: [archive.detectedDiscId],
        }).map(visibleDisc)[0] ?? null,
        archiveJobs: access.archiveJobs.listForArchive(archive.id)
          .map(visibleArchiveJob),
        lineage: {
          previousArchive: previousArchive === null
            ? null
            : visibleArchive(access, previousArchive),
          newArchives: newArchives.map((newArchive) =>
            visibleArchive(access, newArchive)
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
      const requeueSelectionEligible = access.catalog.listDiscSelections({
        ids: [job.discSelectionId], encodeEligibleOnly: true,
      }).length > 0;
      const evidenceBlocked = selection !== undefined &&
        access.catalog.findDvdArchiveEvidenceHeader(
          selection.originalDiscArchiveId,
        ) !== null;
      const requeue = encodeRequeueAvailability(
        access,
        job,
        requeueSelectionEligible,
        evidenceBlocked
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
        failureReports: access.encodeJobs.listFailureReports([job.id]),
        discSelection: selection ?? null,
        archive: selection ? access.catalog.listOriginalDiscArchives({
          ids: [selection.originalDiscArchiveId],
        }).map((archive) => visibleArchive(access, archive))[0] ?? null : null,
        history: history.map((candidate) => visibleById.get(candidate.id)!),
        correctionLinks: directCorrectionLinks.map((candidate) =>
          visibleById.get(candidate.id)!
        ),
        retainedOutputs: directRetainedOutputs.map((output) => ({
          ...output,
          artifactIdentity: retainedEncodeOutputArtifactIdentity(output.id),
        })),
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
  options: { id?: string; limit?: number; offset?: number } = {},
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
      ? { schemaVersion: 1, kind, items: readList(snapshot, kind, limit) }
      : {
        schemaVersion: 1,
        kind,
        item: readDetail(
          snapshot,
          kind as Exclude<OperationKind, "activity">,
          options.id!,
          { limit, offset },
        ),
      }
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
