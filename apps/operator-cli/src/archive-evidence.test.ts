import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DataAccess,
  DvdStructuralFindingInput,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
  withEvidenceGuardsDisabled,
} from "./archive-evidence.test-support.js";
import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

function structuralFindings(
  outcome: "valid" | "invalid" = "valid",
): DvdStructuralFindingInput[] {
  return ["filesystem_structure", "dvd_navigation", "title_enumeration"]
    .map((checkKind) => ({
      checkKind,
      policyVersion: "synthetic-structural-check-v1",
      testedExtent: {
        startLba: 0,
        endLbaExclusive: 1024,
        observedSectorCount: 1024,
      },
      outcome: checkKind === "dvd_navigation" ? outcome : "valid",
      reason: checkKind === "dvd_navigation" && outcome === "invalid"
        ? {
          code: "NAVIGATION_CONTRADICTION",
          message: "Readable navigation claims disagree.",
        }
        : null,
      evidenceReference: `synthetic-structural-evidence:${checkKind}:${outcome}`,
    })) as DvdStructuralFindingInput[];
}

async function recordStructuralAssessment(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  findings: readonly DvdStructuralFindingInput[],
) {
  const recorded = await access.assessDvdStructure(
    originalDiscArchiveId,
    createArchiveImageOwnership({
      authorityRootPath: fixture.originalsLibraryPath,
    }),
    async () => findings,
  );
  if (recorded === null) {
    throw new Error("Expected structural assessment support");
  }
  return recorded;
}

it("keeps historical integrity and unknown evidence distinct from zero damage", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const read = await fixture.run(["archive-evidence", archive.id]);
  expect(read.exitCode).toBe(0);
  expect(read.result).toMatchObject({
    schemaVersion: 1, originalDiscArchiveId: archive.id,
    available: false, unavailableReason: "DVD_EVIDENCE_NOT_RECORDED",
    revision: null, evidence: null,
    ranges: null, complete: false, nextCursor: null,
  });
});

it("reads damaged committed evidence using only the accepted extent", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedCommittedArchiveEvidence(fixture, [
    { startLba: 10, sectorCount: 128, classification: "skipped_untested" },
    { startLba: 1023, sectorCount: 1, classification: "skipped_untested" },
  ], true);
  const read = await fixture.run(["archive-evidence", archive.id, "--limit", "1"]);
  expect(read.exitCode).toBe(0);
  expect(read.result).toMatchObject({
    available: true, unavailableReason: null,
    revision: { number: 1, manifestId: `${archive.id}:initial` },
    evidence: {
      acceptedEndLbaExclusive: 1024, sectorSizeBytes: 2048, integrity: "incomplete_read",
      boundaryEvidence: { excludedSectorCount: 256 },
      skippedSectorCount: 129, unresolvedSectorCount: 129,
      skippedPercentage: 12.59765625, unresolvedPercentage: 12.59765625,
      classifications: { skipped_untested: 129, individually_failed: 0 },
    },
    ranges: [{ startLba: 10, sectorCount: 128, classification: "skipped_untested" }],
    truncated: true, complete: false, nextCursor: expect.any(String),
  });
});

it("reports a clean checkpoint as complete with a known zero", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedCommittedArchiveEvidence(fixture);
  expect((await fixture.run(["archive-evidence", archive.id])).result).toMatchObject({
    available: true, evidence: { integrity: "clean_read", skippedSectorCount: 0,
      unresolvedSectorCount: 0, unresolvedPercentage: 0 },
    ranges: [], truncated: false, complete: true, nextCursor: null,
  });
});

it("keeps a current structural assessment when a later attempt fails", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture);
  const checkpoint = {
    originalDiscArchiveId: archive.id,
    manifestId: manifest.id,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
  };

  expect((await fixture.run([
    "inspect",
    "original-disc-archives",
    archive.id,
  ])).result).toMatchObject({
    item: {
      structuralAssessment: {
        state: "pending",
        currentAssessmentIdentity: null,
        assessment: null,
        unavailableReasons: [{ code: "ASSESSMENT_PENDING" }],
      },
    },
  });

  const access = fixture.openAccess();
  const completed = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings(),
  );
  const failed = access.dvdStructuralAssessments.recordFailed({
    checkpoint,
    reason: {
      code: "STRUCTURAL_CHECK_TOOL_FAILED",
      message: "The structural check tool did not complete.",
    },
  });
  access.close();

  const inspected = await fixture.run([
    "inspect",
    "original-disc-archives",
    archive.id,
  ]);
  expect(inspected.result).toMatchObject({
    item: {
      integrity: "clean_read",
      structuralAssessment: {
        state: "current",
        currentAssessmentIdentity: completed.assessment.id,
        unavailableReasons: [],
        assessment: {
          id: completed.assessment.id,
          validity: "valid",
          findings: [
            {
              checkKind: "filesystem_structure",
              policyVersion: "synthetic-structural-check-v1",
              testedExtent: {
                startLba: 0,
                endLbaExclusive: 1024,
                observedSectorCount: 1024,
              },
              outcome: "valid",
              reason: null,
              evidenceReference:
                "synthetic-structural-evidence:filesystem_structure:valid",
            },
            { checkKind: "dvd_navigation", outcome: "valid" },
            { checkKind: "title_enumeration", outcome: "valid" },
          ],
        },
        latestAttempt: {
          sequence: failed.sequence,
          outcome: "failed",
          assessmentIdentity: null,
          reason: { code: "STRUCTURAL_CHECK_TOOL_FAILED" },
        },
      },
    },
  });
});

it("reuses semantic assessment identity and keeps persisted evidence immutable", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedCommittedArchiveEvidence(fixture);
  const access = fixture.openAccess();
  const first = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings(),
  );
  const noOpRetry = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings().reverse(),
  );
  const contradiction = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings("invalid"),
  );
  access.close();

  expect(noOpRetry.assessment.id).toBe(first.assessment.id);
  expect(contradiction.assessment.id).not.toBe(first.assessment.id);
  expect((await fixture.run([
    "inspect",
    "original-disc-archives",
    archive.id,
  ])).result).toMatchObject({
    item: {
      integrity: "clean_read",
      structuralAssessment: {
        state: "current",
        currentAssessmentIdentity: contradiction.assessment.id,
        assessment: {
          id: contradiction.assessment.id,
          validity: "invalid",
          findings: [
            { checkKind: "filesystem_structure", outcome: "valid" },
            {
              checkKind: "dvd_navigation",
              outcome: "invalid",
              reason: { code: "NAVIGATION_CONTRADICTION" },
            },
            { checkKind: "title_enumeration", outcome: "valid" },
          ],
        },
      },
    },
  });

  const database = new DatabaseSync(fixture.databasePath);
  try {
    expect(() => database.prepare(`
      UPDATE dvd_structural_assessments SET validity = 'valid' WHERE id = ?
    `).run(contradiction.assessment.id)).toThrow(/immutable/i);
    expect(() => database.prepare(`
      DELETE FROM dvd_structural_check_attempts WHERE sequence = ?
    `).run(contradiction.attempt.sequence)).toThrow(/immutable/i);
  } finally {
    database.close();
  }
});

it("marks the last structural assessment outdated when the checkpoint advances", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const access = fixture.openAccess();
  const completed = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings(),
  );
  access.close();
  const current = advanceCommittedArchiveEvidence(fixture, manifest);
  const currentAccess = fixture.openAccess();
  currentAccess.dvdStructuralAssessments.recordFailed({
    checkpoint: {
      originalDiscArchiveId: archive.id,
      manifestId: current.id,
      manifestRevision: current.revision,
      manifestDigest: current.manifestDigest,
      acceptedEndLbaExclusive: current.acceptedEndLbaExclusive,
    },
    reason: {
      code: "CONSISTENCY_FAULT",
      message: "A consistent image read was unavailable.",
    },
  });
  currentAccess.close();

  expect((await fixture.run([
    "inspect",
    "original-disc-archives",
    archive.id,
  ])).result).toMatchObject({
    item: {
      integrity: "incomplete_read",
      structuralAssessment: {
        state: "outdated",
        checkpoint: { manifestRevision: 2, manifestId: current.id },
        currentAssessmentIdentity: null,
        assessment: {
          id: completed.assessment.id,
          checkpoint: { manifestRevision: 1 },
        },
        latestAttempt: {
          outcome: "failed",
          reason: { code: "CONSISTENCY_FAULT" },
        },
        unavailableReasons: [
          { code: "ASSESSMENT_OUTDATED" },
          { code: "CONSISTENCY_FAULT" },
        ],
      },
    },
  });
});

it("records a structural assessment against the current recovery checkpoint", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 10,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const current = advanceCommittedArchiveEvidence(fixture, manifest, {
    publishFilesystemCheckpoint: true,
  });
  const access = fixture.openAccess();
  const completed = await recordStructuralAssessment(
    fixture,
    access,
    archive.id,
    structuralFindings(),
  );
  access.close();

  expect(completed.assessment.checkpoint).toMatchObject({
    manifestId: current.id,
    manifestRevision: current.revision,
    manifestDigest: current.manifestDigest,
  });
  expect((await fixture.run([
    "inspect",
    "original-disc-archives",
    archive.id,
  ])).result).toMatchObject({
    item: {
      structuralAssessment: {
        state: "current",
        currentAssessmentIdentity: completed.assessment.id,
        checkpoint: {
          manifestId: current.id,
          manifestRevision: current.revision,
        },
      },
    },
  });
});

it("pages every compact range without omission and reuses stable cursors", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const ranges = Array.from({ length: 137 }, (_, i) => ({ startLba: i * 3, sectorCount: 1, classification: "skipped_untested" as const }));
  const { archive } = await seedCommittedArchiveEvidence(fixture, ranges);
  const first = await fixture.run(["archive-evidence", archive.id]);
  expect(first.result).toMatchObject({ truncated: true, complete: false, evidence: { rangeCount: 137, unresolvedSectorCount: 137 } });
  expect((await fixture.run(["archive-evidence", archive.id])).result).toEqual(first.result);
  const collected: unknown[] = [];
  let page = first.result as { ranges: unknown[]; nextCursor: string | null; complete: boolean; revision: unknown };
  while (true) {
    collected.push(...page.ranges);
    if (page.nextCursor === null) break;
    const next = await fixture.run(["archive-evidence", archive.id, "--cursor", page.nextCursor]);
    expect(next.exitCode).toBe(0);
    expect(next.result).toMatchObject({ revision: page.revision });
    page = next.result as typeof page;
  }
  expect(collected).toEqual(ranges);
  expect(page.complete).toBe(true);
});

it("uses the filesystem checkpoint while the database header is missing", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedCommittedArchiveEvidence(fixture, [{ startLba: 8, sectorCount: 2, classification: "skipped_untested" }]);
  withEvidenceGuardsDisabled(fixture.databasePath, db => {
    db.prepare("DELETE FROM dvd_archive_evidence_headers WHERE original_disc_archive_id = ?").run(archive.id);
  });
  expect((await fixture.run(["archive-evidence", archive.id])).result).toMatchObject({
    available: true, revision: { number: 1 }, evidence: { integrity: "incomplete_read", unresolvedSectorCount: 2 },
  });
});

it.each([
  ["checkpoint.json", "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE"],
  ["initial-manifest.json", "DVD_PUBLICATION_MANIFEST_CONFLICT"],
] as const)("keeps missing %s unavailable rather than clean", async (filename, reason) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, directory } = await seedCommittedArchiveEvidence(fixture);
  unlinkSync(join(directory, filename));
  expect((await fixture.run(["archive-evidence", archive.id])).result).toMatchObject({
    available: false, unavailableReason: reason, evidence: null, ranges: null, complete: false,
  });
});

it("rejects stale cursors and never presents evidence from a different revision", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, directory, pointer } = await seedCommittedArchiveEvidence(fixture, [
    { startLba: 1, sectorCount: 1, classification: "skipped_untested" },
    { startLba: 5, sectorCount: 1, classification: "skipped_untested" },
  ]);
  const first = (await fixture.run(["archive-evidence", archive.id, "--limit", "1"])).result as { nextCursor: string };
  const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
  cursor[2] = 2;
  const stale = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  expect((await fixture.run(["archive-evidence", archive.id, "--cursor", stale])).result).toMatchObject({
    available: false, unavailableReason: "DVD_EVIDENCE_CURSOR_STALE", revision: { number: 1 }, ranges: null, complete: false,
  });
  writeFileSync(join(directory, "checkpoint.json"), JSON.stringify({ ...pointer, currentManifestRevision: 2 }));
  expect((await fixture.run(["archive-evidence", archive.id, "--cursor", first.nextCursor])).result).toMatchObject({
    available: false, unavailableReason: "DVD_PUBLICATION_CHECKPOINT_CONFLICT", evidence: null, ranges: null,
  });
});

it.each(["digest", "image", "projection"])("fails closed for a conflicting %s", async (conflict) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, directory, manifest } = await seedCommittedArchiveEvidence(fixture);
  const reason = conflict === "digest" ? "DVD_PUBLICATION_MANIFEST_CONFLICT" : conflict === "image" ? "DVD_PUBLICATION_IMAGE_CONFLICT" : "DVD_EVIDENCE_PROJECTION_INVALID";
  if (conflict === "digest") writeFileSync(join(directory, "initial-manifest.json"), JSON.stringify({ ...manifest, acceptedEndLbaExclusive: 1025 }));
  if (conflict === "image") writeFileSync(archive.archivePath, Buffer.alloc(archive.sizeBytes!, 1));
  if (conflict === "projection") withEvidenceGuardsDisabled(fixture.databasePath, db => {
    db.prepare("UPDATE dvd_archive_evidence_headers SET current_manifest_revision = 2 WHERE original_disc_archive_id = ?").run(archive.id);
  });
  expect((await fixture.run(["archive-evidence", archive.id])).result).toMatchObject({
    available: false, unavailableReason: reason, evidence: null, ranges: null, complete: false,
  });
});

it.each([["--limit", "0"], ["--limit", "101"], ["--cursor", "bogus"], ["--offset", "1"]])("validates paging input %j", async (...args) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  const result = await fixture.run(["archive-evidence", archive.id, ...args]);
  expect(result.exitCode).toBe(2);
  expect(result.result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
});
