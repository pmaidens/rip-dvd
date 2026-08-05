import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { DomainInvariantError } from "../errors.js";
import type {
  LegacySidecarAccess,
  LegacySidecarImportReport,
} from "../legacy-sidecar-types.js";
import type {
  DetectedDiscId,
  DiscSelectionId,
  EncodeJobId,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
} from "../types.js";
import type {
  LegacySidecarCatalogAdapter,
  LegacySidecarCatalogReadAdapter,
} from "./legacy-sidecar-catalog-adapter.js";
import {
  discoverLegacySidecars,
  legacySourceArchiveMatchesSnapshot,
  resolveLegacyOriginalsLibrary,
  retireLegacySidecarQueue,
  type LegacyQueueJobSnapshot,
  type LegacySidecarDiscovery,
  type ParsedLegacyJob,
} from "./legacy-sidecars.js";
import {
  createLegacyJobLogicalKey,
  legacyJobLogicalKey,
  legacyJobSignature,
  parseLegacyJobLogicalKey,
  type LegacyJobLogicalKey,
} from "./legacy-sidecar-identity.js";
import { isPathWithinDirectory } from "./path-containment.js";
import {
  hashDvdArchiveFile,
  isCurrentDvdContentSize,
} from "./dvd-content-identity.js";
import { newId, requireRow } from "./persistence.js";
import {
  detectedDiscs,
  discSelections,
  encodeJobs,
  encodingProfiles,
  legacyCutoverStagedSidecars,
  mediaItems,
  opticalDrives,
  originalDiscArchiveContentIds,
  originalDiscArchives,
} from "./schema.js";
import { requireNonEmpty } from "./validation.js";

const LEGACY_CUTOVER_INVENTORY_LIMIT = 10_000;
const LEGACY_CUTOVER_RELEASE_PAGE_SIZE = 500;

function emptyLegacyImportRecordCounts():
  LegacySidecarImportReport["recordsCreated"] {
  return {
    originalDiscArchives: 0,
    discSelections: 0,
    mediaItems: 0,
    encodingProfiles: 0,
    encodeJobs: 0,
  };
}

function isCompatibleLegacyEncodingProfile(
  profile: typeof encodingProfiles.$inferSelect | undefined,
  job: ParsedLegacyJob,
): boolean {
  return (
    profile?.displayName === job.preset &&
    isDeepStrictEqual(profile.settings, { preset: job.preset })
  );
}

export function createLegacySidecarImportAccess(
  database: LegacySidecarCatalogAdapter,
  now: () => Date,
  requireReviewableDiscSelections: (
    archiveId: OriginalDiscArchiveId,
    catalog: LegacySidecarCatalogReadAdapter,
  ) => unknown,
): LegacySidecarAccess {
  return {
    importLibrary(input) {
      const originalsLibraryPath =
        resolveLegacyOriginalsLibrary(
          requireNonEmpty(
            input.originalsLibraryPath,
            "originalsLibraryPath",
          ),
        );
      const discoveryBatch =
        discoverLegacySidecars(originalsLibraryPath);
      let discoveries = discoveryBatch.discoveries;
      const report: LegacySidecarImportReport = {
        originalsLibraryPath,
        sidecarsFound: discoveryBatch.sidecarsFound,
        sidecarsImported: 0,
        sidecarsSkipped: 0,
        recordsCreated: emptyLegacyImportRecordCounts(),
        recordsUpdated: 0,
        recordsUnchanged: 0,
        issues: [...discoveryBatch.scanIssues],
      };
      const reviewCandidates = new Map<
        string,
        {
          archiveId: OriginalDiscArchiveId;
          archiveUpdatedAt: Date;
          reviewedAt: Date;
        }
      >();
      const stagedReviewArchiveIds = new Set<OriginalDiscArchiveId>();
      const cutoverFenceArchiveIds = new Set<OriginalDiscArchiveId>();
      const previouslyConfirmedStagedIdentities = new Set<string>();
      const stagedIdentityKey = (input: {
        archivePath: string;
        fingerprint: string;
        sidecarPath: string;
      }) => JSON.stringify([
        input.sidecarPath,
        input.archivePath,
        input.fingerprint,
      ]);
      const stageCatalogReviewBoundary = (
        publicationDiscoveries: readonly LegacySidecarDiscovery[],
        options: { allowStagedIdentityReplacement?: boolean } = {},
      ) => {
        return database.transaction((transaction) => {
          const representedSidecars = publicationDiscoveries.flatMap(
            (discovery) =>
              discovery.outcome === "parsed" ? [discovery.sidecar] : [],
          );
          const representedArchivePaths = new Set(
            representedSidecars.map((sidecar) => sidecar.archivePath),
          );
          const representedFingerprints = new Set(
            representedSidecars.map((sidecar) => sidecar.fingerprint),
          );
          const representedSidecarsByPath = new Map(
            representedSidecars.map((sidecar) => [
              sidecar.sidecarPath,
              sidecar,
            ]),
          );
          const existingStagedSidecars = transaction
            .select({
              archivePath: legacyCutoverStagedSidecars.archivePath,
              fingerprint: legacyCutoverStagedSidecars.fingerprint,
              sidecarPath: legacyCutoverStagedSidecars.sidecarPath,
            })
            .from(legacyCutoverStagedSidecars)
            .where(eq(
              legacyCutoverStagedSidecars.originalsLibraryPath,
              originalsLibraryPath,
            ))
            .limit(LEGACY_CUTOVER_INVENTORY_LIMIT + 1)
            .all();
          if (
            existingStagedSidecars.length >
            LEGACY_CUTOVER_INVENTORY_LIMIT
          ) {
            return false;
          }
          const existingStagedSidecarPaths = new Set(
            existingStagedSidecars.map((sidecar) => sidecar.sidecarPath),
          );
          const newlyStagedSidecarPaths = new Set(
            representedSidecars.flatMap((sidecar) =>
              existingStagedSidecarPaths.has(sidecar.sidecarPath)
                ? []
                : [sidecar.sidecarPath],
            ),
          );
          if (
            existingStagedSidecars.length + newlyStagedSidecarPaths.size >
            LEGACY_CUTOVER_INVENTORY_LIMIT
          ) {
            return false;
          }
          for (const sidecar of representedSidecars) {
            transaction
              .insert(legacyCutoverStagedSidecars)
              .values({
                originalsLibraryPath,
                sidecarPath: sidecar.sidecarPath,
                archivePath: sidecar.archivePath,
                fingerprint: sidecar.fingerprint,
              })
              .onConflictDoNothing({
                target: [
                  legacyCutoverStagedSidecars.originalsLibraryPath,
                  legacyCutoverStagedSidecars.sidecarPath,
                ],
              })
              .run();
          }
          const markerAnchoredStagedIdentities =
            options.allowStagedIdentityReplacement
              ? existingStagedSidecars.filter((staged) => {
                  const represented = representedSidecarsByPath.get(
                    staged.sidecarPath,
                  );
                  return (
                    represented !== undefined &&
                    (represented.archivePath !== staged.archivePath ||
                      represented.fingerprint !== staged.fingerprint)
                  );
                })
              : [];
          const newlyFencedArchiveIds = new Set<OriginalDiscArchiveId>();
          for (const sidecar of [
            ...representedSidecars,
            ...markerAnchoredStagedIdentities,
          ]) {
            const relatedArchives = transaction
              .select()
              .from(originalDiscArchives)
              .where(
                or(
                  eq(
                    originalDiscArchives.fingerprint,
                    sidecar.fingerprint,
                  ),
                  eq(
                    originalDiscArchives.archivePath,
                    sidecar.archivePath,
                  ),
                ),
              )
              .all();
            for (const archive of relatedArchives) {
              cutoverFenceArchiveIds.add(archive.id);
              newlyFencedArchiveIds.add(archive.id);
              if (archive.catalogReviewedAt !== null) {
                if (!reviewCandidates.has(archive.fingerprint)) {
                  reviewCandidates.set(archive.fingerprint, {
                    archiveId: archive.id,
                    archiveUpdatedAt: archive.updatedAt,
                    reviewedAt: archive.catalogReviewedAt,
                  });
                }
                stagedReviewArchiveIds.add(archive.id);
              }
              transaction
                .update(originalDiscArchives)
                .set({
                  catalogReviewedAt: null,
                  legacyCutoverPending: true,
                })
                .where(eq(originalDiscArchives.id, archive.id))
                .run();
            }
          }
          if (newlyFencedArchiveIds.size > 0) {
            transaction
              .update(encodeJobs)
              .set({
                partialCleanupOutputPath: sql`${encodeJobs.outputPath}`,
                partialCleanupClaimToken: sql`${encodeJobs.claimToken}`,
                status: "failed",
                completedAt: null,
                errorMessage:
                  "Encode Job invalidated by legacy catalog cutover repair",
                updatedAt: now(),
              })
              .where(and(
                eq(encodeJobs.status, "running"),
                exists(
                  transaction
                    .select({ id: discSelections.id })
                    .from(discSelections)
                    .innerJoin(
                      originalDiscArchives,
                      eq(
                        originalDiscArchives.id,
                        discSelections.originalDiscArchiveId,
                      ),
                    )
                    .where(and(
                      eq(discSelections.id, encodeJobs.discSelectionId),
                      inArray(
                        originalDiscArchives.id,
                        [...newlyFencedArchiveIds],
                      ),
                    )),
                ),
              ))
              .run();
          }

          const stagedSidecars = transaction
            .select({
              archivePath: legacyCutoverStagedSidecars.archivePath,
              fingerprint: legacyCutoverStagedSidecars.fingerprint,
              sidecarPath: legacyCutoverStagedSidecars.sidecarPath,
            })
            .from(legacyCutoverStagedSidecars)
            .where(eq(
              legacyCutoverStagedSidecars.originalsLibraryPath,
              originalsLibraryPath,
            ))
            .limit(LEGACY_CUTOVER_INVENTORY_LIMIT + 1)
            .all();
          if (stagedSidecars.length > LEGACY_CUTOVER_INVENTORY_LIMIT) {
            return false;
          }
          const stagedIdentityIsRepresented = (
            staged: (typeof stagedSidecars)[number],
          ) => {
            const represented = representedSidecarsByPath.get(
              staged.sidecarPath,
            );
            return (
              (represented?.archivePath === staged.archivePath &&
                represented.fingerprint === staged.fingerprint) ||
              (options.allowStagedIdentityReplacement === true &&
                represented !== undefined) ||
              previouslyConfirmedStagedIdentities.has(
                stagedIdentityKey(staged),
              )
            );
          };
          const stagedSidecarsAreRepresented = stagedSidecars.every(
            stagedIdentityIsRepresented,
          );
          const representedStagedArchivePaths = new Set(
            stagedSidecars.flatMap((staged) =>
              stagedIdentityIsRepresented(staged)
                ? [staged.archivePath]
                : [],
            ),
          );
          const representedStagedFingerprints = new Set(
            stagedSidecars.flatMap((staged) =>
              stagedIdentityIsRepresented(staged)
                ? [staged.fingerprint]
                : [],
            ),
          );
          const pendingArchives = transaction
            .select({
              archivePath: originalDiscArchives.archivePath,
              fingerprint: originalDiscArchives.fingerprint,
              id: originalDiscArchives.id,
            })
            .from(originalDiscArchives)
            .where(eq(originalDiscArchives.legacyCutoverPending, true))
            .limit(LEGACY_CUTOVER_INVENTORY_LIMIT + 1)
            .all();
          if (pendingArchives.length > LEGACY_CUTOVER_INVENTORY_LIMIT) {
            return false;
          }
          for (const archive of pendingArchives) {
            if (
              isPathWithinDirectory(
                originalsLibraryPath,
                archive.archivePath,
              )
            ) {
              cutoverFenceArchiveIds.add(archive.id);
            }
          }
          const pendingArchivesAreRepresented = pendingArchives.every(
            (archive) =>
              !isPathWithinDirectory(
                originalsLibraryPath,
                archive.archivePath,
              ) ||
              stagedSidecars.length > 0 ||
              representedFingerprints.has(archive.fingerprint) ||
              representedArchivePaths.has(archive.archivePath) ||
              representedStagedFingerprints.has(archive.fingerprint) ||
              representedStagedArchivePaths.has(archive.archivePath),
          );
          const publicationIsComplete = (
            pendingArchivesAreRepresented &&
            stagedSidecarsAreRepresented
          );
          for (const staged of stagedSidecars) {
            const represented = representedSidecarsByPath.get(
              staged.sidecarPath,
            );
            if (
              (represented?.archivePath === staged.archivePath &&
                represented.fingerprint === staged.fingerprint) ||
              (options.allowStagedIdentityReplacement === true &&
                represented !== undefined)
            ) {
              previouslyConfirmedStagedIdentities.add(
                stagedIdentityKey(staged),
              );
            }
          }
          return publicationIsComplete;
        }, { behavior: "immediate" });
      };
      const cutover = retireLegacySidecarQueue(
        originalsLibraryPath,
        discoveryBatch,
        stageCatalogReviewBoundary,
      );
      if (!cutover) {
        report.sidecarsSkipped = discoveryBatch.sidecarsFound;
        for (const discovery of discoveries) {
          if (discovery.outcome === "skipped") {
            report.issues.push(discovery.issue);
          } else {
            report.issues.push(...discovery.sidecar.issues);
          }
        }
        return report;
      }
      report.issues.push(...cutover.recoveryIssues);
      if (cutover.recoveryDiscoveries) {
        discoveries = cutover.recoveryDiscoveries;
        const recoveryPaths = new Set(
          discoveries.map((discovery) =>
            discovery.outcome === "parsed"
              ? discovery.sidecar.sidecarPath
              : discovery.issue.sidecarPath,
          ),
        );
        report.sidecarsFound = new Set([
          ...discoveryBatch.sidecarPaths,
          ...recoveryPaths,
        ]).size;
        report.sidecarsSkipped = discoveryBatch.sidecarPaths.filter(
          (sidecarPath) => !recoveryPaths.has(sidecarPath),
        ).length;
        if (
          discoveryBatch.complete &&
          cutover.sidecarSnapshots.length > 0
        ) {
          for (const sidecarPath of discoveryBatch.sidecarPaths) {
            if (!recoveryPaths.has(sidecarPath)) {
              report.issues.push({
                code: "duplicate_record",
                message:
                  "Legacy sidecar was not captured at SQLite cutover and remains inactive",
                sidecarPath,
              });
            }
          }
        }
      }
      const persistedLegacyJobs = new Map<
        LegacyJobLogicalKey,
        { job: ParsedLegacyJob; sidecarPath: string }
      >();
      const fingerprintsRequiringHumanReview = new Set<string>();
      const fingerprintsCreatedDuringImport = new Set<string>();
      let hasIncompleteCapturedWork = false;
      const withdrawIncompletePublication = () => {
        cutover.withdrawPublication();
      };
      const reconciledSnapshotKeys = new Set<LegacyJobLogicalKey>();
      const trustedSchemaOneSnapshots = new Map<
        LegacyJobLogicalKey,
        LegacyQueueJobSnapshot
      >();
      let schemaOneHasUnresolvedWork =
        cutover.mode === "schema-one" && discoveries.length === 0;

      for (const discovery of discoveries) {
        if (discovery.outcome === "skipped") {
          if (cutover.mode === "schema-one") {
            schemaOneHasUnresolvedWork = true;
          } else if (cutover.mode === "snapshot") {
            hasIncompleteCapturedWork = true;
            withdrawIncompletePublication();
          }
          report.sidecarsSkipped += 1;
          report.issues.push(discovery.issue);
          continue;
        }

        const { sidecar } = discovery;
        report.issues.push(...sidecar.issues);
        if (
          cutover.mode === "historical-snapshot" &&
          input.recoverHistoricalCutover !== true
        ) {
          for (const job of sidecar.jobs) {
            const logicalKey = legacyJobLogicalKey(
              sidecar.fingerprint,
              job,
            );
            if (
              cutover.jobSnapshots.get(logicalKey)?.signature ===
              legacyJobSignature(job)
            ) {
              reconciledSnapshotKeys.add(logicalKey);
            }
          }
          report.sidecarsSkipped += 1;
          report.issues.push({
            code: "invalid_sidecar",
            message:
              "Schema-2/3 cutover state cannot be reinterpreted automatically; rerun with explicit historical cutover recovery after verifying the bounded surviving sidecars and archives",
            sidecarPath: sidecar.sidecarPath,
          });
          continue;
        }
        if (cutover.mode === "schema-one") {
          const corroboratingArchive = database
            .select()
            .from(originalDiscArchives)
            .where(
              and(
                eq(originalDiscArchives.fingerprint, sidecar.fingerprint),
                eq(originalDiscArchives.archivePath, sidecar.archivePath),
              ),
            )
            .get();
          if (
            sidecar.jobs.length === 0 &&
            sidecar.issues.length === 0
          ) {
            schemaOneHasUnresolvedWork = true;
            report.sidecarsSkipped += 1;
            report.issues.push({
              code: "invalid_job",
              message:
                "Schema-1 archive-only recovery lacks immutable source-object provenance and requires operator action; SQLite state and the schema-1 marker were preserved",
              sidecarPath: sidecar.sidecarPath,
            });
            continue;
          }
          let sidecarHasUnresolvedWork = sidecar.issues.length > 0;
          if (sidecarHasUnresolvedWork) {
            schemaOneHasUnresolvedWork = true;
          }
          for (const job of sidecar.jobs) {
            const selection = corroboratingArchive
              ? database
                  .select()
                  .from(discSelections)
                  .where(
                    and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        corroboratingArchive.id,
                      ),
                      eq(discSelections.sourceKey, job.sourceKey),
                      eq(discSelections.isCatalogActive, true),
                    ),
                  )
                  .get()
              : undefined;
            const profile = database
              .select()
              .from(encodingProfiles)
              .where(
                and(
                  eq(encodingProfiles.mediaDomain, "dvd_video"),
                  eq(encodingProfiles.key, job.profileKey),
                  eq(encodingProfiles.version, 1),
                ),
              )
              .get();
            const mediaItem = selection
              ? database
                  .select()
                  .from(mediaItems)
                  .where(eq(mediaItems.id, selection.mediaItemId))
                  .get()
              : undefined;
            const logicalJobs =
              selection && profile
                ? database
                    .select()
                    .from(encodeJobs)
                    .where(
                      and(
                        eq(encodeJobs.discSelectionId, selection.id),
                        eq(encodeJobs.encodingProfileId, profile.id),
                      ),
                    )
                    .all()
                : [];
            const exactMatch =
              corroboratingArchive?.sizeBytes ===
                sidecar.archiveSizeBytes &&
              selection?.kind === job.kind &&
              selection.titleNumber === job.titleNumber &&
              selection.label === job.label &&
              mediaItem?.kind === job.mediaItemKind &&
              mediaItem.title === job.mediaTitle &&
              mediaItem.year ===
                (job.mediaItemKind === "movie"
                  ? sidecar.movieYear
                  : null) &&
              isCompatibleLegacyEncodingProfile(profile, job) &&
              logicalJobs.length === 1 &&
              logicalJobs[0]?.outputPath === job.outputPath;
            const logicalKey = legacyJobLogicalKey(
              sidecar.fingerprint,
              job,
            );
            if (exactMatch) {
              trustedSchemaOneSnapshots.set(logicalKey, {
                jobIndex: job.jobIndex,
                sidecarPath: sidecar.sidecarPath,
                signature: legacyJobSignature(job),
              });
              report.recordsUnchanged += 1;
            } else {
              sidecarHasUnresolvedWork = true;
              schemaOneHasUnresolvedWork = true;
              report.issues.push({
                code: "duplicate_record",
                jobIndex: job.jobIndex,
                message:
                  "Schema-1 cutover recovery is ambiguous and requires operator action because this legacy job cannot be distinguished from post-cutover drift; SQLite state and the schema-1 marker were preserved",
                sidecarPath: sidecar.sidecarPath,
              });
            }
          }
          if (sidecarHasUnresolvedWork) {
            report.sidecarsSkipped += 1;
          } else {
            report.sidecarsImported += 1;
          }
          continue;
        }
        const prePersistenceIssues: LegacySidecarImportReport["issues"] = [];
        const acceptedJobs = sidecar.jobs.filter((job) => {
          const logicalKey = legacyJobLogicalKey(
            sidecar.fingerprint,
            job,
          );
          const signature = legacyJobSignature(job);
          const persisted = persistedLegacyJobs.get(logicalKey);
          if (!persisted) {
            const publishedSnapshot =
              cutover.jobSnapshots.get(logicalKey);
            if (
              publishedSnapshot?.signature !== signature
            ) {
              const issue = {
                code: "duplicate_record",
                jobIndex: job.jobIndex,
                message:
                  "Logical Encode Job conflicts with the record captured at SQLite cutover",
                sidecarPath: sidecar.sidecarPath,
              } as const;
              prePersistenceIssues.push(issue);
              report.issues.push(issue);
              return false;
            }
            reconciledSnapshotKeys.add(logicalKey);
            return true;
          }
          if (legacyJobSignature(persisted.job) === signature) {
            return true;
          }
          const issue = {
            code: "duplicate_record",
            jobIndex: job.jobIndex,
            message: `Logical Encode Job conflicts with an earlier record in ${persisted.sidecarPath}`,
            sidecarPath: sidecar.sidecarPath,
          } as const;
          prePersistenceIssues.push(issue);
          report.issues.push(issue);
          return false;
        });
        const created = emptyLegacyImportRecordCounts();
        let updated = 0;
        let unchanged = 0;
        const persistenceIssues: LegacySidecarImportReport["issues"] = [];
        const persistedJobs: ParsedLegacyJob[] = [];
        let createdArchiveInTransaction = false;
        let reviewCandidate:
          | {
              archiveId: OriginalDiscArchiveId;
              archiveUpdatedAt: Date;
              reviewedAt: Date;
            }
          | undefined;
        if (
          sidecar.issues.length > 0 ||
          prePersistenceIssues.length > 0
        ) {
          fingerprintsRequiringHumanReview.add(sidecar.fingerprint);
          hasIncompleteCapturedWork = true;
          withdrawIncompletePublication();
        }

        try {
          const requireCapturedSourceArchive = () => {
            if (!legacySourceArchiveMatchesSnapshot(
              originalsLibraryPath,
              sidecar,
            )) {
              throw new DomainInvariantError(
                "Legacy source archive conflicts with the object captured at SQLite cutover",
              );
            }
          };
          requireCapturedSourceArchive();
          let archiveContentIdentity;
          try {
            archiveContentIdentity = isCurrentDvdContentSize(
              sidecar.archiveSizeBytes,
            )
              ? hashDvdArchiveFile(
                sidecar.archivePath,
                sidecar.archiveSizeBytes,
              )
              : undefined;
          } catch (error) {
            // Preserve the cutover provenance contract when the captured
            // object changes while its new content identity is being read.
            requireCapturedSourceArchive();
            throw error;
          }
          database.transaction((transaction) => {
            requireCapturedSourceArchive();
            const existingByFingerprint = transaction
              .select()
              .from(originalDiscArchives)
              .where(
                or(
                  eq(
                    originalDiscArchives.fingerprint,
                    sidecar.fingerprint,
                  ),
                  eq(
                    originalDiscArchives.archivePath,
                    sidecar.archivePath,
                  ),
                ),
              )
              .get();
            const existingByPath = transaction
              .select()
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.archivePath, sidecar.archivePath))
              .get();
            if (
              existingByFingerprint &&
              existingByPath &&
              existingByFingerprint.id !== existingByPath.id
            ) {
              throw new DomainInvariantError(
                "Archive fingerprint and path belong to different records",
              );
            }
            if (
              existingByFingerprint &&
              existingByFingerprint.archivePath !== sidecar.archivePath
            ) {
              throw new DomainInvariantError(
                "Archive fingerprint is already assigned to a different path",
              );
            }

            const timestamp = now();
            const importedCreatedAt = sidecar.createdAt;
            const importedUpdatedAt = sidecar.updatedAt;
            let archive = existingByFingerprint ?? existingByPath;
            const archiveAlreadyExisted = archive !== undefined;
            const archiveExistedBeforeImport =
              archiveAlreadyExisted &&
              !fingerprintsCreatedDuringImport.has(sidecar.fingerprint);
            if (
              existingByPath &&
              existingByPath.fingerprint !== sidecar.fingerprint
            ) {
              throw new DomainInvariantError(
                "Archive path is already assigned to a different fingerprint",
              );
            }
            if (!archive) {
              const legacyDevicePath = `legacy-sidecar:${originalsLibraryPath}`;
              transaction
                .insert(opticalDrives)
                .values({
                  id: newId<OpticalDriveId>(),
                  devicePath: legacyDevicePath,
                  displayName: "Legacy sidecar import",
                  isEnabled: false,
                  isPresent: false,
                  lastSeenAt: timestamp,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .onConflictDoNothing({ target: opticalDrives.devicePath })
                .run();
              const drive = requireRow(
                transaction
                  .select()
                  .from(opticalDrives)
                  .where(eq(opticalDrives.devicePath, legacyDevicePath))
                  .get(),
                "legacy import source",
                legacyDevicePath,
              );
              transaction
                .insert(detectedDiscs)
                .values({
                  id: newId<DetectedDiscId>(),
                  opticalDriveId: drive.id,
                  discKind: "dvd",
                  fingerprint: sidecar.fingerprint,
                  volumeLabel: sidecar.movieTitle,
                  status: "archived",
                  scanData: sidecar.scanData,
                  detectedAt: importedCreatedAt,
                  createdAt: importedCreatedAt,
                  updatedAt: importedUpdatedAt,
                })
                .onConflictDoNothing({
                  target: [
                    detectedDiscs.opticalDriveId,
                    detectedDiscs.fingerprint,
                  ],
                })
                .run();
              const disc = requireRow(
                transaction
                  .select()
                  .from(detectedDiscs)
                  .where(
                    and(
                      eq(detectedDiscs.opticalDriveId, drive.id),
                      eq(detectedDiscs.fingerprint, sidecar.fingerprint),
                    ),
                  )
                  .get(),
                "legacy detected disc",
                sidecar.fingerprint,
              );
              archive = requireRow(
                transaction
                  .insert(originalDiscArchives)
                  .values({
                    id: newId<OriginalDiscArchiveId>(),
                    detectedDiscId: disc.id,
                    discKind: "dvd",
                    archiveFormat: "iso",
                    archivePath: sidecar.archivePath,
                    fingerprint: sidecar.fingerprint,
                    sizeBytes: sidecar.archiveSizeBytes,
                    archivedAt: sidecar.archivedAt,
                    legacyCutoverPending: true,
                    createdAt: importedCreatedAt,
                    updatedAt: importedUpdatedAt,
                  })
                  .returning()
                  .get(),
                "original disc archive",
                sidecar.archivePath,
              );
              created.originalDiscArchives += 1;
              createdArchiveInTransaction = true;
              cutoverFenceArchiveIds.add(archive.id);
            } else {
              const archiveChanged =
                archive.archivePath !== sidecar.archivePath ||
                archive.sizeBytes !== sidecar.archiveSizeBytes;
              if (archiveChanged) {
                archive = requireRow(
                  transaction
                    .update(originalDiscArchives)
                    .set({
                      archivePath: sidecar.archivePath,
                      sizeBytes: sidecar.archiveSizeBytes,
                      updatedAt: timestamp,
                    })
                    .where(eq(originalDiscArchives.id, archive.id))
                    .returning()
                    .get(),
                  "original disc archive",
                  archive.id,
                );
                updated += 1;
              } else {
                unchanged += 1;
              }
            }

            if (archiveContentIdentity) {
              const archiveWithFingerprint = transaction
                .select({ id: originalDiscArchives.id })
                .from(originalDiscArchives)
                .where(
                  eq(
                    originalDiscArchives.fingerprint,
                    archiveContentIdentity.contentId,
                  ),
                )
                .get();
              if (
                archiveWithFingerprint &&
                archiveWithFingerprint.id !== archive.id
              ) {
                throw new DomainInvariantError(
                  "Archive contents are already assigned to a different Original Disc Archive fingerprint",
                );
              }
              transaction
                .insert(originalDiscArchiveContentIds)
                .values({
                  originalDiscArchiveId: archive.id,
                  contentId: archiveContentIdentity.contentId,
                })
                .onConflictDoNothing()
                .run();
              const archiveForContentId = transaction
                .select({
                  originalDiscArchiveId:
                    originalDiscArchiveContentIds.originalDiscArchiveId,
                })
                .from(originalDiscArchiveContentIds)
                .where(
                  eq(
                    originalDiscArchiveContentIds.contentId,
                    archiveContentIdentity.contentId,
                  ),
                )
                .get();
              if (archiveForContentId?.originalDiscArchiveId !== archive.id) {
                throw new DomainInvariantError(
                  "Archive contents are already assigned to a different Original Disc Archive",
                );
              }
            }

            let movieItem: typeof mediaItems.$inferSelect | undefined;
            const existingSelections = transaction
              .select()
              .from(discSelections)
              .where(
                and(
                  eq(discSelections.originalDiscArchiveId, archive.id),
                  eq(discSelections.isCatalogActive, true),
                ),
              )
              .all();
            const selectionsBySourceKey = new Map(
              existingSelections.map((selection) => [
                selection.sourceKey,
                selection,
              ]),
            );
            const findExistingSelection = (
              mediaItemKind: "movie" | "bonus_feature",
            ) => {
              const job = sidecar.jobs.find(
                (candidate) =>
                  candidate.mediaItemKind === mediaItemKind &&
                  selectionsBySourceKey.has(candidate.sourceKey),
              );
              return job
                ? selectionsBySourceKey.get(job.sourceKey)
                : undefined;
            };
            const existingMovieSelection = findExistingSelection("movie");
            if (existingMovieSelection) {
              movieItem = transaction
                .select()
                .from(mediaItems)
                .where(eq(mediaItems.id, existingMovieSelection.mediaItemId))
                .get();
            } else {
              const existingExtraSelection =
                findExistingSelection("bonus_feature");
              if (existingExtraSelection) {
                const extra = transaction
                  .select()
                  .from(mediaItems)
                  .where(eq(mediaItems.id, existingExtraSelection.mediaItemId))
                  .get();
                if (extra?.parentId) {
                  movieItem = transaction
                    .select()
                    .from(mediaItems)
                    .where(eq(mediaItems.id, extra.parentId))
                    .get();
                }
              }
            }
            const requireMovieItem = () => {
              if (movieItem) {
                return movieItem;
              }
              movieItem = requireRow(
                transaction
                  .insert(mediaItems)
                  .values({
                    id: newId<MediaItemId>(),
                    kind: "movie",
                    title: sidecar.movieTitle,
                    year: sidecar.movieYear,
                    createdAt: importedCreatedAt,
                    updatedAt: importedUpdatedAt,
                  })
                  .returning()
                  .get(),
                "legacy media item",
                sidecar.movieTitle,
              );
              created.mediaItems += 1;
              return movieItem;
            };

            for (const job of acceptedJobs) {
              const importedJobState = job.completedAt
                ? {
                    status: "completed" as const,
                    progressPercent: 100,
                    completedAt: job.completedAt,
                  }
                : {
                    status: "queued" as const,
                    progressPercent: 0,
                    completedAt: null,
                  };
              let selection = selectionsBySourceKey.get(job.sourceKey);
              let profile = transaction
                .select()
                .from(encodingProfiles)
                .where(
                  and(
                    eq(encodingProfiles.mediaDomain, "dvd_video"),
                    eq(encodingProfiles.key, job.profileKey),
                    eq(encodingProfiles.version, 1),
                  ),
                )
                .get();
              if (
                profile &&
                !isCompatibleLegacyEncodingProfile(profile, job)
              ) {
                persistenceIssues.push({
                  code: "duplicate_record",
                  jobIndex: job.jobIndex,
                  message: `Encoding Profile ${job.profileKey} is incompatible with legacy preset ${job.preset}`,
                  sidecarPath: sidecar.sidecarPath,
                });
                continue;
              }
              const capturedSnapshotMatches =
                cutover.wasAlreadyPublished &&
                cutover.jobSnapshots
                  .get(legacyJobLogicalKey(sidecar.fingerprint, job))
                  ?.signature === legacyJobSignature(job);
              const outputJob = transaction
                .select()
                .from(encodeJobs)
                .where(and(
                  eq(encodeJobs.outputPath, job.outputPath),
                  eq(encodeJobs.reservesOutputPath, true),
                ))
                .get();
              const logicalJob =
                selection && profile
                  ? transaction
                      .select()
                      .from(encodeJobs)
                      .where(
                        and(
                          eq(encodeJobs.discSelectionId, selection.id),
                          eq(encodeJobs.encodingProfileId, profile.id),
                        ),
                      )
                      .get()
                  : undefined;
              const retiredHistoricalJob =
                capturedSnapshotMatches && profile
                  ? transaction
                      .select({ id: encodeJobs.id })
                      .from(encodeJobs)
                      .innerJoin(
                        discSelections,
                        eq(discSelections.id, encodeJobs.discSelectionId),
                      )
                      .where(and(
                        eq(encodeJobs.outputPath, job.outputPath),
                        eq(encodeJobs.encodingProfileId, profile.id),
                        eq(
                          discSelections.originalDiscArchiveId,
                          archive.id,
                        ),
                        eq(discSelections.sourceKey, job.sourceKey),
                        eq(discSelections.isCatalogActive, false),
                      ))
                      .limit(1)
                      .get()
                  : undefined;
              if (retiredHistoricalJob) {
                unchanged += 1;
                persistedJobs.push(job);
                continue;
              }
              if (
                logicalJob &&
                logicalJob.outputPath !== job.outputPath &&
                !capturedSnapshotMatches
              ) {
                persistenceIssues.push({
                  code: "duplicate_record",
                  jobIndex: job.jobIndex,
                  message: `Logical Encode Job conflicts with the imported output: ${logicalJob.outputPath}`,
                  sidecarPath: sidecar.sidecarPath,
                });
                continue;
              }
              if (
                outputJob &&
                (!selection ||
                  !profile ||
                  outputJob.discSelectionId !== selection.id ||
                  outputJob.encodingProfileId !== profile.id)
              ) {
                persistenceIssues.push({
                  code: "duplicate_record",
                  jobIndex: job.jobIndex,
                  message: `Encode Job output is already assigned: ${job.outputPath}`,
                  sidecarPath: sidecar.sidecarPath,
                });
                continue;
              }
              let mediaItem: typeof mediaItems.$inferSelect;
              if (selection) {
                if (
                  selection.kind !== job.kind ||
                  selection.titleNumber !== job.titleNumber
                ) {
                  throw new DomainInvariantError(
                    `Disc Selection ${job.sourceKey} has incompatible coordinates`,
                  );
                }
                mediaItem = requireRow(
                  transaction
                    .select()
                    .from(mediaItems)
                    .where(eq(mediaItems.id, selection.mediaItemId))
                    .get(),
                  "legacy media item",
                  selection.mediaItemId,
                );
                if (
                  job.mediaItemKind === "movie" &&
                  mediaItem.id !== requireMovieItem().id
                ) {
                  throw new DomainInvariantError(
                    `Movie Disc Selection ${job.sourceKey} maps to a duplicate Media Item`,
                  );
                }
                // Existing SQLite catalog rows may have been edited after the
                // durable marker was published. SQLite is authoritative once
                // those rows exist, including during the initial cutover.
                unchanged += 2;
              } else {
                mediaItem =
                  job.mediaItemKind === "movie"
                    ? requireMovieItem()
                    : requireRow(
                        transaction
                          .insert(mediaItems)
                          .values({
                            id: newId<MediaItemId>(),
                            parentId: requireMovieItem().id,
                            kind: "bonus_feature",
                            title: job.mediaTitle,
                            createdAt: importedCreatedAt,
                            updatedAt: importedUpdatedAt,
                          })
                          .returning()
                          .get(),
                        "legacy media item",
                        job.mediaTitle,
                      );
                if (job.mediaItemKind !== "movie") {
                  created.mediaItems += 1;
                }
                selection = requireRow(
                  transaction
                    .insert(discSelections)
                    .values({
                      id: newId<DiscSelectionId>(),
                      originalDiscArchiveId: archive.id,
                      mediaItemId: mediaItem.id,
                      sourceKey: job.sourceKey,
                      kind: job.kind,
                      titleNumber: job.titleNumber,
                      chapterStart: null,
                      chapterEnd: null,
                      label: job.label,
                      createdAt: importedCreatedAt,
                      updatedAt: importedUpdatedAt,
                    })
                    .returning()
                    .get(),
                  "legacy disc selection",
                  job.sourceKey,
                );
                selectionsBySourceKey.set(job.sourceKey, selection);
                created.discSelections += 1;
              }

              if (!profile) {
                profile = requireRow(
                  transaction
                    .insert(encodingProfiles)
                    .values({
                      id: newId<EncodingProfileId>(),
                      key: job.profileKey,
                      displayName: job.preset,
                      mediaDomain: "dvd_video",
                      version: 1,
                      settings: { preset: job.preset },
                      createdAt: importedCreatedAt,
                      updatedAt: importedUpdatedAt,
                    })
                    .returning()
                    .get(),
                  "legacy encoding profile",
                  job.profileKey,
                );
                created.encodingProfiles += 1;
              } else {
                unchanged += 1;
              }

              const existingJob = logicalJob ?? outputJob;
              if (!existingJob) {
                transaction
                  .insert(encodeJobs)
                  .values({
                    id: newId<EncodeJobId>(),
                    discSelectionId: selection.id,
                    encodingProfileId: profile.id,
                    outputPath: job.outputPath,
                    ...importedJobState,
                    createdAt: importedCreatedAt,
                    updatedAt:
                      importedJobState.completedAt ?? importedUpdatedAt,
                  })
                  .run();
                created.encodeJobs += 1;
              } else {
                unchanged += 1;
              }
              persistedJobs.push(job);
            }
            const hasDiscSelection = transaction
              .select({ id: discSelections.id })
              .from(discSelections)
              .where(and(
                eq(discSelections.originalDiscArchiveId, archive.id),
                eq(discSelections.isCatalogActive, true),
              ))
              .get() !== undefined;
            if (archive.catalogReviewedAt !== null || hasDiscSelection) {
              if (
                cutover.wasAlreadyPublished &&
                archive.catalogReviewedAt === null &&
                !stagedReviewArchiveIds.has(archive.id)
              ) {
                fingerprintsRequiringHumanReview.add(sidecar.fingerprint);
              }
              let catalogIsReviewable = true;
              try {
                requireReviewableDiscSelections(archive.id, transaction);
              } catch (error) {
                if (!(error instanceof DomainInvariantError)) {
                  throw error;
                }
                catalogIsReviewable = false;
              }
              const requiresHumanReview =
                !catalogIsReviewable ||
                persistenceIssues.length > 0 ||
                (archiveExistedBeforeImport && created.discSelections > 0);
              if (requiresHumanReview) {
                fingerprintsRequiringHumanReview.add(sidecar.fingerprint);
              }
              if (
                fingerprintsRequiringHumanReview.has(sidecar.fingerprint)
              ) {
                if (archive.catalogReviewedAt !== null) {
                  transaction
                    .update(originalDiscArchives)
                    .set({ catalogReviewedAt: null })
                    .where(eq(originalDiscArchives.id, archive.id))
                    .run();
                }
              } else if (
                !cutover.wasAlreadyPublished &&
                archive.catalogReviewedAt === null
              ) {
                reviewCandidate = {
                  archiveId: archive.id,
                  archiveUpdatedAt: archive.updatedAt,
                  reviewedAt: importedUpdatedAt,
                };
              }
            }
            requireCapturedSourceArchive();
          }, { behavior: "immediate" });
        } catch (error) {
          hasIncompleteCapturedWork = true;
          fingerprintsRequiringHumanReview.add(sidecar.fingerprint);
          reviewCandidates.delete(sidecar.fingerprint);
          database.transaction((transaction) => {
            transaction
              .update(originalDiscArchives)
              .set({ catalogReviewedAt: null })
              .where(
                or(
                  eq(
                    originalDiscArchives.fingerprint,
                    sidecar.fingerprint,
                  ),
                  eq(
                    originalDiscArchives.archivePath,
                    sidecar.archivePath,
                  ),
                ),
              )
              .run();
          }, { behavior: "immediate" });
          withdrawIncompletePublication();
          report.sidecarsSkipped += 1;
          report.issues.push({
            code:
              error instanceof DomainInvariantError
                ? "duplicate_record"
                : "invalid_sidecar",
            message:
              error instanceof Error ? error.message : String(error),
            sidecarPath: sidecar.sidecarPath,
          });
          continue;
        }

        if (createdArchiveInTransaction) {
          fingerprintsCreatedDuringImport.add(sidecar.fingerprint);
        }
        if (
          reviewCandidate &&
          !reviewCandidates.has(sidecar.fingerprint)
        ) {
          reviewCandidates.set(sidecar.fingerprint, reviewCandidate);
        }

        for (const job of persistedJobs) {
          const logicalKey = legacyJobLogicalKey(
            sidecar.fingerprint,
            job,
          );
          if (!persistedLegacyJobs.has(logicalKey)) {
            persistedLegacyJobs.set(logicalKey, {
              job,
              sidecarPath: sidecar.sidecarPath,
            });
          }
        }

        report.sidecarsImported += 1;
        for (const key of Object.keys(created) as Array<
          keyof typeof created
        >) {
          report.recordsCreated[key] += created[key];
        }
        report.recordsUpdated += updated;
        report.recordsUnchanged += unchanged;
        report.issues.push(...persistenceIssues);
        if (persistenceIssues.length > 0) {
          hasIncompleteCapturedWork = true;
          withdrawIncompletePublication();
        }
      }

      if (cutover.mode === "schema-one") {
        const catalogJobCandidates = database
          .select({
            archivePath: originalDiscArchives.archivePath,
            fingerprint: originalDiscArchives.fingerprint,
            profileKey: encodingProfiles.key,
            sourceKey: discSelections.sourceKey,
          })
          .from(encodeJobs)
          .innerJoin(
            discSelections,
            eq(discSelections.id, encodeJobs.discSelectionId),
          )
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .innerJoin(
            encodingProfiles,
            eq(encodingProfiles.id, encodeJobs.encodingProfileId),
          )
          .all();
        const libraryJobCandidates = [] as typeof catalogJobCandidates;
        for (const job of catalogJobCandidates) {
          let canonicalArchivePath: string;
          try {
            canonicalArchivePath = realpathSync(job.archivePath);
          } catch {
            schemaOneHasUnresolvedWork = true;
            report.issues.push({
              code: "invalid_job",
              message:
                "Schema-1 cutover recovery is missing a legacy sidecar recovery input for an Encode Job whose archive path can no longer be canonicalized; SQLite state and the schema-1 marker were preserved",
              sidecarPath: job.archivePath,
            });
            continue;
          }
          if (isPathWithinDirectory(
            originalsLibraryPath,
            canonicalArchivePath,
          )) {
            libraryJobCandidates.push(job);
          }
        }
        for (const importedJob of libraryJobCandidates) {
          const logicalKey = createLegacyJobLogicalKey({
            fingerprint: importedJob.fingerprint,
            profileKey: importedJob.profileKey,
            sourceKey: importedJob.sourceKey,
          });
          if (trustedSchemaOneSnapshots.has(logicalKey)) {
            continue;
          }
          const discoveredWithKnownIssues = discoveries.some(
            (discovery) =>
              discovery.outcome === "parsed" &&
              discovery.sidecar.fingerprint === importedJob.fingerprint &&
              discovery.sidecar.archivePath === importedJob.archivePath &&
              discovery.sidecar.issues.length > 0,
          );
          if (discoveredWithKnownIssues) {
            continue;
          }
          schemaOneHasUnresolvedWork = true;
          report.issues.push({
            code: "invalid_job",
            message:
              "Schema-1 cutover recovery is missing a legacy sidecar recovery input for an Encode Job already attributable to this library; SQLite state and the schema-1 marker were preserved",
            sidecarPath: importedJob.archivePath,
          });
        }
        if (!schemaOneHasUnresolvedWork) {
          cutover.upgradeSchemaOne(trustedSchemaOneSnapshots);
        }
      } else {
        for (const [logicalKey, snapshot] of cutover.jobSnapshots) {
          if (reconciledSnapshotKeys.has(logicalKey)) {
            continue;
          }
          const identity = parseLegacyJobLogicalKey(logicalKey);
          if (!identity) {
            throw new DomainInvariantError(
              "Published legacy job has an invalid logical identity",
            );
          }
          const { fingerprint, profileKey, sourceKey } = identity;
          const archive = database
            .select()
            .from(originalDiscArchives)
            .where(eq(originalDiscArchives.fingerprint, fingerprint))
            .get();
          const profile = database
            .select()
            .from(encodingProfiles)
            .where(
              and(
                eq(encodingProfiles.mediaDomain, "dvd_video"),
                eq(encodingProfiles.key, profileKey),
                eq(encodingProfiles.version, 1),
              ),
            )
            .get();
          const reconciledJob =
            archive && profile
              ? database
                  .select({ id: encodeJobs.id })
                  .from(encodeJobs)
                  .innerJoin(
                    discSelections,
                    eq(discSelections.id, encodeJobs.discSelectionId),
                  )
                  .where(
                    and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        archive.id,
                      ),
                      eq(discSelections.sourceKey, sourceKey),
                      eq(encodeJobs.encodingProfileId, profile.id),
                    ),
                  )
                  .get()
              : undefined;
          if (!reconciledJob) {
            hasIncompleteCapturedWork = true;
            fingerprintsRequiringHumanReview.add(fingerprint);
            reviewCandidates.delete(fingerprint);
            database.transaction((transaction) => {
              transaction
                .update(originalDiscArchives)
                .set({ catalogReviewedAt: null })
                .where(eq(originalDiscArchives.fingerprint, fingerprint))
                .run();
            }, { behavior: "immediate" });
            withdrawIncompletePublication();
            report.issues.push({
              code: "invalid_job",
              jobIndex: snapshot.jobIndex,
              message:
                "The Encode Job captured at SQLite cutover is missing from both the legacy sidecars and SQLite catalog",
              sidecarPath: snapshot.sidecarPath,
            });
          }
        }
        for (const snapshot of cutover.sidecarSnapshots) {
          const reconciledArchive = database
            .select({ id: originalDiscArchives.id })
            .from(originalDiscArchives)
            .where(
              and(
                eq(
                  originalDiscArchives.fingerprint,
                  snapshot.fingerprint,
                ),
                eq(
                  originalDiscArchives.archivePath,
                  snapshot.archivePath,
                ),
              ),
            )
            .get();
          if (!reconciledArchive) {
            hasIncompleteCapturedWork = true;
            fingerprintsRequiringHumanReview.add(snapshot.fingerprint);
            reviewCandidates.delete(snapshot.fingerprint);
            withdrawIncompletePublication();
            report.issues.push({
              code: "invalid_sidecar",
              message:
                "The Original Disc Archive captured at SQLite cutover is missing from both the legacy sidecar inventory and SQLite catalog",
              sidecarPath: snapshot.sidecarPath,
            });
          }
        }
      }
      if (hasIncompleteCapturedWork) {
        withdrawIncompletePublication();
      } else {
        database.transaction((transaction) => {
          if (cutoverFenceArchiveIds.size > 0) {
            for (const [fingerprint, candidate] of reviewCandidates) {
              if (fingerprintsRequiringHumanReview.has(fingerprint)) {
                continue;
              }
              requireReviewableDiscSelections(
                candidate.archiveId,
                transaction,
              );
            }
            for (const [fingerprint, candidate] of reviewCandidates) {
              if (fingerprintsRequiringHumanReview.has(fingerprint)) {
                continue;
              }
              transaction
                .update(originalDiscArchives)
                .set({ catalogReviewedAt: candidate.reviewedAt })
                .where(
                  and(
                    eq(originalDiscArchives.id, candidate.archiveId),
                    eq(
                      originalDiscArchives.updatedAt,
                      candidate.archiveUpdatedAt,
                    ),
                    isNull(originalDiscArchives.catalogReviewedAt),
                  ),
                )
                .run();
            }
          }
          let lastPendingArchiveId: OriginalDiscArchiveId | undefined;
          for (;;) {
            const pendingArchives = transaction
              .select({
                archivePath: originalDiscArchives.archivePath,
                id: originalDiscArchives.id,
              })
              .from(originalDiscArchives)
              .where(and(
                eq(originalDiscArchives.legacyCutoverPending, true),
                lastPendingArchiveId === undefined
                  ? undefined
                  : gt(originalDiscArchives.id, lastPendingArchiveId),
              ))
              .orderBy(asc(originalDiscArchives.id))
              .limit(LEGACY_CUTOVER_RELEASE_PAGE_SIZE)
              .all();
            const libraryArchiveIds = pendingArchives
              .filter((archive) =>
                isPathWithinDirectory(
                  originalsLibraryPath,
                  archive.archivePath,
                ),
              )
              .map((archive) => archive.id);
            if (libraryArchiveIds.length > 0) {
              transaction
                .update(originalDiscArchives)
                .set({ legacyCutoverPending: false })
                .where(inArray(
                  originalDiscArchives.id,
                  libraryArchiveIds,
                ))
                .run();
            }
            if (
              pendingArchives.length < LEGACY_CUTOVER_RELEASE_PAGE_SIZE
            ) {
              break;
            }
            lastPendingArchiveId = pendingArchives.at(-1)!.id;
          }
          transaction
            .delete(legacyCutoverStagedSidecars)
            .where(eq(
              legacyCutoverStagedSidecars.originalsLibraryPath,
              originalsLibraryPath,
            ))
            .run();
        }, { behavior: "immediate" });
      }

      return report;
    },
  };
}
