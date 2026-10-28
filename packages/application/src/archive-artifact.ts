import {
  activeEncodeWorkIdentities,
  archiveBoundaryEvidenceFromRecord,
  archiveRecoveryWorkIdentity,
  dvdRecoveryEvidenceFormatForArchive,
  type ArchiveRecovery,
  type ConsistentReadAccess,
  type DataAccess,
  type OriginalDiscArchive,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { describeCatalogReviewWorkflow } from "./catalog-review-workflow.js";
import { inspectDvdDiscSourceIdentity } from "./dvd-disc-confirmation.js";
import { presentArchiveRecoveryRangeEvidence } from "./archive-recovery-ranges.js";
import { visibleArchiveRecovery } from "./archive-recovery-view.js";
import {
  dvdRecoveryReconciliationBlockingReasons,
} from "./dvd-recovery-reconciliation.js";
import { dvdRecoveryResumeAction } from "./dvd-recovery-resume.js";
import { describeDvdRecoveryStorage } from "./dvd-recovery-storage.js";
import { dvdRecoveryStopAction } from "./dvd-recovery-stop.js";

export type ArchiveArtifactRecoveryState =
  | "running"
  | "waiting"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "faulted"
  | "unavailable";

export interface ArchiveArtifactReason {
  code: string;
  message: string;
  current?: Readonly<Record<string, unknown>>;
}

export interface ArchiveArtifactAction {
  name: "stop" | "resume" | "verify-disc" | "confirm-disc" | "reconcile";
  available: boolean;
  blockingReasons: readonly ArchiveArtifactReason[];
  requiredInputs: readonly string[];
  expectedInputs: Readonly<Record<string, unknown>> | null;
}

export interface ArchiveArtifact {
  schemaVersion: 1;
  evidenceFormat: "dvd-recovery-evidence-v1";
  originalDiscArchiveId: string;
  initialPreservation: {
    saved: boolean;
    archiveRequest: { id: string; status: string } | null;
    archiveJob: { id: string; status: string } | null;
  };
  recovery: {
    state: ArchiveArtifactRecoveryState;
    record: ReturnType<typeof visibleArchiveRecovery> | null;
    checkpoint: {
      revision: number;
      manifestDigest: string;
      acceptedEndLbaExclusive: number;
    } | null;
    progress: ReturnType<typeof presentArchiveRecoveryRangeEvidence>["progress"] | null;
    history: ReturnType<typeof presentArchiveRecoveryRangeEvidence>["history"] | null;
    currentWork: {
      recovery: ReturnType<typeof archiveRecoveryWorkIdentity> | null;
      encodeJobs: ReturnType<typeof activeEncodeWorkIdentities>;
    };
    reconciliation: {
      id: string;
      status: string;
      phase: string;
      outcome: string | null;
      failureCode: string | null;
    } | null;
  };
  readiness: {
    sourceStability: {
      ready: boolean;
      state: "stable" | "recovering" | "paused" | "stopping" | "faulted" | "unavailable";
      reasons: readonly ArchiveArtifactReason[];
    };
    titleAssessment: {
      ready: boolean;
      state: "current" | "pending" | "outdated" | "unavailable";
      assessmentIdentity: string | null;
      reasons: readonly ArchiveArtifactReason[];
    };
    encodeEligibility: {
      ready: boolean;
      reasons: readonly ArchiveArtifactReason[];
      expectedInputs: readonly string[];
    };
  };
  sourceIdentity: {
    currentInsertion: {
      discInspectionId: string;
      detectedDiscId: string;
      mediaGeneration: string;
    } | null;
    verification: {
      id: string;
      discInspectionId: string;
      detectedDiscId: string;
      mediaGeneration: string;
      status: string;
      outcome: string | null;
      current: boolean;
      reasons: readonly string[];
    } | null;
    confirmation: {
      id: string;
      current: boolean;
      verificationOutcome: string;
      expiredAt: string | null;
      expiryReason: string | null;
    } | null;
  };
  actions: readonly ArchiveArtifactAction[];
}

export class ArchiveArtifactChangedError extends Error {
  constructor() {
    super("Archive artifact identities changed during inspection");
    this.name = "ArchiveArtifactChangedError";
  }
}

function uniqueReasons(
  reasons: readonly (ArchiveArtifactReason | null)[],
): ArchiveArtifactReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason): reason is ArchiveArtifactReason => {
    if (reason === null || seen.has(reason.code)) return false;
    seen.add(reason.code);
    return true;
  });
}

function presentedRecoveryState(
  recovery: ArchiveRecovery | null,
): ArchiveArtifactRecoveryState {
  if (recovery === null) return "unavailable";
  if (recovery.status === "eligible" || recovery.status === "running") {
    return "running";
  }
  if (recovery.status === "waiting_for_disc") return "waiting";
  return recovery.status;
}

function sourceState(
  recoveryState: ArchiveArtifactRecoveryState,
): ArchiveArtifact["readiness"]["sourceStability"]["state"] {
  if (recoveryState === "stopped" || recoveryState === "completed") {
    return "stable";
  }
  if (recoveryState === "paused") return "paused";
  if (recoveryState === "stopping") return "stopping";
  if (recoveryState === "faulted") return "faulted";
  if (recoveryState === "unavailable") return "unavailable";
  return "recovering";
}

function unavailableRecoveryAction(
  name: ArchiveArtifactAction["name"],
  reason: ArchiveArtifactReason,
  requiredInputs: readonly string[],
): ArchiveArtifactAction {
  return {
    name,
    available: false,
    blockingReasons: [reason],
    requiredInputs,
    expectedInputs: null,
  };
}

function recoveryAction(
  name: "stop" | "resume",
  action: {
    available: boolean;
    blockingReasons: readonly ArchiveArtifactReason[];
    requiredInputs: readonly string[];
    expectedInputs: Readonly<Record<string, unknown>> | null;
  },
): ArchiveArtifactAction {
  return { ...action, name };
}

const CONFIRM_DISC_REQUIRED_INPUTS = [
  "mutationKey",
  "archiveRecoveryId",
  "originalDiscArchiveId",
  "archiveRecoveryAttemptId",
  "discInspectionId",
  "detectedDiscId",
  "mediaGeneration",
  "verificationId",
  "verificationWorkerExecutionId",
  "verificationOutcome",
  "verificationResultDigest",
  "checkpointRevision",
  "checkpointDigest",
  "acknowledgeMixedSource",
] as const;

export function describeArchiveArtifact(
  access: ConsistentReadAccess,
  archive: OriginalDiscArchive,
  options: {
    originalsLibraryPath?: string;
    archiveImageOwnership?: Pick<ArchiveImageOwnership, "inspect">;
    ownershipInspection?: ReturnType<ArchiveImageOwnership["inspect"]>;
  } = {},
): ArchiveArtifact | null {
  const archiveJobs = access.archiveJobs.listForArchive(archive.id);
  const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(archive.id);
  if (dvdRecoveryEvidenceFormatForArchive(checkpoint, archiveJobs) === null) {
    return null;
  }
  const archiveJob = checkpoint === null
    ? archiveJobs.find(({ evidenceFormat }) =>
        evidenceFormat === "dvd-recovery-evidence-v1"
      ) ?? null
    : archiveJobs.find(({ id }) => id === checkpoint.sourceArchiveJobId) ??
      null;
  const archiveRequest = archiveJob === null
    ? null
    : access.archiveRequests.find(archiveJob.archiveRequestId);
  const recovery = access.catalog.findArchiveRecovery(archive.id);
  const recoveryState = presentedRecoveryState(recovery);
  const rangeEvidence = recovery === null || checkpoint === null
    ? null
    : access.catalog.readDvdArchiveRecoveryRangeEvidence(recovery.id, {
        rangeOffset: 0,
        rangeLimit: 1,
      });
  const evidence = rangeEvidence === null
    ? null
    : presentArchiveRecoveryRangeEvidence(rangeEvidence);
  const discSelections = access.catalog.listDiscSelections({
    originalDiscArchiveId: archive.id,
    includeHistorical: true,
  });
  const encodeJobs = discSelections.flatMap(({ id }) =>
    access.encodeJobs.listForDiscSelection(id)
  );
  const activeEncodeJobs = activeEncodeWorkIdentities(encodeJobs);
  const reconciliation = recovery === null
    ? null
    : access.dvdRecoveryReconciliations.findLatestForRecovery(recovery.id);
  const storage = describeDvdRecoveryStorage(
    access.dvdRecoveryStorage.readCurrent(),
  );
  const ownership = options.ownershipInspection ??
    (options.originalsLibraryPath === undefined
    ? null
    : (options.archiveImageOwnership ?? defaultArchiveImageOwnership).inspect({
        archiveId: archive.id,
        imagePath: archive.archivePath,
        originalsLibraryPath: options.originalsLibraryPath,
      }));
  const boundaryReason = archiveBoundaryEvidenceFromRecord(archive) === null
    ? {
        code: "BOUNDARY_UNPROVEN",
        message: "The Original Disc Archive has no proved publication boundary.",
      }
    : null;
  const checkpointReason = checkpoint === null
    ? {
        code: "CONSISTENCY_FAULT",
        message: "The committed DVD checkpoint is unavailable.",
      }
    : null;
  const recoveryReason = recovery === null
    ? {
        code: "CONSISTENCY_FAULT",
        message: "Archive Recovery state is unavailable.",
      }
    : recoveryState === "paused"
      ? {
          code: "RECOVERY_PAUSED",
          message: "Archive Recovery is paused and may resume source updates.",
        }
      : recoveryState === "stopping"
        ? {
            code: "RECOVERY_STOPPING",
            message: "Archive Recovery is stopping and is not stable yet.",
          }
        : recoveryState === "faulted"
          ? {
              code: "RECOVERY_FAULTED",
              message: "Archive Recovery faulted before reaching a stable terminal state.",
            }
          : recoveryState === "stopped" || recoveryState === "completed"
            ? null
            : {
                code: "RECOVERY_ACTIVE",
                message: "Archive Recovery may still update the saved image.",
              };
  const reconciliationReason = reconciliation === null ||
      reconciliation.status === "completed"
    ? null
    : {
        code: reconciliation.status === "failed"
          ? "CONSISTENCY_FAULT"
          : "RECOVERY_RECONCILIATION_ACTIVE",
        message: reconciliation.status === "failed"
          ? "Archive Recovery checkpoint reconciliation failed."
          : "Archive Recovery checkpoint reconciliation is active.",
      };
  const sourceReasons = uniqueReasons([
    boundaryReason,
    checkpointReason,
    ...(ownership?.stableRead.blockingReasons ?? []),
    reconciliationReason,
    recoveryReason,
  ]);
  const sourceStabilityState = sourceState(recoveryState);
  const titleAssessment = access.dvdTitleDamageAssessments.inspect(archive.id);
  const titleReasons = titleAssessment.state === "current"
    ? []
    : titleAssessment.unavailableReasons.map(({ code, message }) => ({
        code,
        message,
      }));
  const workflow = describeCatalogReviewWorkflow(access, archive.id);
  if (workflow === null) {
    throw new Error("Archive artifact workflow is unavailable");
  }
  const encode = workflow.actions.find(({ action }) => action === "encode");
  if (encode === undefined) {
    throw new Error("Archive artifact workflow is missing encode readiness");
  }
  const recoveryUnavailable = {
    code: "CONSISTENCY_FAULT",
    message: "Archive Recovery state is unavailable.",
  };
  const reconciliationBlockingReasons = recovery === null
    ? []
    : dvdRecoveryReconciliationBlockingReasons(recovery, reconciliation);
  const actions: ArchiveArtifactAction[] = recovery === null
    ? [
        unavailableRecoveryAction("stop", recoveryUnavailable, [
          "mutationKey",
          "archiveRecoveryId",
          "attemptId",
        ]),
        unavailableRecoveryAction("resume", recoveryUnavailable, [
          "mutationKey",
          "archiveRecoveryId",
          "attemptId",
          "checkpointRevision",
          "checkpointDigest",
          "speedMode",
        ]),
        unavailableRecoveryAction("verify-disc", recoveryUnavailable, [
          "mutationKey",
          "archiveRecoveryId",
          "discInspectionId",
          "checkpointRevision",
          "checkpointDigest",
        ]),
        unavailableRecoveryAction(
          "confirm-disc",
          recoveryUnavailable,
          CONFIRM_DISC_REQUIRED_INPUTS,
        ),
        unavailableRecoveryAction("reconcile", recoveryUnavailable, [
          "mutationKey",
          "archiveRecoveryId",
        ]),
      ]
    : [
        recoveryAction("stop", dvdRecoveryStopAction(recovery, encodeJobs)),
        recoveryAction("resume", dvdRecoveryResumeAction({
          recovery,
          checkpoint,
          reconciliation,
          ownershipReasons: ownership?.stableRead.blockingReasons ?? [],
          storageReason: storage.blockingReasons[0] ?? null,
          encodeJobs,
        })),
        {
          name: "reconcile",
          available: reconciliationBlockingReasons.length === 0,
          blockingReasons: reconciliationBlockingReasons,
          requiredInputs: ["mutationKey", "archiveRecoveryId"],
          expectedInputs: { archiveRecoveryId: recovery.id },
        },
      ];

  return {
    schemaVersion: 1,
    evidenceFormat: "dvd-recovery-evidence-v1",
    originalDiscArchiveId: archive.id,
    initialPreservation: {
      saved: archiveJob?.status === "completed",
      archiveRequest: archiveRequest === null
        ? null
        : { id: archiveRequest.id, status: archiveRequest.status },
      archiveJob: archiveJob === null
        ? null
        : { id: archiveJob.id, status: archiveJob.status },
    },
    recovery: {
      state: recoveryState,
      record: recovery === null ? null : visibleArchiveRecovery(recovery),
      checkpoint: checkpoint === null
        ? null
        : {
            revision: checkpoint.currentManifestRevision,
            manifestDigest: checkpoint.currentManifestDigest,
            acceptedEndLbaExclusive: checkpoint.acceptedEndLbaExclusive,
          },
      progress: evidence?.progress ?? null,
      history: evidence?.history ?? null,
      currentWork: {
        recovery: recovery?.work === null || recovery?.work === undefined
          ? null
          : archiveRecoveryWorkIdentity(recovery.work),
        encodeJobs: activeEncodeJobs,
      },
      reconciliation: reconciliation === null
        ? null
        : {
            id: reconciliation.id,
            status: reconciliation.status,
            phase: reconciliation.phase,
            outcome: reconciliation.outcome,
            failureCode: reconciliation.failureCode,
          },
    },
    readiness: {
      sourceStability: {
        ready: sourceReasons.length === 0 && sourceStabilityState === "stable",
        state: sourceStabilityState,
        reasons: sourceReasons,
      },
      titleAssessment: {
        ready: titleAssessment.state === "current",
        state: titleAssessment.state,
        assessmentIdentity: titleAssessment.currentAssessmentIdentity,
        reasons: titleReasons,
      },
      encodeEligibility: {
        ready: encode.available,
        reasons: encode.reasons,
        expectedInputs: encode.expectedInputs,
      },
    },
    sourceIdentity: {
      currentInsertion: null,
      verification: null,
      confirmation: null,
    },
    actions,
  };
}

function mergeAction(
  actions: readonly ArchiveArtifactAction[],
  action: ArchiveArtifactAction,
): ArchiveArtifactAction[] {
  return [
    ...actions.filter(({ name }) => name !== action.name),
    action,
  ];
}

const ARCHIVE_ARTIFACT_ACTION_ORDER: readonly ArchiveArtifactAction["name"][] = [
  "stop",
  "resume",
  "verify-disc",
  "confirm-disc",
  "reconcile",
];

export async function enrichArchiveArtifactSourceIdentity(
  access: DataAccess,
  artifact: ArchiveArtifact,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
): Promise<ArchiveArtifact> {
  const recoveryId = artifact.recovery.record?.id;
  if (recoveryId === undefined) return artifact;
  const sourceIdentity = await inspectDvdDiscSourceIdentity(
    access,
    recoveryId,
    archiveImageOwnership,
  );
  const confirmation = sourceIdentity.preview;
  const inspectedRecovery = confirmation.archiveRecovery;
  const inspectedCheckpoint = confirmation.checkpoint;
  if (
    inspectedRecovery.originalDiscArchiveId !== artifact.originalDiscArchiveId ||
    inspectedRecovery.id !== artifact.recovery.record?.id ||
    inspectedRecovery.attemptId !== artifact.recovery.record.attemptId ||
    inspectedRecovery.status !== artifact.recovery.record.status ||
    (inspectedCheckpoint !== null &&
      (inspectedCheckpoint.revision !== artifact.recovery.checkpoint?.revision ||
        inspectedCheckpoint.digest !==
          artifact.recovery.checkpoint?.manifestDigest))
  ) {
    throw new ArchiveArtifactChangedError();
  }
  const verificationAction: ArchiveArtifactAction = {
    name: "verify-disc",
    available: sourceIdentity.verificationAction.available,
    blockingReasons: sourceIdentity.verificationAction.blockingReasons,
    requiredInputs: [
      "mutationKey",
      "archiveRecoveryId",
      "discInspectionId",
      "checkpointRevision",
      "checkpointDigest",
    ],
    expectedInputs: sourceIdentity.verificationAction.expectedInputs,
  };
  const confirmationAction: ArchiveArtifactAction = {
    name: "confirm-disc",
    available: confirmation.action.available,
    blockingReasons: confirmation.action.blockingReasons,
    requiredInputs: CONFIRM_DISC_REQUIRED_INPUTS,
    expectedInputs: confirmation.action.expectedInputs,
  };
  const actions = mergeAction(
    mergeAction(artifact.actions, verificationAction),
    confirmationAction,
  ).sort((left, right) =>
    ARCHIVE_ARTIFACT_ACTION_ORDER.indexOf(left.name) -
    ARCHIVE_ARTIFACT_ACTION_ORDER.indexOf(right.name)
  );
  return {
    ...artifact,
    sourceIdentity: {
      currentInsertion: confirmation.insertion,
      verification: confirmation.verification,
      confirmation: confirmation.confirmation,
    },
    actions,
  };
}
