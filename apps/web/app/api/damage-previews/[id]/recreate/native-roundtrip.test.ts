import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupDamagePreviewMedia, type DamagePreviewAvailability, type DamagePreviewInspection, type DamagePreviewRecreationReview } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedCommittedArchiveEvidence } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import { seedDamagePreview } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { authorSyntheticPreviewDvd } from "../../../../../../encode-worker/src/synthetic-preview-dvd.test-support.js";
import { createDamagePreviewGenerator } from "../../../../../../encode-worker/src/damage-preview-generator.js";
import { pollDamagePreviews } from "../../../../../../encode-worker/src/damage-preview-worker.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

// Explicit native-lane opt-in fails on missing prerequisites rather than counting a skip as evidence.
it.skipIf(process.env.RIP_DVD_RECREATION_NATIVE_TEST !== "1")("generates a real DVD preview, removes its media and exactly recreates it as a linked second generation", async () => {
  expect(process.platform).toBe("linux");
  for (const command of ["ffmpeg", "ffprobe", "dvdauthor", "genisoimage", "spumux", "rip-dvd-handbrake", "rip-dvd-preview-title"]) execFileSync("which", [command], { stdio: "pipe" });
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const root = join(dirname(fixture.databasePath), "native-dvd"); mkdirSync(root);
  const source = authorSyntheticPreviewDvd(root, root);
  const evidence = await seedCommittedArchiveEvidence(fixture, [], false, true, readFileSync(source));
  const seeded = await seedDamagePreview(fixture, "source_span", [[1_000, 2_000]], { evidence, singleChapter: true });
  const selection = { ...seeded.input, mode: "ordinary_playback", intervalIndexes: [], assessmentIdentity: null, playbackRange: { startMilliseconds: 1_000, endMilliseconds: 3_000 } };
  const access = fixture.openAccess();
  const generator = createDamagePreviewGenerator();
  const inspect = async (id: string) => (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
  const sourceDigest = () => createHash("sha256").update(readFileSync(seeded.archive.archivePath)).digest("hex");
  const originalDigest = sourceDigest();
  const generate = () => pollDamagePreviews({ access, generator, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, ownership: createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }), signal: new AbortController().signal });
  try {
    const reviewed = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(selection)])).result as DamagePreviewAvailability;
    expect(reviewed.available).toBe(true);
    const admitted = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-native-original", "--json", JSON.stringify({ selection, preflightToken: reviewed.preflightToken })]);
    expect(admitted.exitCode).toBe(0);
    const originalId = (admitted.result as DamagePreviewInspection).id;
    await generate();
    const original = await inspect(originalId);
    expect(original.generationStatus).toBe("complete"); expect(original.artifacts).toHaveLength(1);
    const originalPath = access.damagePreviews.find(originalId)!.artifacts[0]!.path;
    expect(existsSync(originalPath)).toBe(true);
    const deletionArgs = ["damage-preview", "delete", originalId, "--key", "synthetic-native-delete", "--json", JSON.stringify({ mediaToken: original.media.token })];
    const pending = await fixture.run(deletionArgs);
    expect(pending).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
    expect(existsSync(originalPath)).toBe(true);
    cleanupDamagePreviewMedia(access);
    expect(existsSync(originalPath)).toBe(false);
    const removed = await inspect(originalId);
    expect(removed.media.state).toBe("removed"); expect(removed.provenance).toEqual(original.provenance);
    expect(await fixture.run(deletionArgs)).toEqual(pending);
    expect(await fixture.run(["damage-preview", "export", original.artifacts[0]!.identity, "--destination", join(fixture.operatorHostPath, "removed.mkv")])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_DELETED" } } });
    const recreation = (await fixture.run(["damage-preview", "recreate", originalId])).result as DamagePreviewRecreationReview;
    expect(recreation.exact.available).toBe(true); expect(recreation.differences).toEqual([]);
    const requestArgs = ["damage-preview", "recreate", originalId, "--key", "synthetic-native-recreate", "--json", JSON.stringify({ mode: "exact", recreationToken: recreation.recreationToken, preflightToken: recreation.preflight.preflightToken })];
    const requested = await fixture.run(requestArgs); expect(requested.exitCode).toBe(0);
    const recreatedId = (requested.result as DamagePreviewInspection).id; expect(recreatedId).not.toBe(originalId);
    await generate();
    const recreated = await inspect(recreatedId);
    expect(recreated).toMatchObject({ generationStatus: "complete", recreation: { sourceRequestId: originalId, mode: "exact", generationComparison: "recorded", generationDifferences: [] } });
    expect(recreated.provenance.toolVersions.handbrake).toMatch(/1\.9\.2/);
    expect(recreated.provenance.commands).toHaveLength(1); expect(recreated.artifacts).toHaveLength(1);
    const destination = join(fixture.operatorHostPath, "recreated.mkv");
    expect(await fixture.run(["damage-preview", "export", recreated.artifacts[0]!.identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
    const decoded = await generator.inspect(destination);
    expect(decoded).toMatchObject({ videoCount: 1, audioCount: 1, subtitleCount: 0 });
    expect(decoded.durationMilliseconds).toBeGreaterThanOrEqual(1_900); expect(decoded.durationMilliseconds).toBeLessThanOrEqual(2_100);
    execFileSync("ffmpeg", ["-v", "error", "-i", destination, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { stdio: "pipe" });
    expect(await inspect(originalId)).toEqual(removed); expect(await fixture.run(requestArgs)).toEqual(requested);
    expect(sourceDigest()).toBe(originalDigest);
    // Both exports are independently generated samples. Byte equality and watchability are not asserted.
  } finally { access.close(); }
}, 120_000);
