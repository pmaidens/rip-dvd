import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DamagePreviewInspection } from "@rip-dvd/application";
import { DatabaseSync } from "node:sqlite";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedDamagePreview(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  coverage: "source_span" | "whole_cell" | "unknown" | "mixed" = "source_span",
  timings: readonly (readonly [number, number])[] = [[1_000, 5_000], [35_000, 40_000], [71_000, 400_000]],
) {
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [
    { startLba: 10, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE archive_recoveries SET status = 'stopped', stop_operation_id = 'synthetic-stop', stop_requested_at = 1, stopped_at = 1 WHERE original_disc_archive_id = ?").run(archive.id);
  const disc = sqlite.prepare("SELECT detected_disc_id FROM original_disc_archives WHERE id = ?").get(archive.id)!;
  const scan = { schemaVersion: 2, contentId: archive.fingerprint, titles: [{ number: 1, durationSeconds: 500, chapters: 4, audioStreams: [{ id: 128, format: "ac3" }], subtitles: [] }] };
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
    checkpoint: { manifestId: manifest.id, manifestRevision: 1, manifestDigest: manifest.manifestDigest },
    observations: [{
      displayTitleNumber: 1,
      navigation: { videoTitleSetNumber: 1, titleSetTitleNumber: 1, programChainNumber: 1 },
      selectedPath: [{ programNumber: 1, cellNumber: 1, vobId: 1, cellId: 1 }],
      angleNumber: 1, angleCount: 1, chapterStart: 1, chapterEnd: 4, chapterCount: 4,
      sourceExtents: [{ startLba: 0, sectorCount: 100 }],
    }],
  });
  const observation = reviewSet.items[0]!.observation;
  const assessment = await access.assessDvdTitleDamage(archive.id, ownership, async () => [{
    titleIdentityObservationId: observation.id,
    sourceReferences: [{ kind: "multiplexed_content", startLba: 0, sectorCount: 100 }],
    mappingCoverage: { state: "complete", policyVersion: "synthetic-map-v1", unknownReasons: [] },
    timingEvidence: {
      policyVersion: "dvd-title-damage-timing-v1",
      occurrences: (coverage === "unknown" ? [null] : timings).map((span, index) => ({
        playbackOccurrence: index + 1,
        spans: span === null ? [] : [{
          sourceRange: { startLba: 0, sectorCount: 100 },
          startMilliseconds: span[0]!, endMilliseconds: span[1]!,
          timingMethod: "synthetic-timing-v1", coverage: coverage === "whole_cell" || (coverage === "mixed" && index > 0) ? "whole_cell" : "source_span",
        }],
        unknownReasons: span === null ? [{ code: "TIMING_UNAVAILABLE", message: "Timing is unknown." }] : [],
      })),
    },
  }]);
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

export async function seedRetainedDamagePreview(fixture: ReturnType<typeof createOperatorWorkflowFixture>) {
  const seeded = await seedDamagePreview(fixture);
  const review = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)])).result as { preflightToken: string };
  const requested = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-retained-request", "--json", JSON.stringify({ selection: seeded.input, preflightToken: review.preflightToken })]);
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
