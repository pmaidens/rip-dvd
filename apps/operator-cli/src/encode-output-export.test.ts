import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { seedKeepPreflightFixture } from "./encode-output-keep-preflight.test-support.js";

const fixtures: Awaited<ReturnType<typeof seedKeepPreflightFixture>>[] = [];
afterEach(() => { vi.unstubAllEnvs(); fixtures.splice(0).forEach(({ access, fixture }) => { access.close(); fixture.dispose(); }); });

it("exports canonical bytes to the service destination while reporting the wrapper's executing-caller destination", async () => {
  const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
  const source = readFileSync(seeded.output.outputPath);
  const serviceDestination = join(seeded.fixture.operatorHostPath, "service-export.mkv");
  const callerDestination = join(seeded.fixture.operatorHostPath, "unmounted-caller", "canonical output.mkv");
  vi.stubEnv("RIP_DVD_EXPORT_CALLER_PATH", callerDestination);
  const result = await seeded.fixture.run(["encode-output", "export", seeded.identity, "--destination", serviceDestination]);
  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({ artifact: { identity: seeded.identity, type: "canonical_encode_output", state: "validation_failed" },
    destination: callerDestination, byteSize: source.length, sourceIdentity: seeded.output.filesystemIdentity,
    provenance: { encodeJobId: seeded.job.id } });
  expect(readFileSync(serviceDestination)).toEqual(source);
  expect(createHash("sha256").update(readFileSync(serviceDestination)).digest("hex"))
    .toBe("7c4abd426916f2a3b8530ac82d54edd880ae32d764a2fe17d8e408a50355a250");
  expect(statSync(serviceDestination).mode & 0o777).toBe(0o600);
  expect(existsSync(callerDestination)).toBe(false);
  expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("failed");
});
