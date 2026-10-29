import type { CommittedDvdCheckpointEvidence, DvdTitleIdentityObservationInput } from "@rip-dvd/data-access";
import { DatabaseSync } from "node:sqlite";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedDamagePreview(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  coverage: "source_span" | "whole_cell" | "unknown" | "mixed" = "source_span",
  timings: readonly (readonly [number, number])[] = [[1_000, 5_000], [35_000, 40_000], [71_000, 400_000]],
  options: { evidence?: { archive: Awaited<ReturnType<typeof seedCommittedArchiveEvidence>>["archive"]; manifest: CommittedDvdCheckpointEvidence }; stopRecovery?: boolean; otherTitlePartial?: boolean; additionalTitleObservations?: readonly DvdTitleIdentityObservationInput[]; singleChapter?: boolean; sourceSectorCount?: number } = {},
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
      testedExtent: { startLba: 0, endLbaExclusive: 1_024, observedSectorCount: 1_024 },
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
      sourceExtents: [{ startLba: 0, sectorCount: options.sourceSectorCount ?? 100 }],
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
