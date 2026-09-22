import {
  discSelectionSourceDescription,
  encodingProfileQueueBlockingReasons,
  type ConsistentReadAccess,
  type DataAccess,
  type DiscSelection,
  type DiscSelectionId,
  type EncodeQueueHistoryGroup,
  type EncodeJob,
  type EncodeJobId,
  type EncodingProfile,
  type EncodingProfileId,
  RecordNotFoundError,
} from "@rip-dvd/data-access";

import { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";
import { mediaOutputPath, suggestedMediaOutputPath } from "./media-output-path.js";
import { encodeRequeueAvailability } from "./operations.js";

const ENCODE_SELECTION_PAGE_SIZE = 100;
const ENCODE_PROFILE_PAGE_SIZE = 100;

function isQueueEligibleProfile(profile: EncodingProfile): boolean {
  return encodingProfileQueueBlockingReasons(profile).length === 0;
}

function requireQueueEligibleProfile(
  snapshot: ConsistentReadAccess,
  encodingProfileId: EncodingProfileId,
): void {
  if (snapshot.encodingProfiles.list({
    ids: [encodingProfileId],
    mediaDomain: "dvd_video",
    activeOnly: true,
  }).filter(isQueueEligibleProfile).length !== 1) {
    throw new RecordNotFoundError(
      "eligible DVD video Encoding Profile",
      encodingProfileId,
    );
  }
}

export class InvalidEncodeJobInputError extends Error {
  constructor(message = "Invalid Encode Job command") {
    super(message);
    this.name = "InvalidEncodeJobInputError";
  }
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 256) {
    throw new InvalidEncodeJobInputError();
  }
  return value.trim();
}

export function enqueueEncodeJob(
  access: DataAccess,
  mediaLibraryPath: string,
  input: {
    discSelectionId: unknown;
    encodingProfileId: unknown;
    outputPath: unknown;
    priority?: unknown;
    mutationKey?: string;
  },
): EncodeJob {
  return access.encodeJobs.enqueue(parseEncodeEnqueueInput(mediaLibraryPath, input));
}

export function parseEncodeEnqueueInput(
  mediaLibraryPath: string,
  input: {
    discSelectionId: unknown;
    encodingProfileId: unknown;
    outputPath: unknown;
    priority?: unknown;
    mutationKey?: string;
  },
) {
  const discSelectionId = requiredId(input.discSelectionId) as DiscSelectionId;
  const encodingProfileId = requiredId(input.encodingProfileId) as EncodingProfileId;
  const outputPath = mediaOutputPath(input.outputPath, mediaLibraryPath);
  const priority = input.priority ?? 0;
  if (outputPath === null || !Number.isSafeInteger(priority)) {
    throw new InvalidEncodeJobInputError("Invalid Encode Job output path or priority");
  }
  return {
    discSelectionId, encodingProfileId, outputPath,
    priority: priority as number,
    mutationKey: input.mutationKey,
  };
}

export function requeueEncodeJob(
  access: DataAccess,
  mediaLibraryPath: string,
  input: {
    encodeJobId: unknown;
    outputPath?: unknown;
    priority?: unknown;
    mutationKey?: string;
    expectedRevision?: unknown;
    acknowledgeReplacement?: unknown;
  },
): EncodeJob {
  const encodeJobId = requiredId(input.encodeJobId) as EncodeJobId;
  const outputPath = input.outputPath === undefined
    ? undefined : mediaOutputPath(input.outputPath, mediaLibraryPath);
  if (outputPath === null ||
    (input.priority !== undefined && !Number.isSafeInteger(input.priority))) {
    throw new InvalidEncodeJobInputError("Invalid Encode Job output path or priority");
  }
  const expectedRevision = typeof input.expectedRevision === "string"
    ? input.expectedRevision
    : undefined;
  return access.encodeJobs.requeue(encodeJobId, {
    outputPath,
    priority: input.priority as number | undefined,
    mutationKey: input.mutationKey,
    expectedRevision,
    acknowledgeReplacement: input.acknowledgeReplacement === true,
  });
}

export function previewEncodeRequeue(
  access: DataAccess,
  input: { encodeJobId: unknown },
) {
  const encodeJobId = requiredId(input.encodeJobId) as EncodeJobId;
  const job = access.encodeJobs.find(encodeJobId);
  if (job === null) {
    throw new RecordNotFoundError("Encode Job", encodeJobId);
  }
  const replacesOutput = job.status === "completed" || job.replaceExistingOutput;
  return {
    encodeJobId: job.id,
    status: job.status,
    revision: job.updatedAt.toISOString(),
    replacesOutput,
    outputPath: replacesOutput ? job.outputPath : null,
    acknowledgementRequired: replacesOutput,
  };
}

export function cancelEncodeJob(
  access: DataAccess,
  input: { encodeJobId: unknown; mutationKey?: string },
): EncodeJob {
  return access.encodeJobs.requestCancellation(
    requiredId(input.encodeJobId) as EncodeJobId,
    input.mutationKey,
  );
}

export function serializeJob(job: EncodeJob) {
  return {
    id: job.id,
    discSelectionId: job.discSelectionId,
    encodingProfileId: job.encodingProfileId,
    outputPath: job.outputPath,
    status: job.status,
    priority: job.priority,
    progressPhase: job.progressPhase,
    progressPercent: job.progressPercent,
    progressEtaSeconds: job.progressEtaSeconds,
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function outputPathSelectionQualifier(
  selection: DiscSelection,
  hasMultipleSelections: boolean,
): string | null {
  if (!hasMultipleSelections) {
    return null;
  }
  const description = selection.label?.trim() ||
    discSelectionSourceDescription(selection.sourceIdentity);
  return `${description} ${selection.id.slice(-8)}`;
}

export function readQueueOptions(
  access: DataAccess,
  selectionOffset: number,
  profileOffset: number,
  mediaLibraryPath: string,
  historyGroup: EncodeQueueHistoryGroup,
  query?: string,
  encodingProfileId?: EncodingProfileId,
) {
  return access.readConsistentSnapshot((snapshot) => {
    if (encodingProfileId !== undefined) {
      requireQueueEligibleProfile(snapshot, encodingProfileId);
    }
    const selectionPage = snapshot.encodeJobs.listQueueDiscSelections({
      historyGroup,
      encodingProfileId,
      query,
      limit: ENCODE_SELECTION_PAGE_SIZE,
      offset: selectionOffset,
    });
    const selections = selectionPage.selections.map(({ selection }) => selection);
    const eligibleProfiles: EncodingProfile[] = [];
    for (
      let offset = 0;
      eligibleProfiles.length <= profileOffset + ENCODE_PROFILE_PAGE_SIZE;
      offset += ENCODE_PROFILE_PAGE_SIZE
    ) {
      const batch = snapshot.encodingProfiles.list({
        mediaDomain: "dvd_video",
        activeOnly: true,
        limit: ENCODE_PROFILE_PAGE_SIZE,
        offset,
      });
      eligibleProfiles.push(...batch.filter(isQueueEligibleProfile));
      if (batch.length < ENCODE_PROFILE_PAGE_SIZE) break;
    }
    const profileRecords = eligibleProfiles.slice(
      profileOffset,
      profileOffset + ENCODE_PROFILE_PAGE_SIZE + 1,
    );
    const hasNextProfile = profileRecords.length > ENCODE_PROFILE_PAGE_SIZE;
    const profiles = profileRecords.slice(0, ENCODE_PROFILE_PAGE_SIZE);
    const mediaItemIds = [
      ...new Set(selections.map((selection) => selection.mediaItemId)),
    ];
    const mediaItems = readMediaItemsWithAncestors(
      snapshot.catalog,
      mediaItemIds,
    );
    const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
    const mediaItemIdsWithMultipleSelections = new Set(
      snapshot.catalog.listMediaItemMaintenance({ ids: mediaItemIds })
        .filter((item) => item.discSelectionReferenceCount > 1)
        .map((item) => item.mediaItemId),
    );
    return {
      historyGroup,
      query: query ?? "",
      counts: selectionPage.counts,
      selections: selectionPage.selections.map((queueSelection) => {
        const selection = queueSelection.selection;
        const mediaItem = mediaItemsById.get(selection.mediaItemId);
        const priorCompletedJob = queueSelection.priorCompletedJob;
        const priorCompletedProfile = queueSelection.priorCompletedProfile;
        const logicalJob = queueSelection.logicalJob;
        const suggestedOutputPath = mediaItem === undefined
          ? null
          : suggestedMediaOutputPath({
            item: mediaItem,
            mediaItemsById,
            mediaLibraryPath,
            selectionQualifier: outputPathSelectionQualifier(
              selection,
              mediaItemIdsWithMultipleSelections.has(selection.mediaItemId),
            ),
          });
        const requeue = logicalJob === null ? null :
          snapshot.encodeJobs.find(logicalJob.id);
        const suggestedPathReserved = suggestedOutputPath !== null &&
          snapshot.encodeJobs.hasReservedOutputPath(suggestedOutputPath);
        const queueAction = encodingProfileId === undefined
          ? { name: "enqueue", eligible: false, reason: "Select an Encoding Profile." }
          : logicalJob !== null
            ? { name: "requeue", ...(
              requeue === null
                ? { eligible: false, reason: "Encode Job is unavailable." }
                : encodeRequeueAvailability(snapshot, requeue, true)
            ) }
            : suggestedOutputPath === null
              ? { name: "enqueue", eligible: false, reason: "A valid output path is unavailable." }
              : suggestedPathReserved
                ? { name: "enqueue", eligible: false, reason: "Suggested output path is reserved; choose another path." }
              : { name: "enqueue", eligible: true, reason: null };
        return {
          id: selection.id,
          mediaItemId: selection.mediaItemId,
          mediaTitle: mediaItem?.title ?? "Unknown Media Item",
          mediaYear: mediaItem?.year ?? null,
          sourceDescription: discSelectionSourceDescription(
            selection.sourceIdentity,
          ),
          hasCompletedEncode: queueSelection.hasCompletedEncode,
          priorCompletedJob:
            priorCompletedJob === null || priorCompletedProfile === null
              ? null
              : {
                id: priorCompletedJob.id,
                status: priorCompletedJob.status,
                profile: {
                  id: priorCompletedProfile.id,
                  displayName: priorCompletedProfile.displayName,
                  version: priorCompletedProfile.version,
                },
              },
          logicalJob: logicalJob === null
            ? null
            : {
              id: logicalJob.id,
              encodingProfileId: logicalJob.encodingProfileId,
              outputPath: logicalJob.outputPath,
              status: logicalJob.status,
              queueAvailable: logicalJob.queueAvailable,
            },
          suggestedOutputPath,
          queueAction,
        };
      }),
      profiles: profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
      })),
      page: {
        offset: selectionOffset,
        limit: ENCODE_SELECTION_PAGE_SIZE,
        total: selectionPage.total,
        hasPrevious: selectionOffset > 0,
        hasNext: selectionOffset + selections.length < selectionPage.total,
      },
      profilePage: {
        offset: profileOffset,
        limit: ENCODE_PROFILE_PAGE_SIZE,
        hasPrevious: profileOffset > 0,
        hasNext: hasNextProfile,
      },
    };
  });
}

export function resolveQueueLogicalJobs(
  access: DataAccess,
  discSelectionIds: readonly DiscSelectionId[],
  encodingProfileId: EncodingProfileId,
) {
  return access.readConsistentSnapshot((snapshot) => {
    requireQueueEligibleProfile(snapshot, encodingProfileId);
    return snapshot.encodeJobs.resolveQueueLogicalJobs({
      discSelectionIds,
      encodingProfileId,
    });
  });
}
