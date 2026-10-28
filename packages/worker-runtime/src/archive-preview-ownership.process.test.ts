import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "./archive-image-ownership.js";

const roots: string[] = [];
const children: number[] = [];
afterEach(() => {
  children.splice(0).forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch {} });
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await delay(10); }
  throw new Error("Synthetic ownership process did not reach its boundary.");
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "preview-ownership-")); roots.push(root);
  const imagePath = join(root, "source.iso"); writeFileSync(imagePath, Buffer.alloc(2_048));
  const ownership = createArchiveImageOwnership({ authorityRootPath: root, inspectStorage: () => ({ filesystemType: "ext", storageClass: "local" }) });
  const request = { archiveId: "synthetic-preview-ownership", originalsLibraryPath: root, imagePath, signal: new AbortController().signal };
  await ownership.withInitialPublicationWriter({ ...request, async task() {} });
  function start(mode: "preview" | "read", name: string) {
    const ready = join(root, `${name}.ready`), release = join(root, `${name}.release`), contention = join(root, `${name}.contention`);
    const child = spawn(process.execPath, [fileURLToPath(new URL("./test/archive-preview-owner.mjs", import.meta.url)), root, imagePath, mode, ready, release, contention], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "ignore", "inherit"] });
    children.push(child.pid!);
    const done = once(child, "close");
    return { child, ready, release, contention, done };
  }
  function queueLength() {
    const directory = join(root, ".rip-dvd-archive-ownership");
    const name = readdirSync(directory).find((name) => name.endsWith(".lock.admission"));
    if (!name) return 0;
    try { return (JSON.parse(readFileSync(join(directory, name, "queue.json"), "utf8")) as unknown[]).length; } catch { return 0; }
  }
  return { root, ownership, request, start, queueLength };
}
it.skipIf(process.platform !== "linux")("holds the actual helper's exclusive preview read after parent death and lease time cannot grant a reader", async () => {
  const { ownership, request, start } = await fixture();
  const owner = start("preview", "owner");
  await waitFor(() => existsSync(owner.ready));
  const { helperPid } = JSON.parse(readFileSync(owner.ready, "utf8")) as { helperPid: number }; children.push(helperPid);
  owner.child.kill("SIGKILL"); await owner.done;
  expect(ownership.inspect({ ...request, imagePath: request.imagePath }).writer.state).toBe("active");
  await expect(ownership.withConsistentRead({ ...request, async task() {} })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });
  process.kill(helperPid, "SIGKILL");
  await waitFor(() => ownership.inspect({ ...request }).stableRead.available);
  await expect(ownership.withConsistentRead({ ...request, async task() {} })).resolves.toBeUndefined();
});
it.skipIf(process.platform !== "linux")("reports preview contention and grants readers in oldest waiter order after the generator and inherited reader close", async () => {
  const { start, queueLength } = await fixture();
  const owner = start("preview", "owner"); await waitFor(() => existsSync(owner.ready));
  const first = start("read", "first"); await waitFor(() => queueLength() === 2);
  const second = start("read", "second"); await waitFor(() => queueLength() === 3);
  await waitFor(() => existsSync(owner.contention));
  expect(existsSync(first.ready)).toBe(false); expect(existsSync(second.ready)).toBe(false);
  writeFileSync(owner.release, "release"); await owner.done;
  await waitFor(() => existsSync(first.ready)); expect(existsSync(second.ready)).toBe(false);
  writeFileSync(first.release, "release"); await first.done;
  await waitFor(() => existsSync(second.ready)); writeFileSync(second.release, "release"); await second.done;
});
