import type { ArchiveJob, DataAccess, OriginalDiscArchiveId, RunningArchiveJob } from "@rip-dvd/data-access";
import { ARCHIVE_JOB_LEASE_DURATION_MS, DomainInvariantError, DvdInitialSaveFault } from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import { runDvdInitialArchiveBoundaryForArchiveJob, type ProvenDvdInitialArchiveBoundary } from "./dvd-initial-boundary.js";
import {
  publishDvdInitialArchive, reconcileDvdInitialArchivePublication,
  readDvdInitialArchivePublicationImagePath,
  type DvdInitialPublicationStep,
} from "./dvd-initial-publication.js";

type SaveOptions = {
  access: DataAccess;
  claim: RunningArchiveJob;
  originalsLibraryPath: string;
  exclusion: import("./dvd-rescue-workspace-lock.js").DvdRescueWorkspaceLock;
  archiveImageOwnership?: ArchiveImageOwnership;
  archiveOwnershipDescriptor?: number;
  assertArchiveOwnership?(): void;
  workerId?: string;
  /** Required to replace an expired claim; native exclusion and inode-owner
   * inspection must both prove no old writer remains. */
  writer?: {
    runner: Pick<import("./dvd-archiver.js").DvdCopyRunner, "withDeviceInactive" | "isActive">;
    devicePath: string;
    outputPath: string;
  };
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
      options.assertArchiveOwnership?.();
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


async function withOwnedClaim<T>(
  options: SaveOptions,
  imagePath: string | null,
  task: (owned: SaveOptions) => Promise<T>,
): Promise<T> {
  const identity = publicationOptions(options);
  const signal = options.signal ?? new AbortController().signal;
  try {
    return await (options.archiveImageOwnership ?? defaultArchiveImageOwnership)
      .withWriter({
        archiveId: identity.originalDiscArchiveId,
        imagePath,
        originalsLibraryPath: options.originalsLibraryPath,
        signal,
        task: async (archiveOwnership) => options.exclusion.withLock({
          fingerprint: identity.imageFingerprint,
          originalsLibraryPath: options.originalsLibraryPath,
          signal: archiveOwnership.signal,
          task: async () => {
      const run = async (claim: RunningArchiveJob) => {
        const controller = new AbortController();
        const owned = {
          ...options,
          claim,
          archiveOwnershipDescriptor: archiveOwnership.descriptor,
          assertArchiveOwnership: archiveOwnership.assertOwned,
          signal: AbortSignal.any([
            archiveOwnership.signal,
            controller.signal,
          ]),
        };
        const heartbeat = setInterval(() => {
          try {
            if (options.access.archiveJobs.find(claim.id)?.status === "completed") return;
            options.access.archiveJobs.renewDvdInitialClaim(claim);
          } catch (error) { controller.abort(error); }
        }, Math.floor(ARCHIVE_JOB_LEASE_DURATION_MS / 3));
        heartbeat.unref();
        try { return await task(owned); } finally { clearInterval(heartbeat); }
      };
      const current = options.access.archiveJobs.find(options.claim.id);
      if (current?.status === "completed") return run(options.claim);
      archiveOwnership.signal.throwIfAborted();
      if (current?.status !== "running" || current.claimToken !== options.claim.claimToken)
        throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
      if (current.updatedAt.getTime() > Date.now() - ARCHIVE_JOB_LEASE_DURATION_MS)
        return run(options.access.archiveJobs.renewDvdInitialClaim(options.claim));
      const writer = options.writer;
      if (!writer) throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
      let result: { value: T } | undefined;
      let taskFailed = false;
      try {
        await writer.runner.withDeviceInactive(writer.devicePath, async () => {
          try {
            archiveOwnership.signal.throwIfAborted();
            let active: boolean;
            try {
              active = writer.runner.isActive(writer.devicePath, writer.outputPath);
            } catch (cause) {
              throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST", { cause });
            }
            if (active) throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
            const claim = options.access.archiveJobs.reclaimDvdInitialSave(
              options.claim, options.workerId ?? options.claim.claimedBy ?? "dvd-initial-save",
            );
            result = { value: await run(claim) };
          } catch (error) { taskFailed = true; throw error; }
        });
      } catch (cause) {
        if (taskFailed) throw cause;
        throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST", { cause });
      }
      if (!result) throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
      return result.value;
          },
        }),
      });
  } catch (cause) {
    if (cause instanceof ArchiveImageOwnershipError) {
      throw new DvdInitialSaveFault(
        cause.code === "WRITER_NOT_QUIESCENT"
          ? "DVD_INITIAL_SAVE_OWNERSHIP_LOST"
          : "DVD_INITIAL_SAVE_CONSISTENCY_FAULT",
        { cause },
      );
    }
    throw cause;
  }
}

async function saveWithExclusionHeld(options: SaveOptions & { proven: ProvenDvdInitialArchiveBoundary }) {
  return commitSave(options, await publishDvdInitialArchive({ ...publicationOptions(options), proven: options.proven }));
}

/** Publication faults retain intent and evidence for reconciliation. This path
 * never uses legacy published-image quarantine or terminal-failure handling. */
export async function saveDvdInitialArchiveForArchiveJob(options: SaveOptions & { proven: ProvenDvdInitialArchiveBoundary }) {
  return withOwnedClaim(
    options,
    options.proven.initialCopy.imagePath,
    owned => saveWithExclusionHeld({ ...owned, proven: options.proven }),
  );
}

export async function reconcileDvdInitialArchiveForArchiveJob(options: SaveOptions) {
  const imagePath = await readDvdInitialArchivePublicationImagePath(
    publicationOptions(options),
  );
  return withOwnedClaim(options, imagePath, async owned => commitSave(owned,
    await reconcileDvdInitialArchivePublication(publicationOptions(owned)),
  ));
}

/** Full initial-copy/save workflow. Lease renewal runs independently of byte
 * progress. Exclusion lasts through helper closure, save and staging cleanup. */
export async function runDvdInitialArchiveJob(options: SaveOptions & {
  boundary: Parameters<typeof runDvdInitialArchiveBoundaryForArchiveJob>[0];
}) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, options.boundary.signal])
    : options.boundary.signal;
  return withOwnedClaim(
    { ...options, signal },
    options.boundary.outputPath,
    async owned => {
      const identity = publicationOptions(owned);
      await identity.authorizeMutation();
      const proven = await runDvdInitialArchiveBoundaryForArchiveJob({
        ...options.boundary, signal: owned.signal!,
        archiveOwnershipDescriptor: owned.archiveOwnershipDescriptor!,
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
      return saveWithExclusionHeld({ ...owned, proven });
    },
  );
}
