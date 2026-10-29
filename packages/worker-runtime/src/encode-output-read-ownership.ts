import { spawn } from "node:child_process";
import { constants, fstatSync, lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { assertKernelFlock } from "./kernel-process-lock.js";

export interface EncodeOutputReadOwnership {
  assertHeld(): void;
  release(): Promise<void>;
}

/** Retained failed files have no admitted writer. Hold the exact inode read-only;
 * publication and cleanup must preserve its immutable artifact authority. This
 * does not take the normal destination's worker lock or create a media sidecar. */
export async function acquireEncodeOutputReadOwnership(path: string): Promise<EncodeOutputReadOwnership> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let released = false;
  function assertIdentity() {
    if (released) throw new Error("Output read ownership was released.");
    const held = fstatSync(file.fd), named = lstatSync(path);
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino) {
      throw new Error("Output read ownership identity changed.");
    }
  }
  try {
    assertIdentity();
    if (process.platform === "linux") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("flock", ["--shared", "--nonblock", "--conflict-exit-code", "75", "3"],
          { stdio: ["ignore", "ignore", "ignore", file.fd] });
        const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Output read ownership timed out.")); }, 5_000);
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
        child.once("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve(); else reject(new Error("Output write ownership is active or unavailable."));
        });
      });
    } else if (process.env.NODE_ENV !== "test") throw new Error("Output read ownership requires Linux.");
    const assertHeld = () => { assertIdentity(); if (process.platform === "linux") assertKernelFlock(file.fd, "shared"); };
    assertHeld();
    return { assertHeld, async release() { if (!released) { released = true; await file.close(); } } };
  } catch (error) { released = true; await file.close(); throw error; }
}
