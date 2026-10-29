import type { CommittedDvdCheckpointEvidence, DvdTitleIdentityObservationInput, UnreadableSectorRange } from "@rip-dvd/data-access";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DamagePreviewInspection } from "@rip-dvd/application";
import { encodeOutputFilesystemIdentity } from "@rip-dvd/data-access";
import { DatabaseSync } from "node:sqlite";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedDamagePreview(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  coverage: "source_span" | "whole_cell" | "unknown" | "mixed" = "source_span",
  timings: readonly (readonly [number, number])[] = [[1_000, 5_000], [35_000, 40_000], [71_000, 400_000]],
  options: { evidence?: { archive: Awaited<ReturnType<typeof seedCommittedArchiveEvidence>>["archive"]; manifest: CommittedDvdCheckpointEvidence }; stopRecovery?: boolean; otherTitlePartial?: boolean; additionalTitleObservations?: readonly DvdTitleIdentityObservationInput[]; singleChapter?: boolean; sourceExtent?: UnreadableSectorRange } = {},
) {
  const { archive, manifest } = options.evidence ?? await seedCommittedArchiveEvidence(fixture, [
    { startLba: 10, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  const sqlite = new DatabaseSync(fixture.databasePath);
  if (options.stopRecovery !== false) sqlite.prepare("UPDATE archive_recoveries SET status = 'stopped', stop_operation_id = 'synthetic-stop', stop_requested_at = 1, stopped_at = 1 WHERE original_disc_archive_id = ?").run(archive.id);
  const disc = sqlite.prepare("SELECT detected_disc_id FROM original_disc_archives WHERE id = ?").get(archive.id)!;
  const scan = { schemaVersion: 2, contentId: archive.fingerprint, titles: [{ number: 1, durationSeconds: 500, chapters: options.singleChapter ? 1 : 4, audioStreams: [{ id: 128, format: "ac3" }], subtitles: [] }] };
  sqlite.prepare("UPDATE detected_discs SET scan_data = ? WHERE id = ?").run(JSON.stringify(scan), String(disc.detected_disc_id));
  sqlite.close();
  const access = fixture.openAccess();
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  await access.assessDvdStructure(archive.id, ownership, async () => ({
    outcome: "completed",
    findings: (["filesystem_structure", "dvd_navigation", "title_enumeration"] as const).map((checkKind) => ({
      checkKind,
      policyVersion: "synthetic-structure-v1",
      testedExtent: { startLba: 0, endLbaExclusive: manifest.acceptedEndLbaExclusive, observedSectorCount: manifest.acceptedEndLbaExclusive },
      outcome: "valid" as const,
      reason: null,
      evidenceReference: `synthetic:${checkKind}`,
    })),
  }));
  const reviewSet = access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: archive.id,
    checkpoint: { manifestId: manifest.id, manifestRevision: manifest.revision, manifestDigest: manifest.manifestDigest },
    observations: [...(options.otherTitlePartial ? [1, 2] : [1]).map((number) => ({
      displayTitleNumber: number,
      navigation: { videoTitleSetNumber: 1, titleSetTitleNumber: number, programChainNumber: number },
      selectedPath: [{ programNumber: 1, cellNumber: 1, vobId: 1, cellId: 1 }],
      angleNumber: 1, angleCount: 1, chapterStart: 1, chapterEnd: options.singleChapter ? 1 : 4, chapterCount: options.singleChapter ? 1 : 4,
      sourceExtents: [options.sourceExtent ?? { startLba: 0, sectorCount: 100 }],
    })), ...(options.additionalTitleObservations ?? [])],
  });
  const observation = reviewSet.items[0]!.observation;
  const assessment = await access.assessDvdTitleDamage(archive.id, ownership, async () => reviewSet.items.map(({ observation }) => ({
    titleIdentityObservationId: observation.id,
    sourceReferences: observation.sourceExtents.map((range) => ({ kind: "multiplexed_content" as const, ...range })),
    mappingCoverage: { state: options.otherTitlePartial && observation.displayTitleNumber !== 1 ? "partial" as const : "complete" as const,
      policyVersion: "synthetic-map-v1", unknownReasons: options.otherTitlePartial && observation.displayTitleNumber !== 1
        ? [{ code: "SYNTHETIC_OTHER_TITLE_PARTIAL", message: "Synthetic partial other title." }] : [] },
    timingEvidence: {
      policyVersion: "dvd-title-damage-timing-v1",
      occurrences: (coverage === "unknown" ? [null] : timings).map((span, index) => ({
        playbackOccurrence: index + 1,
        spans: span === null ? [] : [{
          sourceRange: observation.sourceExtents[0]!,
          startMilliseconds: span[0]!, endMilliseconds: span[1]!,
          timingMethod: "synthetic-timing-v1", coverage: coverage === "whole_cell" || (coverage === "mixed" && index > 0) ? "whole_cell" : "source_span",
        }],
        unknownReasons: span === null ? [{ code: "TIMING_UNAVAILABLE", message: "Timing is unknown." }] : [],
      })),
    },
  })));
  const profile = access.encodingProfiles.create({
    key: "synthetic-preview", displayName: "Synthetic preview", mediaDomain: "dvd_video",
    settings: { preset: "Fast 1080p30", container: "mkv" },
  });
  access.close();
  return {
    archive, manifest, observation, assessment, profile,
    input: {
      mode: "damage" as const,
      titleIdentityObservationId: observation.id,
      playbackRange: { startMilliseconds: 0, endMilliseconds: 500_000 },
      intervalIndexes: [0, 1, 2],
      assessmentIdentity: assessment!.id,
      streams: { audio: [128], subtitles: [] },
      encodingProfileId: profile.id,
    },
  };
}

export async function seedRetainedDamagePreview(fixture: ReturnType<typeof createOperatorWorkflowFixture>, provided?: Awaited<ReturnType<typeof seedDamagePreview>>) {
  const seeded = provided ?? await seedDamagePreview(fixture);
  const review = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)])).result as { preflightToken: string };
  const requested = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-retained-request", "--json", JSON.stringify({ selection: seeded.input, preflightToken: review.preflightToken })]);
  if (requested.exitCode !== 0) throw new Error(`Synthetic Damage Preview admission failed: ${JSON.stringify(requested.result)}`);
  const id = (requested.result as { id: string }).id;
  const access = fixture.openAccess();
  const record = access.damagePreviews.claim("synthetic-retention-worker")!;
  const directory = join(fixture.mediaLibraryPath, ".damage-previews", id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "0.mkv");
  const bytes = Buffer.from("synthetic finalized preview bytes"); writeFileSync(path, bytes);
  record.status = "complete";
  record.artifacts = [{ identity: `damage-preview-v1.${id}.0`, path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, mediaType: "video/x-matroska", durationMilliseconds: 45_000, coverage: { startMilliseconds: 0, endMilliseconds: 45_000 } }];
  access.damagePreviews.update(record); access.close();
  const inspect = async () => (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
  return { fixture, seeded, id, path, bytes, inspect };
}

export async function seedDamagePreviewWithNormalOutput(fixture: ReturnType<typeof createOperatorWorkflowFixture>) {
  const preview = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  const selectionIds = new Set(access.catalog.listDiscSelections({ originalDiscArchiveId: preview.seeded.archive.id, includeHistorical: true }).map((item) => item.id));
  const output = access.encodeJobs.list().find((job) => selectionIds.has(job.discSelectionId) && job.status === "completed")!;
  access.close();
  writeFileSync(output.outputPath, "synthetic historical normal output with no immutable source snapshot");
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE encode_jobs SET output_validation_result = 'passed', output_validation_filesystem_identity = ?, output_validated_at = ?, output_completeness = 'complete' WHERE id = ?")
    .run(encodeOutputFilesystemIdentity(lstatSync(output.outputPath)), Date.now(), output.id);
  sqlite.close();
  return { ...preview, output };
}
