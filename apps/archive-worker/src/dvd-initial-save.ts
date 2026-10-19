import type { ArchiveJob, DataAccess, OriginalDiscArchiveId, RunningArchiveJob } from "@rip-dvd/data-access";
import { ARCHIVE_JOB_LEASE_DURATION_MS, DomainInvariantError, DvdInitialSaveFault } from "@rip-dvd/data-access";
import { runDvdInitialArchiveBoundaryForArchiveJob, type ProvenDvdInitialArchiveBoundary } from "./dvd-initial-boundary.js";
import {
  publishDvdInitialArchive, reconcileDvdInitialArchivePublication,
  type DvdInitialPublicationStep,
} from "./dvd-initial-publication.js";

type SaveOptions = {
  access: DataAccess;
  claim: RunningArchiveJob;
  originalsLibraryPath: string;
  signal?: AbortSignal;
  /** Caller holds archive exclusion and has closed all copy helpers. */
  authorizeMutation?(): void | Promise<void>;
  fault?(point: `before:${DvdInitialPublicationStep | "database" | "cleanup"}` | `after:${DvdInitialPublicationStep | "database" | "cleanup"}`): void | Promise<void>;
};

function publicationOptions(options: SaveOptions) {
  const { access, claim } = options;
  const current = access.archiveJobs.find(claim.id);
  if (current?.evidenceFormat !== "dvd-recovery-evidence-v1" ||
    current.archiveRequestId !== claim.archiveRequestId || current.detectedDiscId !== claim.detectedDiscId)
    throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_CONSISTENCY_FAULT");
  const disc = access.catalog.listDetectedDiscs(undefined, { ids: [current.detectedDiscId] })[0];
  if (!disc) throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_CONSISTENCY_FAULT");
  // Stable across process restarts, including before the database owns this ID.
  const originalDiscArchiveId = `dvd-${claim.id}` as OriginalDiscArchiveId;
  let databaseProjection;
  try {
    databaseProjection = access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId);
  } catch (error) {
    if (error instanceof DomainInvariantError)
      throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_CONSISTENCY_FAULT", { cause: error });
    throw error;
  }
  return {
    ...options, originalDiscArchiveId, sourceArchiveJobId: claim.id,
    imageFingerprint: disc.fingerprint, databaseProjection,
    authorizeMutation: async () => {
      options.signal?.throwIfAborted();
      const job = access.archiveJobs.find(claim.id);
      const request = access.archiveRequests.find(claim.archiveRequestId);
      if (job?.status !== "completed") {
        if (job?.status !== "running" || job.claimToken !== claim.claimToken || request?.status !== "running" ||
          job.updatedAt.getTime() <= Date.now() - ARCHIVE_JOB_LEASE_DURATION_MS)
          throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
        await options.authorizeMutation?.();
      }
    },
  };
}

async function commitSave(options: SaveOptions, publication: Awaited<ReturnType<typeof publishDvdInitialArchive>>): Promise<ArchiveJob> {
  options.signal?.throwIfAborted();
  await options.fault?.("before:database");
  await publicationOptions(options).authorizeMutation();
  options.signal?.throwIfAborted();
  await publication.verifyPublication();
  options.signal?.throwIfAborted();
  const completed = options.access.archiveJobs.publishDvdInitial(options.claim, {
    archivePath: publication.archivePath, boundaryEvidence: publication.manifest.boundaryEvidence,
    manifest: publication.manifest,
  });
  await options.fault?.("after:database");
  await options.fault?.("before:cleanup");
  await publication.finalizePublication();
  await options.fault?.("after:cleanup");
  return completed;
}

/** Dormant Archive Job workflow. Keep archive exclusion through save and cleanup.
 * Publication faults retain intent and evidence for reconciliation; never use
 * the legacy published-image quarantine or terminal-failure path here. */
export async function saveDvdInitialArchiveForArchiveJob(options: SaveOptions & { proven: ProvenDvdInitialArchiveBoundary }) {
  return commitSave(options, await publishDvdInitialArchive({ ...publicationOptions(options), proven: options.proven }));
}

export async function reconcileDvdInitialArchiveForArchiveJob(options: SaveOptions) {
  return commitSave(options, await reconcileDvdInitialArchivePublication(publicationOptions(options)));
}

/** Full initial-copy/save seam for a claimed marked job. The same exclusion used
 * by legacy preservation prevents a legacy helper from sharing this workspace. */
export async function runDvdInitialArchiveJob(options: SaveOptions & {
  boundary: Parameters<typeof runDvdInitialArchiveBoundaryForArchiveJob>[0];
  exclusion: import("./dvd-rescue-workspace-lock.js").DvdRescueWorkspaceLock;
}) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, options.boundary.signal])
    : options.boundary.signal;
  const controlled = { ...options, signal };
  const identity = publicationOptions(controlled);
  return options.exclusion.withLock({
    fingerprint: identity.imageFingerprint, originalsLibraryPath: options.originalsLibraryPath,
    signal,
    task: async () => {
      await identity.authorizeMutation();
      const proven = await runDvdInitialArchiveBoundaryForArchiveJob({
        ...options.boundary, signal,
        async authorizeCopy() {
          await identity.authorizeMutation();
          await options.boundary.authorizeCopy?.();
          await identity.authorizeMutation();
        },
        async authorizeBoundaryProbe() {
          await identity.authorizeMutation();
          await options.boundary.authorizeBoundaryProbe();
          await identity.authorizeMutation();
        },
      });
      return saveDvdInitialArchiveForArchiveJob({ ...controlled, proven });
    },
  });
}
