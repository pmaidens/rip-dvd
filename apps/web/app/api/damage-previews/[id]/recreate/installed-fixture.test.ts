import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "@rip-dvd/config";
import { createDataAccess } from "@rip-dvd/data-access";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { runCommand } from "../../../../../../operator-cli/src/command.js";
import type { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDamagePreview, seedRetainedDamagePreview } from "../../../../../../operator-cli/src/damage-preview.test-support.js";

// Only the installed smoke's owned volume set may opt into this fixture writer.
it.skipIf(process.env.RIP_DVD_RECREATION_INSTALLED_FIXTURE !== "1")("prepares an explicitly authorized synthetic installed recreation fixture", async () => {
  const config = loadConfig();
  const markerPath = join(dirname(config.databasePath), ".synthetic-recreation-authority.json");
  expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({ purpose: "rip-dvd-synthetic-recreation", databasePath: config.databasePath, mediaLibraryPath: config.mediaLibraryPath, originalsLibraryPath: config.originalsLibraryPath });
  for (const path of [dirname(config.databasePath), config.mediaLibraryPath, config.originalsLibraryPath]) expect(realpathSync(path)).toBe(path);
  const openAccess = () => createDataAccess(config);
  const operatorHostPath = join(dirname(config.databasePath), "synthetic-recreation-caller"); mkdirSync(operatorHostPath, { recursive: true });
  const fixture: ReturnType<typeof createOperatorWorkflowFixture> = {
    databasePath: config.databasePath, mediaLibraryPath: config.mediaLibraryPath, originalsLibraryPath: config.originalsLibraryPath, operatorHostPath, openAccess,
    async run(args) {
      const stdout: string[] = [], stderr: string[] = [];
      const exitCode = await runCommand(args, { openAccess, mediaLibraryPath: () => config.mediaLibraryPath, originalsLibraryPath: () => config.originalsLibraryPath, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
      return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), result: JSON.parse(stdout.join("")) as unknown };
    },
    dispose() { /* The installed smoke owns the synthetic volumes and their lifecycle. */ },
  };
  const previousEnvironment = process.env.NODE_ENV;
  try {
    vi.stubEnv("NODE_ENV", "production");
    // Use the installed namespace from the first publication. One Originals
    // Library cannot be rebound to a second ownership authority.
    const ownership = createArchiveImageOwnership({ authorityRootPath: dirname(config.databasePath) });
    const seeded = await seedRetainedDamagePreview(fixture, await seedDamagePreview(fixture, undefined, undefined, { ownership }));
    const review = await fixture.run(["damage-preview", "recreate", seeded.id]);
    expect(review.exitCode).toBe(0);
    expect(review.result).toMatchObject({ exact: { available: true }, differences: [] });
    const original = await seeded.inspect();
    expect(original.generationStatus).toBe("complete"); expect(original.media.state).toBe("retained");
    writeFileSync(join(dirname(config.databasePath), "synthetic-recreation-fixture.json"), JSON.stringify({ id: seeded.id, mediaPath: seeded.path, selection: seeded.seeded.input, original }), { flag: "wx", mode: 0o600 });
  } finally { vi.stubEnv("NODE_ENV", previousEnvironment); }
});
