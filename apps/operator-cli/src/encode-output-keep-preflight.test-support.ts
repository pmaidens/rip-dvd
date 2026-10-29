import { chmodSync, lstatSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { claimNextEncodeJob, type EncodeOutputKeepPreflight, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import { withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { retainSyntheticFailedOutput } from "./encode-output-failed.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export const unavailableKeepProbe: EncodeOutputMediaProbe = async () => { throw new Error("Synthetic unavailable media probe"); };

export async function seedKeepPreflightFixture() {
  const fixture = createOperatorWorkflowFixture();
  const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
  const claim = (await claimNextEncodeJob(seeded.access, "synthetic-keep-preflight-worker", fixture.originalsLibraryPath))!;
  const output = retainSyntheticFailedOutput(seeded.access, claim, fixture.mediaLibraryPath);
  const identity = `encode-output-v1.failed.${output.id}`;
  return { fixture, ...seeded, claim, output, identity,
    async preview(previewToken?: string, probe: EncodeOutputMediaProbe = unavailableKeepProbe) {
      const result = await fixture.run(["encode-output", "keep-preflight", identity,
        ...(previewToken === undefined ? [] : ["--json", JSON.stringify({ previewToken })])],
      undefined, undefined, { encodeOutputMediaProbe: probe });
      return { ...result, result: result.result as EncodeOutputKeepPreflight };
    },
  };
}

export type KeepPreflightFixture = Awaited<ReturnType<typeof seedKeepPreflightFixture>>;

export function changeFailedValidation(seeded: KeepPreflightFixture) {
  withEvidenceGuardsDisabled(seeded.fixture.databasePath, (database) => {
    const failure = { ...seeded.output.failure, evidence: { kind: "duration", expectedSeconds: 500, observedSeconds: 11 } };
    database.prepare("UPDATE validation_failed_encode_outputs SET failure = ?, validated_at = validated_at + 1 WHERE id = ?")
      .run(JSON.stringify(failure), seeded.output.id);
  });
}

export function changeFailedOwnership(seeded: KeepPreflightFixture) {
  withEvidenceGuardsDisabled(seeded.fixture.databasePath, (database) => {
    database.prepare("UPDATE encode_jobs SET output_path = ?, reserves_output_path = 1 WHERE id = ?")
      .run(seeded.output.outputPath, seeded.job.id);
  });
}

export function changeFailedCleanupOwnership(seeded: KeepPreflightFixture) {
  withEvidenceGuardsDisabled(seeded.fixture.databasePath, (database) => {
    database.prepare("UPDATE encode_jobs SET partial_cleanup_output_path = ?, partial_cleanup_claim_token = ? WHERE id = ?")
      .run(seeded.output.outputPath, seeded.claim.claimToken, seeded.job.id);
  });
}

export const failedFileFaults = [
  { name: "changed inode", code: "OUTPUT_IDENTITY_CHANGED", change(seeded: KeepPreflightFixture) {
    const path = `${seeded.output.outputPath}.replacement`;
    writeFileSync(path, "synthetic complete failed encode"); renameSync(path, seeded.output.outputPath);
  } },
  { name: "same-size rewrite with restored modification time", code: "OUTPUT_IDENTITY_CHANGED", change(seeded: KeepPreflightFixture) {
    const before = lstatSync(seeded.output.outputPath);
    writeFileSync(seeded.output.outputPath, "SYNTHETIC COMPLETE FAILED ENCODE");
    utimesSync(seeded.output.outputPath, before.atime, before.mtime);
  } },
  { name: "empty incomplete write", code: "OUTPUT_INCOMPLETE", change(seeded: KeepPreflightFixture) {
    writeFileSync(seeded.output.outputPath, "");
  } },
  { name: "missing file", code: "OUTPUT_MISSING", change(seeded: KeepPreflightFixture) {
    rmSync(seeded.output.outputPath);
  } },
  { name: "symlink replacement", code: "OUTPUT_FILE_UNAVAILABLE", change(seeded: KeepPreflightFixture) {
    const path = `${seeded.output.outputPath}.original`;
    renameSync(seeded.output.outputPath, path); symlinkSync(path, seeded.output.outputPath);
  } },
] as const;

export function denyFailedFileRead(seeded: KeepPreflightFixture) {
  chmodSync(seeded.output.outputPath, 0);
}

export function disconnectKeepStorage(seeded: KeepPreflightFixture) {
  renameSync(seeded.fixture.mediaLibraryPath, `${seeded.fixture.mediaLibraryPath}.offline`);
}
