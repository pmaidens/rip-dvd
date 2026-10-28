import { acquireKernelProcessLock, inspectKernelProcessLock, type KernelProcessLock } from "./kernel-process-lock.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface Ticket { id: string; preview: boolean; waiting: boolean; urgent: boolean }
function privateMetadata(metadata: Stats, directory = false) {
  if ((directory ? !metadata.isDirectory() : !metadata.isFile()) || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("Unsafe archive admission state.");
}
// The queue orders contenders; the inherited image flock remains the authority.
// Removing a dead parent's ticket never releases a surviving helper's image lock.
export async function enterArchiveImageAdmission(input: {
  directory: string; preview: boolean; urgent: boolean; signal: AbortSignal;
  onContention?(urgent: boolean, waiting: boolean): void;
}) {
  try { mkdirSync(input.directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directoryMetadata = lstatSync(input.directory);
  privateMetadata(directoryMetadata, true);
  if (directoryMetadata.isSymbolicLink()) throw new Error("Unsafe archive admission directory.");
  const guardPath = join(input.directory, "guard");
  const descriptor = openSync(guardPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { privateMetadata(fstatSync(descriptor)); } catch (error) { closeSync(descriptor); throw error; }
  const queuePath = join(input.directory, "queue.json");
  const ticket: Ticket = { id: randomUUID(), preview: input.preview, waiting: false, urgent: input.urgent };
  const ticketPath = (id: string) => join(input.directory, `ticket-${id}`);
  let ticketLock: KernelProcessLock;
  try { ticketLock = acquireKernelProcessLock(ticketPath(ticket.id)); } catch (error) { closeSync(descriptor); throw error; }
  let localQueue: Ticket[] = [];
  function editQueue(edit: (queue: Ticket[]) => void): boolean {
    const named = lstatSync(guardPath);
    const held = fstatSync(descriptor);
    if (named.dev !== held.dev || named.ino !== held.ino) throw new Error("Archive admission guard changed.");
    const locked = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] });
    if (locked.status !== 0) return false;
    try {
      let queue: Ticket[] = [];
      try {
        const file = openSync(queuePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { privateMetadata(fstatSync(file)); queue = JSON.parse(readFileSync(file, "utf8")) as Ticket[]; }
        finally { closeSync(file); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!Array.isArray(queue) || queue.some((entry) => typeof entry.id !== "string" || !/^[a-f0-9-]{36}$/.test(entry.id))) throw new Error("Invalid archive admission queue.");
      queue = queue.filter((entry) => {
        const state = entry.id === ticket.id ? "held" : inspectKernelProcessLock(ticketPath(entry.id));
        if (state === "unknown") throw new Error("Archive admission liveness cannot be proved.");
        return state === "held";
      });
      ticketLock.assertHeld();
      edit(queue);
      const temporary = join(input.directory, `${ticket.id}.tmp`);
      writeFileSync(temporary, JSON.stringify(queue), { mode: 0o600, flag: "wx" });
      renameSync(temporary, queuePath);
      localQueue = queue;
      return true;
    } finally {
      const unlocked = spawnSync("flock", ["--unlock", "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] });
      if (unlocked.status !== 0) throw new Error("Archive admission guard could not be released.");
    }
  }
  let monitor: NodeJS.Timeout | undefined;
  let registered = false;
  async function release() {
    if (monitor) clearInterval(monitor);
    let removed = !registered;
    try {
      if (registered) while (!editQueue((queue) => { const index = queue.findIndex((entry) => entry.id === ticket.id); if (index >= 0) queue.splice(index, 1); })) await delay(10);
      removed = true;
    } finally {
      ticketLock.release();
      closeSync(descriptor);
      // Queue removal commits first. A crash can leave an unreferenced ticket,
      // but never a referenced missing ticket that would obscure liveness.
      if (removed) unlinkSync(ticketPath(ticket.id));
    }
  }
  try {
    while (true) {
      input.signal.throwIfAborted();
      const edited = editQueue((queue) => {
        if (!registered) {
          ticket.waiting = queue.some((entry) => entry.preview || entry.waiting);
          queue.push(ticket); registered = true;
        }
      });
      if (edited) {
        const index = localQueue.findIndex((entry) => entry.id === ticket.id);
        if (index < 0) throw new Error("Archive admission ticket disappeared.");
        if (index === 0 || (!ticket.preview && !ticket.waiting)) break;
      }
      await delay(50, undefined, { signal: input.signal });
    }
    if (input.preview && input.onContention) {
      monitor = setInterval(() => {
        try {
          if (editQueue(() => undefined)) {
            const others = localQueue.filter((entry) => entry.id !== ticket.id);
            input.onContention!(others.some((entry) => entry.urgent), others.length > 0);
          }
        } catch { input.onContention!(true, true); }
      }, 100);
      monitor.unref();
    }
    return { release };
  } catch (error) { await release(); throw error; }
}
