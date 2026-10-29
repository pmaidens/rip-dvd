import { afterEach, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { claimNextEncodeJob, type EncodeOutputKeepPreflight, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import {
  changeFailedCleanupOwnership, changeFailedOwnership, changeFailedValidation, denyFailedFileRead, disconnectKeepStorage, failedFileFaults,
  seedKeepPreflightFixture, unavailableKeepProbe,
  type KeepPreflightFixture,
} from "../../../../../../operator-cli/src/encode-output-keep-preflight.test-support.js";
import { seedEncodeClaim } from "../../../../../../operator-cli/src/encode-claim.test-support.js";
import { retainSyntheticFailedOutput } from "../../../../../../operator-cli/src/encode-output-failed.test-support.js";
import { publishSyntheticClaim } from "../../../../../../operator-cli/src/encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputKeepPreflightRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const origin = "http://localhost:3000";

function request(identity: string, token?: string) {
  return new Request(`${origin}/api/encode-outputs/${identity}/keep-preflight${token === undefined ? "" : `?preview-token=${encodeURIComponent(token)}`}`);
}

async function parity(seeded: KeepPreflightFixture, token?: string, probe: EncodeOutputMediaProbe = unavailableKeepProbe) {
  const response = await createEncodeOutputKeepPreflightRoute(request(seeded.identity, token), seeded.identity, () => seeded.access, probe);
  const cli = await seeded.preview(token, probe);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(cli.exitCode).toBe(0);
  const result = await response.json() as EncodeOutputKeepPreflight;
  expect(cli.result).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(seeded.fixture.mediaLibraryPath);
  expect(JSON.stringify(result)).not.toContain(seeded.fixture.originalsLibraryPath);
  return result;
}

it("shares a read-only complete-file Keep preview, exact evidence and replayed review with the CLI", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const jobBefore = seeded.access.encodeJobs.find(seeded.job.id);
    const recordBefore = seeded.access.encodeJobs.findValidationFailedOutput(seeded.output.id);
    const result = await parity(seeded);
    expect(result).toMatchObject({ eligible: true, blockers: [], artifact: { state: "validation_failed", validation: {
      result: "failed", recordIdentity: seeded.output.id, failure: { evidence: { kind: "duration", observedSeconds: 10 } },
    }, inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED" }, provenance: { sourceSnapshot: { id: seeded.claim.claimToken } } },
    current: { artifactIdentity: seeded.identity, validationIdentity: seeded.output.id, fileIdentity: seeded.output.filesystemIdentity },
    completeWrite: { status: "verified", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    normalDestination: { status: "absent", normalOutput: null }, requiredAcknowledgement: { acknowledged: true } });
    expect(await parity(seeded, result.previewToken!)).toMatchObject({ eligible: true, review: { status: "current" }, previewToken: result.previewToken });
    expect(seeded.access.encodeJobs.find(seeded.job.id)).toEqual(jobBefore);
    expect(seeded.access.encodeJobs.findValidationFailedOutput(seeded.output.id)).toEqual(recordBefore);
    expect(seeded.access.encodeOutputInspectionReceipts.list(seeded.job.id, { limit: 1, offset: 0 }).receipts).toEqual([]);
  } finally { seeded.access.close(); }
});

it("shares stale inspectability evidence while a fresh failed-probe preview remains eligible", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await parity(seeded, undefined, async () => ({ durationSeconds: 10, streams: [] }));
    const stale = await parity(seeded, reviewed.previewToken!);
    expect(stale).toMatchObject({ eligible: false, previewToken: null, artifact: { inspectability: { status: "unknown" } }, review: { status: "stale" } });
    expect(stale.blockers.map(({ code }) => code)).toEqual(["KEEP_PREFLIGHT_STALE"]);
    expect((await parity(seeded)).eligible).toBe(true);
  } finally { seeded.access.close(); }
});

for (const fault of failedFileFaults) {
  it(`shares blockers and stale identities for ${fault.name}`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
    try {
      const reviewed = await parity(seeded);
      fault.change(seeded);
      const changed = await parity(seeded, reviewed.previewToken!);
      expect(changed).toMatchObject({ eligible: false, previewToken: null, review: { status: "stale" },
        current: { artifactIdentity: seeded.identity, validationIdentity: seeded.output.id } });
      expect(changed.blockers.map(({ code }) => code)).toContain(fault.code);
      expect(changed.blockers.map(({ code }) => code)).toContain("KEEP_PREFLIGHT_STALE");
    } finally { seeded.access.close(); }
  });
}

for (const [name, change, expected] of [
  ["validation", changeFailedValidation, "KEEP_PREFLIGHT_STALE"],
  ["publication ownership", changeFailedOwnership, "OUTPUT_OWNERSHIP_LOST"],
  ["cleanup ownership", changeFailedCleanupOwnership, "OUTPUT_OWNERSHIP_LOST"],
  ["destination", (seeded: KeepPreflightFixture) => writeFileSync(seeded.job.outputPath, "synthetic destination appeared after review"), "KEEP_PREFLIGHT_STALE"],
  ["storage directory", disconnectKeepStorage, "DESTINATION_EVIDENCE_UNAVAILABLE"],
] as const) {
  it(`shares changed ${name} evidence with the CLI`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
    try {
      const reviewed = await parity(seeded);
      change(seeded);
      const changed = await parity(seeded, reviewed.previewToken!);
      expect(changed).toMatchObject({ eligible: false, previewToken: null, review: { status: "stale" } });
      expect(changed.blockers.map(({ code }) => code)).toContain(expected);
      if (name !== "storage directory") expect(changed.current.fileIdentity).toBe(reviewed.current.fileIdentity);
    } finally { seeded.access.close(); }
  });
}

it.skipIf(process.getuid?.() === 0)("shares an actual file permission storage fault without exposing its path", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const reviewed = await parity(seeded);
    denyFailedFileRead(seeded);
    const changed = await parity(seeded, reviewed.previewToken!);
    expect(changed).toMatchObject({ eligible: false, previewToken: null });
    expect(changed.blockers.map(({ code }) => code)).toContain("OUTPUT_FILE_UNAVAILABLE");
  } finally { chmodSync(seeded.output.outputPath, 0o600); seeded.access.close(); }
});

it("shares normal destination identity and leaves both files and the failed job untouched", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { clean: true });
  try {
    const first = (await claimNextEncodeJob(seeded.access, "synthetic-http-normal-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(seeded.access, first);
    seeded.access.encodeJobs.requeue(seeded.job.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const failed = (await claimNextEncodeJob(seeded.access, "synthetic-http-failed-worker", fixture.originalsLibraryPath))!;
    const output = retainSyntheticFailedOutput(seeded.access, failed, fixture.mediaLibraryPath);
    const identity = `encode-output-v1.failed.${output.id}`;
    const normalBefore = readFileSync(seeded.job.outputPath);
    const failedBefore = readFileSync(output.outputPath);
    const web = await createEncodeOutputKeepPreflightRoute(request(identity), identity, () => seeded.access, unavailableKeepProbe);
    const cli = await fixture.run(["encode-output", "keep-preflight", identity], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(web.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(await web.json()).toEqual(cli.result);
    expect(cli.result).toMatchObject({ eligible: true, normalDestination: { status: "present", normalOutput: {
      encodeJobId: seeded.job.id, validationResult: "passed",
    } }, artifact: { encodeJob: { status: "failed" } } });
    expect(readFileSync(seeded.job.outputPath)).toEqual(normalBefore);
    expect(readFileSync(output.outputPath)).toEqual(failedBefore);
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
  } finally { seeded.access.close(); }
});

it("matches JSON CLI errors for malformed tokens and missing artifacts", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  try {
    const invalid = await createEncodeOutputKeepPreflightRoute(request(seeded.identity, "synthetic-invalid-token"), seeded.identity, () => seeded.access);
    const cli = await seeded.fixture.run(["encode-output", "keep-preflight", seeded.identity, "--json", JSON.stringify({ previewToken: "synthetic-invalid-token" })]);
    expect(invalid.status).toBe(400);
    expect(cli.exitCode).not.toBe(0);
    expect(await invalid.json()).toEqual(cli.result);
    const missingIdentity = "encode-output-v1.failed.00000000-0000-4000-8000-000000000000";
    const missing = await createEncodeOutputKeepPreflightRoute(request(missingIdentity), missingIdentity, () => seeded.access);
    const missingCli = await seeded.fixture.run(["encode-output", "keep-preflight", missingIdentity]);
    expect(missing.status).toBe(404);
    expect(missingCli.exitCode).not.toBe(0);
    expect(await missing.json()).toEqual(missingCli.result);
  } finally { seeded.access.close(); }
});

it("rejects unknown or duplicate HTTP options and mutation methods before opening persistence", async () => {
  for (const request of [
    new Request(`${origin}/api/encode-outputs/synthetic/keep-preflight?unknown=true`),
    new Request(`${origin}/api/encode-outputs/synthetic/keep-preflight?preview-token=one&preview-token=two`),
    new Request(`${origin}/api/encode-outputs/synthetic/keep-preflight`, { method: "POST" }),
  ]) {
    const response = await createEncodeOutputKeepPreflightRoute(request, "synthetic", () => { throw new Error("Persistence must remain unopened"); });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  }
});
