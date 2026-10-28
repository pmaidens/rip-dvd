import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";

export interface KernelProcessLock {
  assertHeld(): void;
  release(): void;
}
const testLocks = new Set<string>();
function safe(metadata: Stats) {
  if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe process lock.");
}
function flock(descriptor: number): number | null {
  return spawnSync("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] }).status;
}
function namedDescriptor(path: string, create: boolean) {
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  try { safe(fstatSync(descriptor)); return descriptor; }
  catch (error) { closeSync(descriptor); throw error; }
}
export function assertKernelFlock(descriptor: number, mode: "shared" | "exclusive"): void {
  const evidence = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
  const modes = [...evidence.matchAll(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+(READ|WRITE)\b/gm)].map((match) => match[1]);
  if (modes.length !== 1 || modes[0] !== (mode === "exclusive" ? "WRITE" : "READ")) throw new Error("Descriptor does not hold the expected flock.");
}
/** The kernel lock has the same identity in every container PID namespace. */
export function inspectKernelProcessLock(path: string): "held" | "inactive" | "unknown" {
  let descriptor: number | undefined;
  try {
    descriptor = namedDescriptor(path, false);
    if (process.platform !== "linux") return process.env.NODE_ENV === "test" ? testLocks.has(path) ? "held" : "inactive" : "unknown";
    const result = flock(descriptor);
    const held = fstatSync(descriptor), named = lstatSync(path);
    safe(named);
    if (named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) return "unknown";
    return result === 75 ? "held" : result === 0 ? "inactive" : "unknown";
  } catch { return "unknown"; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
export function acquireKernelProcessLock(path: string): KernelProcessLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o077) !== 0) throw new Error("Unsafe process lock directory.");
  const descriptor = namedDescriptor(path, true);
  let released = false;
  try {
    if (process.platform === "linux") {
      if (flock(descriptor) !== 0) throw new Error("Process lock is already held or unavailable.");
    } else if (process.env.NODE_ENV === "test" && !testLocks.has(path)) testLocks.add(path);
    else throw new Error("Process locks are unavailable.");
    return {
      assertHeld() {
        if (released) throw new Error("Process lock was released.");
        const named = lstatSync(path), held = fstatSync(descriptor);
        safe(named); safe(held);
        if (named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) throw new Error("Process lock identity changed.");
        if (process.platform === "linux") {
          assertKernelFlock(descriptor, "exclusive");
        } else if (!testLocks.has(path)) throw new Error("Process lock was lost.");
      },
      release() { if (!released) { released = true; testLocks.delete(path); closeSync(descriptor); } },
    };
  } catch (error) { closeSync(descriptor); throw error; }
}
