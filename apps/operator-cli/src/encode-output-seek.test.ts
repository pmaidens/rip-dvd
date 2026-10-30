import { writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createApplicationOperations, type EncodeOutputIntervalInspection } from "@rip-dvd/application";
import { seedOutputSeek, seekOptions } from "./encode-output-seek.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it.each(["verified", "absent", "unknown"] as const)("reports %s correspondence and only a proved rendition seek through public JSON CLI after reopening persistence", async (state) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedOutputSeek(fixture, state);
  seeded.access.close();
  const run = () => fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)], undefined, undefined, seekOptions);
  const first = await run(), second = await run();
  expect(first.exitCode).toBe(0); expect(second.result).toEqual(first.result);
  const result = first.result as EncodeOutputIntervalInspection;
  expect(result.intervals[0]!.status).toBe(state);
  expect(result.viewing?.targets).toEqual(state === "verified" ? [{ intervalIndex: 0,
    canonicalOutputInterval: { startMilliseconds: 40, endMilliseconds: 160 },
    renditionInterval: { startMilliseconds: 2040, endMilliseconds: 2160 }, seekSeconds: 2.04 }] : []);
  expect(result.intervals[0]!.sourceInterval?.startMilliseconds).toBe(1000);
  const ordinary = await fixture.run(["encode-output", "inspect", seeded.artifactIdentity], undefined, undefined, seekOptions);
  expect(result.inspection).toEqual(ordinary.result);
});

it.each(["historical", "clock_unknown", "changed_media", "changed_source", "wrong_source_hash", "unmapped_bounds", "disabled"] as const)("withholds targeted viewing for %s without changing canonical mapping or ordinary inspection", async (fault) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedOutputSeek(fixture);
  try {
    const record = seeded.access.browserRenditions.find(seeded.renditionId)!;
    if (fault === "historical") delete record.timeline;
    if (fault === "clock_unknown") record.timeline = { policyVersion: "browser-rendition-exact-video-v1", status: "unknown", reasonCode: "RENDITION_TIMELINE_UNVERIFIED" };
    if (fault === "changed_media") writeFileSync(record.media!.path, "changed synthetic rendition bytes");
    if (fault === "changed_source") record.sourceAuthorityRevision = "synthetic earlier authority";
    if (record.timeline?.status === "verified") {
      if (fault === "wrong_source_hash") record.timeline.canonicalBytesSha256 = "0".repeat(64);
      if (fault === "unmapped_bounds") record.timeline.frames = [];
    }
    seeded.access.browserRenditions.update(record);
    const options = { ...seekOptions, browserRenditionsEnabled: fault !== "disabled" };
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)], undefined, undefined, options);
    expect(result).toMatchObject({ exitCode: 0, result: { intervals: [{ status: "verified" }], viewing: { targets: [], reasonCode: expect.any(String) } } });
    const inspection = (result.result as EncodeOutputIntervalInspection).inspection;
    expect(await createApplicationOperations(seeded.access, seekOptions).inspectEncodeOutput(seeded.artifactIdentity)).toEqual(inspection);
    expect(inspection.operatorInspection.status).toBe("not_acknowledged");
  } finally { seeded.access.close(); }
});

it("retains the entire measured frame count when an earlier overlapping frame owns the canonical envelope end", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedOutputSeek(fixture);
  try {
    const record = seeded.access.browserRenditions.find(seeded.renditionId)!;
    if (record.timeline?.status !== "verified") throw new Error("Missing synthetic measured clock");
    record.timeline.frames[1]!.canonical.endMilliseconds = 160;
    record.timeline.frames[3]!.canonical.endMilliseconds = 150;
    record.timeline.frames[3]!.rendition.endMilliseconds = 3000;
    seeded.access.browserRenditions.update(record);
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)], undefined, undefined, seekOptions);
    expect(result).toMatchObject({ exitCode: 0, result: { viewing: { targets: [{
      renditionInterval: { startMilliseconds: 2040, endMilliseconds: 3000 }, seekSeconds: 2.04,
    }] } } });
  } finally { seeded.access.close(); }
});
