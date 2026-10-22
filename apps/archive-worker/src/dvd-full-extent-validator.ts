import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  DVD_STRUCTURAL_CHECK_KINDS,
  type DvdStructuralCheckKind,
  type DvdStructuralFindingInput,
  type DvdUnrecoveredSourceRange,
} from "@rip-dvd/data-access";
import {
  ProfileFailure,
  ProfileReader,
  SECTOR,
  validateSourceRanges,
  type MetadataBlocker,
  type MetadataObservation,
} from "./dvd-metadata-profile-reader.js";
import { inspectIsoProfile } from "./dvd-metadata-profile-iso.js";
import {
  inspectDvdProfile,
  reconcileFiles,
} from "./dvd-metadata-profile-video.js";
import { inspectUdfProfile } from "./dvd-metadata-profile-udf.js";
export const DVD_FULL_EXTENT_METADATA_POLICY_VERSION =
  "dvd-full-extent-metadata-v1";
export interface DvdFullExtentMetadataValidationRequest {
  expectedByteCount: number;
  imagePath: string;
  signal: AbortSignal;
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
  imageFilesystemIdentity?: string;
}
export interface DvdFullExtentMetadataDecision {
  policyVersion: typeof DVD_FULL_EXTENT_METADATA_POLICY_VERSION;
  decision: "publishable" | "blocked";
  impact: "unknown" | "listed_checks_agree";
  observations: MetadataObservation[];
  blockers: MetadataBlocker[];
  blockedCheckKind: DvdStructuralCheckKind | null;
  structuralChecks: readonly {
    checkKind: DvdStructuralCheckKind;
    execution: "completed" | "interrupted" | "not_run";
    testedExtent: DvdStructuralFindingInput["testedExtent"];
    hasUnprovedDependencies: boolean;
  }[];
}
export interface DvdFullExtentMetadataValidator {
  validate(
    request: DvdFullExtentMetadataValidationRequest,
  ): Promise<DvdFullExtentMetadataDecision>;
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function testedExtent(
  observations: readonly MetadataObservation[],
): DvdStructuralFindingInput["testedExtent"] {
  const ranges = observations.flatMap(({ dependencies }) =>
    dependencies.map(({ startLba, sectorCount }) => ({
      startLba,
      endLbaExclusive: startLba + sectorCount,
    }))
  ).sort((left, right) =>
    left.startLba - right.startLba ||
    left.endLbaExclusive - right.endLbaExclusive
  );
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior !== undefined && range.startLba <= prior.endLbaExclusive) {
      prior.endLbaExclusive = Math.max(
        prior.endLbaExclusive,
        range.endLbaExclusive,
      );
    } else {
      merged.push({ ...range });
    }
  }
  if (merged.length === 0) return null;
  return {
    startLba: merged[0]!.startLba,
    endLbaExclusive: merged.at(-1)!.endLbaExclusive,
    observedSectorCount: merged.reduce(
      (total, range) =>
        total + range.endLbaExclusive - range.startLba,
      0,
    ),
  };
}
export function createNodeDvdFullExtentMetadataValidator(): DvdFullExtentMetadataValidator {
  return {
    async validate(request) {
      const { expectedByteCount, imagePath, signal } = request;
      let unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[] = [];
      const blockers: MetadataBlocker[] = [];
      let reader: ProfileReader | undefined;
      let blockedCheckKind: DvdStructuralCheckKind | null = null;
      try {
        signal.throwIfAborted();
        if (
          !Number.isSafeInteger(expectedByteCount) ||
          expectedByteCount <= 0 ||
          expectedByteCount % SECTOR !== 0
        )
          throw new ProfileFailure({
            field: "image",
            reason: "local_failure",
            message: "Invalid accepted extent",
          });
        const file = await open(
          imagePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const before = await file.stat({ bigint: true });
          if (
            !before.isFile() ||
            before.size !== BigInt(expectedByteCount) ||
            !same(before, await lstat(imagePath, { bigint: true })) ||
            (request.imageFilesystemIdentity !== undefined &&
              request.imageFilesystemIdentity !== `${before.dev}:${before.ino}`)
          )
            throw new ProfileFailure({
              field: "image",
              reason: "local_failure",
              message: "Image does not match accepted copy",
            });
          reader = new ProfileReader(
            file,
            expectedByteCount / SECTOR,
            request.unrecoveredSourceRanges,
            signal,
          );
          reader.beginStructuralCheck("filesystem_structure");
          validateSourceRanges(
            request.unrecoveredSourceRanges,
            expectedByteCount / SECTOR,
          );
          unrecoveredSourceRanges = request.unrecoveredSourceRanges.map(
            (range) => ({ ...range }),
          );
          try {
            await inspectIsoProfile(reader);
            await inspectUdfProfile(reader);
            reader.check(
              reader.bootstrap && reader.geometry,
              "bootstrap",
              "No surviving supported bootstrap and geometry",
              "unsupported_layout",
            );
            for (const extent of reader.udfExtents)
              for (const volume of reader.isoVolumes)
                reader.extent(
                  extent.start,
                  extent.bytes,
                  extent.field,
                  volume * SECTOR,
                );
            reconcileFiles(reader);
            reader.completeStructuralCheck("filesystem_structure");
            await inspectDvdProfile(reader);
          } finally {
            if (
              !same(before, await file.stat({ bigint: true })) ||
              !same(before, await lstat(imagePath, { bigint: true }))
            )
              reader.fail(
                "image",
                "Image changed during metadata validation",
                "local_failure",
              );
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        signal.throwIfAborted();
        blockedCheckKind = reader?.currentStructuralCheckKind() ?? null;
        blockers.push(
          error instanceof ProfileFailure
            ? error.blocker
            : {
                field: "image",
                reason: "local_failure",
                message: "Unexplained local metadata failure",
              },
        );
      }
      // Comparisons inherit the physical dependencies of their named operands.
      const fields = new Map<string, MetadataObservation[]>();
      for (const observation of reader?.observations ?? []) {
        const existing = fields.get(observation.field) ?? [];
        existing.push(observation);
        fields.set(observation.field, existing);
      }
      const dependencies = (
        observation: MetadataObservation,
        seen: Set<string>,
      ): MetadataObservation["dependencies"] => {
        if (seen.has(observation.field)) return [];
        const next = new Set(seen).add(observation.field);
        return observation.dependencies.concat(
          (observation.prerequisites ?? []).flatMap((name) =>
            (fields.get(name) ?? []).flatMap((o) => dependencies(o, next)),
          ),
        );
      };
      for (const observation of reader?.observations ?? [])
        if (observation.prerequisites?.length)
          observation.dependencies = [
            ...new Map(
              dependencies(observation, new Set()).map((d) => [
                `${d.startLba}:${d.sectorCount}`,
                d,
              ]),
            ).values(),
          ];
      const observations = reader?.observations ?? [];
      return {
        policyVersion: DVD_FULL_EXTENT_METADATA_POLICY_VERSION,
        decision: blockers.length ? "blocked" : "publishable",
        impact:
          blockers.length || unrecoveredSourceRanges.length || reader?.unknown
            ? "unknown"
            : "listed_checks_agree",
        observations,
        blockers,
        blockedCheckKind,
        structuralChecks: DVD_STRUCTURAL_CHECK_KINDS.map((checkKind) => {
          const execution = reader?.structuralCheckExecution.get(checkKind) ??
            "not_run";
          const relevant = observations.filter(
            (observation) => observation.checkKind === checkKind,
          );
          return {
            checkKind,
            execution: execution === "running"
              ? "interrupted" as const
              : execution,
            testedExtent: testedExtent(relevant),
            hasUnprovedDependencies: relevant.some(
              ({ status }) => status !== "known",
            ),
          };
        }),
      };
    },
  };
}
