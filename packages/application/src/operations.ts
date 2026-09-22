import {
  WORKER_KINDS,
  type ArchiveJob,
  type ArchiveRequest,
  type ConsistentReadAccess,
  type DataAccess,
  type DetectedDisc,
  type DetectedDiscId,
  type DiscInspection,
  type DiscInspectionId,
  type EncodeJob,
  type OriginalDiscArchive,
  type OriginalDiscArchiveId,
  type OpticalDriveId,
  type WorkerIncident,
} from "@rip-dvd/data-access";

export const OPERATION_KINDS = [
  "optical-drives",
  "detected-discs",
  "disc-inspections",
  "archive-requests",
  "archive-jobs",
  "original-disc-archives",
  "encode-jobs",
  "worker-incidents",
  "activity",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type WaitableKind = Extract<OperationKind,
  "disc-inspections" | "archive-requests" | "archive-jobs" | "encode-jobs"
>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function isOperationKind(value: string): value is OperationKind {
  return OPERATION_KINDS.some((kind) => kind === value);
}

export function isWaitableKind(value: string): value is WaitableKind {
  return value === "disc-inspections" || value === "archive-requests" ||
    value === "archive-jobs" || value === "encode-jobs";
}

export function validOperationLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT;
}

function incidents(access: ConsistentReadAccess, limit: number) {
  return WORKER_KINDS.flatMap((workerKind) =>
    access.workerIncidents.list({ workerKind, resolvedLimit: limit })
  ).sort((left, right) =>
    right.lastObservedAt.getTime() - left.lastObservedAt.getTime() ||
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
  return [
    {
      name: "cancel",
      eligible: ["pending", "running", "needs_attention"].includes(request.status),
      reason: ["pending", "running", "needs_attention"].includes(request.status)
        ? null : `Archive Request is ${request.status}.`,
    },
    {
      name: "retry",
      eligible: request.status === "needs_attention",
      reason: request.status === "needs_attention" ? null :
        `Archive Request is ${request.status}.`,
    },
  ];
}

function inspectionActions(inspection: DiscInspection) {
  const eligible = inspection.isCurrent && inspection.status === "failed" &&
    inspection.manualRetryRequestedAt === null;
  return [{
    name: "retry",
    eligible,
    reason: eligible ? null : inspection.manualRetryRequestedAt !== null
      ? "Retry already requested."
      : inspection.isCurrent ? `Disc Inspection is ${inspection.status}.`
      : "Disc Inspection is no longer current.",
  }];
}

function encodeActions(job: EncodeJob) {
  return [{
    name: "request-cancellation",
    eligible: ["queued", "running"].includes(job.status),
    reason: ["queued", "running"].includes(job.status) ? null :
      `Encode Job is ${job.status}.`,
  }];
}

function activity(access: ConsistentReadAccess, limit: number) {
  const entries = [
    ...access.discInspections.list({ limit }).map((item) => ({
      kind: "disc-inspections", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.archiveRequests.list(undefined, {
      policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
    }).map((item) => ({
      kind: "archive-requests", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.archiveJobs.list(undefined, {
      policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
    }).map((item) => ({
      kind: "archive-jobs", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...access.encodeJobs.list(undefined, {
      policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
    }).map((item) => ({
      kind: "encode-jobs", id: item.id, status: item.status,
      occurredAt: item.updatedAt,
    })),
    ...incidents(access, limit).map((item) => ({
      kind: "worker-incidents", id: item.id,
      status: item.resolvedAt === null ? "active" : "recovered",
      occurredAt: item.lastObservedAt,
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
        policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
      }), ["detected", "scanned", "approved"], limit).map(visibleDisc);
    case "disc-inspections":
      return access.discInspections.list({ limit }).map(visibleInspection);
    case "archive-requests":
      return recentWork(access.archiveRequests.list(undefined, {
        policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
      }), ["pending", "running", "needs_attention", "cancellation_requested"], limit);
    case "archive-jobs":
      return recentWork(access.archiveJobs.list(undefined, {
        policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
      }), ["running"], limit).map(visibleArchiveJob);
    case "original-disc-archives":
      return access.catalog.listOriginalDiscArchives({ limit }).map(visibleArchive);
    case "encode-jobs":
      return recentWork(access.encodeJobs.list(undefined, {
        policy: { mode: "active-and-history", activeLimit: limit, historyLimit: limit },
      }), ["queued", "running", "cancellation_requested"], limit).map(visibleEncodeJob);
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
        inspections: access.discInspections.list().filter((item) =>
          item.opticalDriveId === id
        ).map(visibleInspection),
      };
    }
    case "detected-discs": {
      const disc = access.catalog.listDetectedDiscs(undefined, { ids: [id as DetectedDiscId] })[0];
      if (!disc) return null;
      return {
        ...visibleDisc(disc), scanData: disc.scanData,
        inspections: access.discInspections.list().filter((item) =>
          item.detectedDiscId === id
        ).map(visibleInspection),
        archiveRequests: access.archiveRequests.list().filter((item) =>
          item.detectedDiscId === id
        ),
        archiveJobs: access.archiveJobs.list(undefined, {
          detectedDiscIds: [disc.id],
        }).map(visibleArchiveJob),
        archives: access.catalog.listOriginalDiscArchives().filter((item) =>
          item.detectedDiscId === id
        ).map(visibleArchive),
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
        archiveJobs: access.archiveJobs.list().filter((item) =>
          item.discInspectionId === id
        ).map(visibleArchiveJob),
        availableActions: inspectionActions(inspection),
      };
    }
    case "archive-requests": {
      const request = access.archiveRequests.list().find((item) => item.id === id);
      if (!request) return null;
      return {
        ...request,
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
      const job = access.archiveJobs.list().find((item) => item.id === id);
      if (!job) return null;
      return {
        ...visibleArchiveJob(job),
        archiveRequest: access.archiveRequests.list().find((item) =>
          item.id === job.archiveRequestId
        ) ?? null,
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
        archiveJobs: access.archiveJobs.list().filter((item) =>
          item.originalDiscArchiveId === id
        ).map(visibleArchiveJob),
      };
    }
    case "encode-jobs": {
      const job = access.encodeJobs.list().find((item) => item.id === id);
      if (!job) return null;
      const selection = access.catalog.listDiscSelections({ ids: [job.discSelectionId] })[0];
      return {
        ...visibleEncodeJob(job),
        failureReports: access.encodeJobs.listFailureReports([job.id]),
        discSelection: selection ?? null,
        archive: selection ? access.catalog.listOriginalDiscArchives({
          ids: [selection.originalDiscArchiveId],
        }).map(visibleArchive)[0] ?? null : null,
        history: access.encodeJobs.list().filter((item) =>
          item.discSelectionId === job.discSelectionId
        ).map(visibleEncodeJob),
        availableActions: encodeActions(job),
      };
    }
    case "worker-incidents": {
      const incident = incidents(access, 100).find((item: WorkerIncident) => item.id === id);
      return incident ? visibleIncident(incident) : null;
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
