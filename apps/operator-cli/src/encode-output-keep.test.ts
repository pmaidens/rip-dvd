import { afterEach, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeFailedCleanupOwnership, changeFailedOwnership, changeFailedValidation, changePredecessorValidation,
  disconnectKeepStorage, failedFileFaults, seedCorrectedKeepPreflightFixture, seedKeepPreflightFixture, unavailableKeepProbe } from "./encode-output-keep-preflight.test-support.js";

const fixtures: Awaited<ReturnType<typeof seedKeepPreflightFixture>>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ access, fixture }) => { access.close(); fixture.dispose(); }));

it("inspects, reviews, Keeps, replays and exports the same complete failed output without acknowledging inspection", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { fixture, access, identity, job, output } = seeded;
  const run = (args: string[]) => fixture.run(["encode-output", ...args], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  const inspected = await run(["inspect", identity]);
  expect(inspected.exitCode).toBe(0);
  const before = access.encodeJobs.find(job.id);
  const bytes = readFileSync(output.outputPath);
  const { result: preview } = await seeded.preview();
  const body = { validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken, acknowledged: true };
  const args = ["keep", identity, "--key", "synthetic-keep-decision", "--json", JSON.stringify(body)];
  const kept = await run(args);
  expect(kept.exitCode).toBe(0);
  expect(kept.result).toMatchObject({ schemaVersion: 1, kept: { artifactIdentity: identity,
    validationIdentity: output.id, previewToken: preview.previewToken, keptAt: expect.any(String) } });
  expect(await run(args)).toEqual(kept);
  const stale = await run(["keep", identity, "--key", "synthetic-stale-reviewed-keep", "--json",
    JSON.stringify({ ...body, validationIdentity: "00000000-0000-4000-8000-000000000000" })]);
  expect(stale.exitCode).not.toBe(0);
  expect(stale.result).toMatchObject({ error: { code: "OUTPUT_VALIDATION_CHANGED", current: {
    current: { artifactIdentity: identity, validationIdentity: output.id },
  } } });
  expect(access.encodeJobs.find(job.id)).toEqual(before);
  expect(readFileSync(output.outputPath)).toEqual(bytes);
  expect((await run(["inspect", identity])).result).toMatchObject({ kept: (kept.result as { kept: unknown }).kept,
    artifact: { state: "validation_failed", encodeJob: { status: "failed" } }, operatorInspection: { status: "not_acknowledged", receipts: [] } });
  const destination = join(fixture.operatorHostPath, "synthetic-kept.mkv");
  expect((await run(["export", identity, "--destination", destination])).exitCode).toBe(0);
  expect(readFileSync(destination)).toEqual(bytes);
});

function reviewedInput(preview: import("@rip-dvd/application").EncodeOutputKeepPreflight) {
  return { validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken, acknowledged: true };
}

it("requires exact reviewed input and conflicts when a successful key is reused with different input", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  const body = reviewedInput(preview);
  const run = (input: unknown, key = "synthetic-required-keep") => seeded.fixture.run(["encode-output", "keep", seeded.identity,
    "--key", key, "--json", JSON.stringify(input)], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  for (const field of ["validationIdentity", "previewToken", "acknowledged"]) {
    const incomplete = { ...body }; delete incomplete[field as keyof typeof incomplete];
    expect((await run(incomplete)).result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  }
  expect((await run({ ...body, acknowledged: false })).exitCode).not.toBe(0);
  expect((await run({ ...body, extra: true })).exitCode).not.toBe(0);
  const wrongValidation = await run({ ...body, validationIdentity: "00000000-0000-4000-8000-000000000000" });
  expect(wrongValidation.result).toMatchObject({ error: { code: "OUTPUT_VALIDATION_CHANGED", current: {
    eligible: false, current: { artifactIdentity: seeded.identity, validationIdentity: seeded.output.id },
    blockers: [{ code: "OUTPUT_VALIDATION_CHANGED" }],
  } } });
  expect((await run(body)).exitCode).toBe(0);
  expect((await run({ ...body, previewToken: `encode-output-keep-preview-v1.${"a".repeat(64)}` })).result)
    .toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

for (const fault of [
  ...failedFileFaults,
  { name: "validation evidence", code: "KEEP_PREFLIGHT_STALE", change: changeFailedValidation },
  { name: "publication ownership", code: "OUTPUT_OWNERSHIP_LOST", change: changeFailedOwnership },
  { name: "cleanup ownership", code: "OUTPUT_OWNERSHIP_LOST", change: changeFailedCleanupOwnership },
  { name: "disconnected storage", code: "DESTINATION_EVIDENCE_UNAVAILABLE", change: disconnectKeepStorage },
]) {
  it(`rejects reviewed Keep after changed ${fault.name} without partial state`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const { result: preview } = await seeded.preview();
    fault.change(seeded);
    const before = seeded.access.encodeJobs.find(seeded.job.id);
    const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-stale-keep",
      "--json", JSON.stringify(reviewedInput(preview))], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toMatchObject({ error: { current: { eligible: false, current: { artifactIdentity: seeded.identity },
      blockers: expect.arrayContaining([{ code: fault.code, message: expect.any(String) }]) } } });
    expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
    expect(seeded.access.encodeJobs.find(seeded.job.id)).toEqual(before);
  });
}

it("replays a committed Keep even after its bytes change, while rejecting a fresh key", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  const args = ["encode-output", "keep", seeded.identity, "--key", "synthetic-replayed-keep", "--json", JSON.stringify(reviewedInput(preview))];
  const run = (input = args) => seeded.fixture.run(input, undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  const kept = await run(); expect(kept.exitCode).toBe(0);
  failedFileFaults[1].change(seeded);
  expect(await run()).toEqual(kept);
  const fresh = [...args]; fresh[4] = "synthetic-fresh-stale-keep";
  expect((await run(fresh)).exitCode).not.toBe(0);
});

it("keeps a failed corrected replacement without changing its predecessor's normal file or generation", async () => {
  const seeded = await seedCorrectedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  const normal = readFileSync(seeded.predecessor.outputPath);
  const predecessor = seeded.access.encodeJobs.find(seeded.predecessor.id);
  const args = ["encode-output", "keep", seeded.identity, "--key", "synthetic-corrected-keep", "--json", JSON.stringify(reviewedInput(preview))];
  const kept = await seeded.fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
  expect(kept.exitCode).toBe(0);
  expect(seeded.access.encodeJobs.find(seeded.predecessor.id)).toEqual(predecessor);
  expect(readFileSync(seeded.predecessor.outputPath)).toEqual(normal);
  expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
  changePredecessorValidation(seeded);
  args[4] = "synthetic-stale-predecessor-keep";
  expect((await seeded.fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe })).exitCode).not.toBe(0);
});

for (const [name, change] of [
  ["bytes with restored modification time", failedFileFaults[1].change],
  ["cleanup ownership", changeFailedCleanupOwnership],
  ["validation", changeFailedValidation],
] as const) {
  it(`rechecks ${name} at the mutation boundary after a valid preview`, async () => {
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const { result: preview } = await seeded.preview();
    const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-raced-keep",
      "--json", JSON.stringify(reviewedInput(preview))], undefined, undefined, {
      encodeOutputMediaProbe: unavailableKeepProbe,
      openAccess() {
        const access = seeded.fixture.openAccess();
        const record = access.encodeOutputKeeps.record;
        access.encodeOutputKeeps.record = (input, prepared, guard) => { change(seeded); return record(input, prepared, guard); };
        return access;
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
    expect(result.result).toMatchObject({ error: { current: { eligible: false, current: { artifactIdentity: seeded.identity } } } });
  });
}

it("accepts reviewed JSON, file and stdin input and replays independent of object key order", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  const body = JSON.stringify(reviewedInput(preview));
  const path = join(seeded.fixture.operatorHostPath, "synthetic-keep-review.json"); writeFileSync(path, body);
  let expected: unknown;
  for (const [options, stdin] of [
    [["--file", path], undefined], [["--stdin"], body],
    [["--json", JSON.stringify({ acknowledged: true, previewToken: preview.previewToken, validationIdentity: preview.current.validationIdentity })], undefined],
  ] as const) {
    const kept = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-canonical-keep", ...options],
      undefined, stdin, { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(kept.exitCode).toBe(0);
    if (expected === undefined) expected = kept.result;
    expect(kept.result).toEqual(expected);
  }
  for (const args of [[], ["--json", body], ["--key", "synthetic-invalid-keep"],
    ["--key", "synthetic-invalid-keep", "--json", body, "--stdin"],
    ["--key", "synthetic-invalid-keep", "--json", JSON.stringify({ ...reviewedInput(preview), mutationKey: "synthetic-body-key" })]]) {
    expect((await seeded.fixture.run(["encode-output", "keep", seeded.identity, ...args])).exitCode).not.toBe(0);
  }
});

it("rejects an actual unreadable complete file without recording Keep", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const { result: preview } = await seeded.preview();
  chmodSync(seeded.output.outputPath, 0);
  try {
    const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-unreadable-keep",
      "--json", JSON.stringify(reviewedInput(preview))], undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toMatchObject({ error: { current: { blockers: expect.arrayContaining([
      { code: "OUTPUT_FILE_UNAVAILABLE", message: expect.any(String) },
    ]) } } });
    expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
  } finally { chmodSync(seeded.output.outputPath, 0o600); }
});
