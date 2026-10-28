import {
  canonicalPublicationJson, decodeArchivedDvdTitles, DomainInvariantError,
  DvdCheckpointReadFault, dvdRecoveryEvidenceFormatForArchive,
  encodingProfileSettingsBlockingReasons, readCommittedDvdCheckpoint,
  type DataAccess, type EncodeClaimSource, type EncodeJob, type RunningEncodeJob,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError, defaultArchiveImageOwnership,
  type ArchiveImageOwnership, type ArchiveImageOwnershipHandle,
} from "@rip-dvd/worker-runtime";
import { describeEncodingReadiness } from "./encoding-readiness.js";
import { EncodeSourceDecisionRejectedError, withEncodeSourceDecision } from "./encode-source-decision.js";

function snapshotClaimSource(
  access: DataAccess, job: EncodeJob, originalsLibraryPath: string, ownership: ArchiveImageOwnership,
): EncodeClaimSource {
  return access.readConsistentSnapshot((reader) => {
    const selection = reader.catalog.listDiscSelections({ ids: [job.discSelectionId] })[0];
    if (!selection) throw new DomainInvariantError("Encode claim selection is unavailable");
    const id = selection.originalDiscArchiveId;
    const readiness = describeEncodingReadiness(reader, id, ownership, originalsLibraryPath, true);
    const content = readiness.selections.find((item) => item.discSelectionId === selection.id);
    const assessment = reader.dvdTitleDamageAssessments.inspect(id).assessment;
    const observation = reader.catalog.readDvdTitleIdentityReviewSet(id)?.items
      .find((item) => item.observation.id === content?.titleIdentityObservationId)?.observation;
    const archive = reader.catalog.listOriginalDiscArchives({ ids: [id] })[0];
    const profile = reader.encodingProfiles.list({ ids: [job.encodingProfileId] })[0];
    const disc = archive && reader.catalog.listDetectedDiscs(undefined, { ids: [archive.detectedDiscId] })[0];
    const title = decodeArchivedDvdTitles(disc?.scanData)?.find((item) => item.number === content?.resolvedSource?.displayTitleNumber);
    if (!readiness.applicable || !readiness.sourceReady || !content?.resolvedSource || !observation ||
      !content.expectedSourceDecision.checkpoint || !assessment || !archive || !title ||
      !profile || profile.mediaDomain !== "dvd_video" ||
      encodingProfileSettingsBlockingReasons(profile.settings).length > 0 ||
      canonicalPublicationJson(job.expectedSourceDecision) !== canonicalPublicationJson(content.expectedSourceDecision)) {
      throw new DomainInvariantError("Encode claim source is unavailable or stale");
    }
    const { resolvedSource } = content;
    if (title.chapters < resolvedSource.chapterEnd || title.durationSeconds <= 0) {
      throw new DomainInvariantError("Encode claim title metadata is inconsistent");
    }
    const acceptance = reader.catalog.inspectDvdTitleDamageDecision(id).current;
    // Resolve main-feature choices once. Execution always names this concrete title and angle.
    const selectionArguments = ["--title", String(resolvedSource.displayTitleNumber),
      "--angle", String(resolvedSource.angleNumber), "--chapters", `${resolvedSource.chapterStart}-${resolvedSource.chapterEnd}`,
      "--all-audio"];
    return JSON.parse(JSON.stringify({
      schemaVersion: 1, archive: { id, archivePath: archive.archivePath, fingerprint: archive.fingerprint },
      checkpoint: content.expectedSourceDecision.checkpoint, decision: content.expectedSourceDecision,
      selection: { id: selection.id, mediaItemId: selection.mediaItemId, sourceIdentity: selection.sourceIdentity },
      resolvedSource, title, titleIdentity: observation, assessment, acceptance,
      sourceContinuityRisk: content.assessment.sourceContinuityRisk,
      profile: { id: profile.id, key: profile.key, version: profile.version, settings: profile.settings },
      output: { policyVersion: "encode-claim-output-v1", path: job.outputPath, format: "av_mkv",
        preset: String(profile.settings.preset).trim(), selectionArguments,
        audioSelection: "all", subtitleSelection: "all", subtitleBurn: "none", dvdNavigation: "libdvdread",
        audioStreams: title.audioStreams, subtitleStreams: title.subtitles,
        expectedDurationSeconds: selection.sourceIdentity.kind === "dvd_chapters" ? null : title.durationSeconds },
    })) as EncodeClaimSource;
  });
}

/** The source assertion and snapshot run inside the same archive-wide immediate
 * transaction as the claim. Shared ownership spans checkpoint preparation and commit. */
export async function claimNextEncodeJob(
  access: DataAccess, workerId: string, originalsLibraryPath: string,
  ownership: ArchiveImageOwnership = defaultArchiveImageOwnership,
): Promise<RunningEncodeJob | null> {
  // Preserve the indexed historical queue path while new-format admission is closed.
  const historical = access.encodeJobs.claimNext(workerId);
  if (historical) return historical;
  for (const queued of access.encodeJobs.list(["queued"])) {
    const selection = access.catalog.listDiscSelections({ ids: [queued.discSelectionId] })[0];
    if (!selection) continue;
    const newFormat = dvdRecoveryEvidenceFormatForArchive(
      access.catalog.findDvdArchiveEvidenceHeader(selection.originalDiscArchiveId),
      access.archiveJobs.listForArchive(selection.originalDiscArchiveId),
    ) !== null;
    try {
      const claim = await withEncodeSourceDecision(access, queued.discSelectionId,
        queued.expectedSourceDecision ?? undefined, originalsLibraryPath,
        (assertSourceDecision) => access.encodeJobs.claimNext(workerId, {
          jobId: queued.id,
          snapshotSource(job) {
            if (!assertSourceDecision) throw new DomainInvariantError("Encode checkpoint preparation is required");
            assertSourceDecision();
            return snapshotClaimSource(access, job, originalsLibraryPath, ownership);
          },
        }), ownership);
      if (claim) return claim;
    } catch (error) {
      if (!newFormat || !(error instanceof EncodeSourceDecisionRejectedError ||
        error instanceof DvdCheckpointReadFault || error instanceof ArchiveImageOwnershipError ||
        error instanceof DomainInvariantError)) throw error;
      // Leave stale work queued for an explicit current-source requeue. Other archives may proceed.
    }
  }
  return null;
}

/** Revalidate bytes and ownership, not later mutable catalog decisions. Withdrawal
 * after a claim won cannot cancel it or retarget its recorded content. */
export async function assertEncodeClaimSource(
  access: DataAccess, claim: RunningEncodeJob, handle: ArchiveImageOwnershipHandle, originalsLibraryPath: string,
): Promise<void> {
  handle.assertOwned();
  const recorded = access.encodeJobs.findClaimSnapshot(claim.claimToken);
  if (!recorded || recorded.encodeJobId !== claim.id) throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  const { source } = recorded;
  const read = () => access.readConsistentSnapshot((reader) => ({
    archive: reader.catalog.listOriginalDiscArchives({ ids: [source.archive.id] })[0],
    header: reader.catalog.findDvdArchiveEvidenceHeader(source.archive.id),
    jobs: reader.archiveJobs.listForArchive(source.archive.id),
    recovery: reader.catalog.findArchiveRecovery(source.archive.id),
  }));
  const assertStable = (current: ReturnType<typeof read>) => {
    const { archive, header, recovery } = current;
    if (!archive || archive.archivePath !== source.archive.archivePath || archive.fingerprint !== source.archive.fingerprint ||
      !header || header.currentManifestId !== source.checkpoint.manifestId ||
      header.currentManifestRevision !== source.checkpoint.revision || header.currentManifestDigest !== source.checkpoint.manifestDigest ||
      !recovery || !["stopped", "completed"].includes(recovery.status) || recovery.work !== null) {
      throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
    }
    return archive;
  };
  const current = read();
  const archive = assertStable(current);
  const checkpoint = await readCommittedDvdCheckpoint({ ...current, archive,
    originalsLibraryPath, assertImageOwnership: handle.assertOwned });
  if (!checkpoint || checkpoint.id !== source.checkpoint.manifestId || checkpoint.revision !== source.checkpoint.revision ||
    checkpoint.manifestDigest !== source.checkpoint.manifestDigest) throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  handle.assertOwned();
  assertStable(read());
}
