import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createDataAccess } from "@rip-dvd/data-access";
import { runCommand } from "./command.js";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { seedKeepPreflightFixture, unavailableKeepProbe } from "./encode-output-keep-preflight.test-support.js";

const fixtures: Awaited<ReturnType<typeof seedKeepPreflightFixture>>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ access, fixture }) => { access.close(); fixture.dispose(); }));

const proofMode = process.env.RIP_DVD_KEEP_PROOF_MODE;
const manifestPath = process.env.RIP_DVD_KEEP_PROOF_MANIFEST;
const workerBindingPath = fileURLToPath(new URL("../../encode-worker/dist/rip-dvd-atomic-exchange.node", import.meta.url));
const workerLockProbe = "const {createRequire}=await import('node:module');const binding=createRequire(import.meta.url)(process.argv[1]);const h=binding.tryAcquireLock(process.argv[2]);if(h===null)process.exit(75);binding.releaseLock(h);";

interface ReadOnlyProofFixture {
  databasePath: string; mediaLibraryPath: string; originalsLibraryPath: string;
  identity: string; outputPath: string; validationIdentity: string; previewToken: string;
}

if (proofMode === "seed") {
  it("prepares the synthetic first-failure fixture for a real read-only media mount", async () => {
    expect(process.platform).toBe("linux"); expect(process.getuid?.()).not.toBe(0);
    if (!manifestPath) throw new Error("The private proof manifest path is required.");
    const seeded = await seedKeepPreflightFixture();
    try {
      const preview = (await seeded.preview()).result;
      expect(preview.eligible).toBe(true);
      expect(existsSync(seeded.job.outputPath)).toBe(false);
      expect(readdirSync(dirname(seeded.job.outputPath)).some((name) => name.endsWith(".rip-dvd-mutation-lock"))).toBe(false);
      writeFileSync(manifestPath, JSON.stringify({ databasePath: seeded.fixture.databasePath,
        mediaLibraryPath: seeded.fixture.mediaLibraryPath, originalsLibraryPath: seeded.fixture.originalsLibraryPath,
        identity: seeded.identity, outputPath: seeded.output.outputPath, validationIdentity: preview.current.validationIdentity!,
        previewToken: preview.previewToken! } satisfies ReadOnlyProofFixture), { mode: 0o600, flag: "wx" });
    } finally { seeded.access.close(); }
    // The invoking harness owns this synthetic leaf and mounts its media child
    // read-only for verification, then removes the leaf after collecting results.
  });
} else if (proofMode === "verify-read-only") {
  it("Keeps the first failed artifact through the public CLI on an actual read-only media mount", async () => {
    expect(process.platform).toBe("linux"); expect(process.getuid?.()).not.toBe(0);
    if (!manifestPath) throw new Error("The private proof manifest path is required.");
    const fixture = JSON.parse(readFileSync(manifestPath, "utf8")) as ReadOnlyProofFixture;
    let writeError: unknown;
    try { writeFileSync(join(fixture.mediaLibraryPath, "synthetic-read-only-probe"), "synthetic", { flag: "wx" }); }
    catch (error) { writeError = error; }
    expect(writeError).toMatchObject({ code: "EROFS" });
    const before = readFileSync(fixture.outputPath);
    const names = readdirSync(fixture.mediaLibraryPath).sort();
    expect(names.some((name) => name.endsWith(".rip-dvd-mutation-lock"))).toBe(false);
    const stdout: string[] = [];
    const status = await runCommand(["encode-output", "keep", fixture.identity, "--key", "synthetic-real-ro-keep", "--json",
      JSON.stringify({ acknowledged: true, validationIdentity: fixture.validationIdentity, previewToken: fixture.previewToken })], {
      openAccess: () => createDataAccess(fixture), mediaLibraryPath: () => fixture.mediaLibraryPath,
      originalsLibraryPath: () => fixture.originalsLibraryPath, encodeOutputMediaProbe: unavailableKeepProbe,
      readFile: (path) => readFileSync(path, "utf8"), stdout: (text) => stdout.push(text), stderr: () => undefined,
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ kept: { artifactIdentity: fixture.identity, validationIdentity: fixture.validationIdentity } });
    expect(readFileSync(fixture.outputPath)).toEqual(before);
    expect(readdirSync(fixture.mediaLibraryPath).sort()).toEqual(names);
    const access = createDataAccess(fixture);
    try { expect(access.encodeOutputKeeps.latest(fixture.identity)).not.toBeNull(); }
    finally { access.close(); }
  });
} else {
// This suite must run on Linux/nonroot backed by real supported storage in the
// release gate. Platform-neutral adapter tests do not count as kernel proof.
describe.skipIf(process.platform !== "linux")("Keep retained-file kernel read ownership", () => {
  it("excludes an inode writer after filesystem staging, with no existing normal output or media lock sidecar", async () => {
    expect(process.getuid?.()).not.toBe(0);
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const preview = (await seeded.preview()).result;
    const before = readFileSync(seeded.output.outputPath);
    const names = readdirSync(seeded.fixture.mediaLibraryPath).sort();
    // Also prove the code does not need to create a file beside its read-only
    // input. The final installed CLI/web gate additionally uses real RO mounts.
    chmodSync(seeded.fixture.mediaLibraryPath, 0o555);
    let writerStatus: number | null | undefined;
    try {
      const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-kernel-keep", "--json",
        JSON.stringify({ acknowledged: true, validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken })],
      undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe,
        openAccess() {
          const access = seeded.fixture.openAccess();
          const record = access.encodeOutputKeeps.record;
          access.encodeOutputKeeps.record = (input, prepare) => record(input, () => {
            const prepared = prepare();
            const writer = spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", seeded.output.outputPath,
              process.execPath, "--input-type=module", "-e",
              "import {writeFileSync,statSync,utimesSync} from 'node:fs';const p=process.argv[1],s=statSync(p);writeFileSync(p,'SYNTHETIC COMPLETE FAILED ENCODE');utimesSync(p,s.atime,s.mtime);",
              seeded.output.outputPath], { encoding: "utf8" });
            if (writer.error) throw writer.error;
            writerStatus = writer.status;
            return prepared;
          });
          return access;
        },
      });
      expect(writerStatus).toBe(75);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(seeded.output.outputPath)).toEqual(before);
      expect(readdirSync(seeded.fixture.mediaLibraryPath).sort()).toEqual(names);
    } finally { chmodSync(seeded.fixture.mediaLibraryPath, 0o755); }
  });

  it("holds the actual Encode Worker publication and cleanup lock through filesystem staging and Keep commit", async () => {
    expect(process.getuid?.()).not.toBe(0);
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const mutationLockPath = join(realpathSync(dirname(seeded.job.outputPath)), `.${basename(seeded.job.outputPath)}.rip-dvd-mutation-lock`);
    const initialized = spawnSync(process.execPath, ["--input-type=module", "-e", workerLockProbe,
      workerBindingPath, mutationLockPath], { encoding: "utf8" });
    if (initialized.error) throw initialized.error;
    expect(initialized.status).toBe(0);
    const preview = (await seeded.preview()).result;
    const before = readFileSync(seeded.output.outputPath);
    let workerStatus: number | null | undefined;
    const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-worker-locked-keep", "--json",
      JSON.stringify({ acknowledged: true, validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken })],
    undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe,
      openAccess() {
        const access = seeded.fixture.openAccess();
        const record = access.encodeOutputKeeps.record;
        access.encodeOutputKeeps.record = (input, prepare) => record(input, () => {
          const prepared = prepare();
          const worker = spawnSync(process.execPath, ["--input-type=module", "-e", workerLockProbe,
            workerBindingPath, mutationLockPath], { encoding: "utf8" });
          if (worker.error) throw worker.error;
          workerStatus = worker.status;
          return prepared;
        });
        return access;
      },
    });
    expect(workerStatus).toBe(75);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(seeded.output.outputPath)).toEqual(before);
  });

  it("rejects a live exclusive inode owner without recording Keep", async () => {
    expect(process.getuid?.()).not.toBe(0);
    const seeded = await seedKeepPreflightFixture(); fixtures.push(seeded);
    const preview = (await seeded.preview()).result;
    const writer = spawn("flock", ["--exclusive", "--nonblock", seeded.output.outputPath, process.execPath, "-e",
      "process.stdout.write('locked');process.stdin.resume();"], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Synthetic writer did not acquire its flock.")), 5_000);
        writer.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
        writer.once("error", (error) => { clearTimeout(timeout); reject(error); });
        writer.once("exit", () => { clearTimeout(timeout); reject(new Error("Synthetic writer exited before its lock handshake.")); });
      });
      const result = await seeded.fixture.run(["encode-output", "keep", seeded.identity, "--key", "synthetic-owned-keep", "--json",
        JSON.stringify({ acknowledged: true, validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken })],
      undefined, undefined, { encodeOutputMediaProbe: unavailableKeepProbe });
      expect(result.exitCode).not.toBe(0);
      expect(result.result).toMatchObject({ error: { code: "OUTPUT_OWNERSHIP_LOST", current: {
        eligible: false, current: { artifactIdentity: seeded.identity },
      } } });
      expect(seeded.access.encodeOutputKeeps.latest(seeded.identity)).toBeNull();
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) { writer.stdin.end(); await once(writer, "close"); }
    }
  });
});

}
