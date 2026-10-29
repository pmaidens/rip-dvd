import { spawn } from "node:child_process";
import { constants, fstatSync, lstatSync, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertKernelFlock } from "./kernel-process-lock.js";

export interface EncodeOutputReadOwnership {
  assertHeld(): void;
  release(): Promise<void>;
}

function missing(error: unknown) { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

async function sharedFlock(descriptor: number) {
  if (process.platform !== "linux") {
    if (process.env.NODE_ENV === "test") return;
    throw new Error("Output read ownership requires Linux.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("flock", ["--shared", "--nonblock", "--conflict-exit-code", "75", "3"],
      { stdio: ["ignore", "ignore", "ignore", descriptor] });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Output read ownership timed out.")); }, 5_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(); else reject(new Error("Output write ownership is active or unavailable."));
    });
  });
}

/** Retained inode ownership plus the shared side of the worker's publication lock.
 * The media mount may be read-only. An absent publication sidecar stays absent;
 * immutable failed-artifact and publication database fences remain authoritative. */
export async function acquireEncodeOutputReadOwnership(path: string, normalDestination: string): Promise<EncodeOutputReadOwnership> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let publication: Awaited<ReturnType<typeof open>> | undefined;
  let released = false;
  let lockPath: string;
  let directory: string;
  function assertDescriptor(descriptor: number, namedPath: string) {
    const held = fstatSync(descriptor), named = lstatSync(namedPath);
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino) {
      throw new Error("Output read ownership identity changed.");
    }
    if (process.platform === "linux") assertKernelFlock(descriptor, "shared");
  }
  try {
    directory = await realpath(dirname(normalDestination));
    lockPath = join(directory, `.${basename(normalDestination)}.rip-dvd-mutation-lock`);
    try { publication = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (!missing(error)) throw error; }
    if (publication !== undefined) await sharedFlock(publication.fd);
    await sharedFlock(file.fd);
    const assertHeld = () => {
      if (released) throw new Error("Output read ownership was released.");
      assertDescriptor(file.fd, path);
      if (realpathSync(dirname(normalDestination)) !== directory) throw new Error("Output publication directory changed.");
      if (publication !== undefined) assertDescriptor(publication.fd, lockPath);
      else {
        try { lstatSync(lockPath); }
        catch (error) { if (missing(error)) return; throw error; }
        throw new Error("Output publication ownership appeared.");
      }
    };
    assertHeld();
    return { assertHeld, async release() {
      if (!released) { released = true; try { await file.close(); } finally { await publication?.close(); } }
    } };
  } catch (error) { released = true; try { await file.close(); } finally { await publication?.close(); } throw error; }
}
