import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyMappingProposal, type MappingProposalCommand } from "@rip-dvd/application";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach, expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const key = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function fixture() {
  const current = createOperatorWorkflowFixture();
  fixtures.push(current);
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-proposal-disc", isPresent: true,
  });
  const contentId = `sha256:${"c".repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    volumeLabel: "SYNTHETIC_PROPOSAL",
    scanData: { schemaVersion: 2, contentId, titles: [1, 2, 3].map((number) => ({
      number, durationSeconds: 3_600, chapters: 8, audioStreams: [], subtitles: [],
    })) },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id, discKind: "dvd", archiveFormat: "iso",
    archivePath: "/media/originals/synthetic-proposal.iso", fingerprint: contentId,
  });
  access.close();
  return { current, archive };
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.dispose();
});

function processEnvironment(current: ReturnType<typeof createOperatorWorkflowFixture>) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: current.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: current.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: current.originalsLibraryPath,
  };
}

it("applies a movie proposal through inline JSON and replays through stdin and a file", async () => {
  const { current, archive } = fixture();
  const proposal = {
    action: "create_mapping_proposal",
    catalogRevision: archive.updatedAt.toISOString(),
    target: { choice: "create_new", mediaItem: { kind: "movie", title: "Example Film" } },
    discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
    completeReview: true,
  };
  const json = JSON.stringify(proposal);
  const args = ["catalog-review", "apply-proposal", archive.id, "--key", key(1)] as const;
  const created = await current.run([...args, "--json", json]);
  expect(created.exitCode).toBe(0);
  expect(created.stderr).toBe("");
  expect(created.stdout.trim().split("\n")).toHaveLength(1);
  expect(created.result).toMatchObject({
    message: "Cataloged and review completed",
    mediaItem: { kind: "movie", title: "Example Film" },
    discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
  });
  expect((await current.run([...args, "--stdin"], null, json)).result).toEqual(created.result);
  const file = join(current.mediaLibraryPath, "proposal.json");
  writeFileSync(file, json);
  expect((await current.run([...args, "--file", file])).result).toEqual(created.result);
  const access = current.openAccess();
  expect(access.catalog.listMediaItems()).toHaveLength(1);
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(1);
  expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]?.catalogReviewOutcome)
    .toBe("reviewed_with_selections");
  access.close();
  const changed = await current.run([...args, "--json", JSON.stringify({
    ...proposal, target: { choice: "create_new", mediaItem: { kind: "movie", title: "Other Film" } },
  })]);
  expect(changed.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

it("runs every structured input form through the executable without the web service", () => {
  const { current, archive } = fixture();
  const proposal = JSON.stringify({
    action: "create_mapping_proposal",
    catalogRevision: archive.updatedAt.toISOString(),
    target: { choice: "create_new", mediaItem: { kind: "movie", title: "Process Film" } },
    discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
  });
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const base = [entry, "catalog-review", "apply-proposal", archive.id, "--key", key(30)];
  const invoke = (inputArgs: string[], input?: string) => spawnSync(
    process.execPath,
    [...base, ...inputArgs],
    { encoding: "utf8", env: processEnvironment(current), ...(input ? { input } : {}) },
  );
  const inline = invoke(["--json", proposal]);
  const stdin = invoke(["--stdin"], proposal);
  const file = join(current.mediaLibraryPath, "process-proposal.json");
  writeFileSync(file, proposal);
  const fromFile = invoke(["--file", file]);
  for (const result of [inline, stdin, fromFile]) {
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(inline.stdout));
  }
  const access = current.openAccess();
  expect(access.catalog.listMediaItems()).toHaveLength(1);
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(1);
  access.close();
});

it("recovers a committed proposal after a lost response and data-access restart", async () => {
  const { current, archive } = fixture();
  const command = {
    action: "create_mapping_proposal",
    catalogRevision: archive.updatedAt.toISOString(),
    target: { choice: "create_new", mediaItem: { kind: "movie", title: "Recovered Film" } },
    discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
    completeReview: true,
  } satisfies MappingProposalCommand;
  const mutationKey = key(31);
  const access = current.openAccess();
  const committed = applyMappingProposal(access, archive.id, command, mutationKey);
  access.close();

  const replay = await current.run([
    "catalog-review", "apply-proposal", archive.id, "--key", mutationKey,
    "--json", JSON.stringify(command),
  ]);
  expect(replay.exitCode).toBe(0);
  expect(replay.result).toEqual(committed);
  const reader = current.openAccess();
  expect(reader.catalog.listMediaItems()).toHaveLength(1);
  expect(reader.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(1);
  reader.close();
});

it("serializes concurrent same-key proposals from separate processes", async () => {
  const { current, archive } = fixture();
  const proposal = JSON.stringify({
    action: "create_mapping_proposal",
    catalogRevision: archive.updatedAt.toISOString(),
    target: { choice: "create_new", mediaItem: { kind: "movie", title: "Concurrent Film" } },
    discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
  });
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const invoke = () => new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [
        entry, "catalog-review", "apply-proposal", archive.id, "--key", key(32),
        "--json", proposal,
      ], { env: processEnvironment(current) });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    }
  );
  const [first, second] = await Promise.all([invoke(), invoke()]);
  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(second.stderr).toBe("");
  expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
  const access = current.openAccess();
  expect(access.catalog.listMediaItems()).toHaveLength(1);
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(1);
  access.close();
});

it("rejects malformed, stale, and invalid multi-selection proposals without partial writes", async () => {
  const { current, archive } = fixture();
  const proposal = {
    action: "create_episodic_mapping_proposal",
    catalogRevision: archive.updatedAt.toISOString(),
    tvShow: { choice: "create_new", title: "Example Show" },
    season: { choice: "create_new", title: "Season One", seasonNumber: 1 },
    episodes: [
      { titleNumber: 1, title: "First", episodeNumber: 1 },
      { titleNumber: 2, title: "Second", episodeNumber: 2 },
    ],
  };
  const run = (number: number, input: unknown) => current.run([
    "catalog-review", "apply-proposal", archive.id, "--key", key(number),
    "--json", JSON.stringify(input),
  ]);
  expect((await current.run(["catalog-review", "apply-proposal", archive.id,
    "--json", JSON.stringify(proposal)])).result)
    .toMatchObject({ error: { code: "INVALID_MUTATION_KEY" } });
  expect((await current.run(["catalog-review", "apply-proposal", archive.id,
    "--key", key(2), "--json", "{"])).result)
    .toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  expect((await run(2, { ...proposal, episodes: [{ titleNumber: 1, title: "First" }] })).result)
    .toMatchObject({ error: { code: "INVALID_PROPOSAL" } });
  const invalidMembers = [
    {
      action: "create_mapping_proposal",
      catalogRevision: proposal.catalogRevision,
      target: { choice: "use_existing", mediaItemId: "missing-movie" },
      discSelection: { sourceIdentity: { kind: "dvd_title", titleNumber: 1 } },
    },
    { ...proposal, tvShow: { choice: "use_existing", mediaItemId: "missing-show" } },
    { ...proposal, season: { choice: "use_existing", mediaItemId: "missing-season" } },
    { ...proposal, episodes: [{
      titleNumber: 1, title: "First", episodeNumber: 1,
      existingMediaItemId: "missing-episode",
    }] },
  ];
  for (const [index, invalidMember] of invalidMembers.entries()) {
    expect((await run(10 + index, invalidMember)).result)
      .toMatchObject({ error: { code: "PROPOSAL_REJECTED" } });
  }
  expect((await run(2, { ...proposal, episodes: [
    proposal.episodes[0], { titleNumber: 99, title: "Missing", episodeNumber: 2 },
  ] })).result).toMatchObject({ error: { code: "PROPOSAL_REJECTED" } });
  let access = current.openAccess();
  expect(access.catalog.listMediaItems()).toEqual([]);
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toEqual([]);
  access.close();

  const created = await run(2, proposal);
  expect(created.exitCode).toBe(0);
  expect(created.result).toMatchObject({
    episodes: [
      { mediaItem: { title: "First" }, discSelection: { sourceIdentity: { titleNumber: 1 } } },
      { mediaItem: { title: "Second" }, discSelection: { sourceIdentity: { titleNumber: 2 } } },
    ],
  });
  expect((await run(2, proposal)).result).toEqual(created.result);
  expect((await run(3, { ...proposal, episodes: [
    { titleNumber: 3, title: "Third", episodeNumber: 3 },
  ] })).result).toMatchObject({ error: { code: "STALE_CATALOG_REVISION" } });
  access = current.openAccess();
  expect(access.catalog.listMediaItems()).toHaveLength(4);
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(2);
  access.close();
});
