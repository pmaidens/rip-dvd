import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const [
  boundary,
  partialPath,
  finalPath,
  priorFinalPath = "",
  replacementPath = "",
] =
  process.argv.slice(2);

if (!boundary || !partialPath || !finalPath) {
  throw new Error("Publication kill helper arguments are incomplete");
}

function sync(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function blockAt(stage) {
  writeSync(1, `${stage}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (priorFinalPath) {
  if (!replacementPath) {
    throw new Error("Replacement publication path is unavailable");
  }
  linkSync(finalPath, priorFinalPath);
  linkSync(partialPath, replacementPath);
  renameSync(replacementPath, finalPath);
} else {
  linkSync(partialPath, finalPath);
}
if (boundary === "final-linked") {
  blockAt("final-linked");
}

sync(dirname(finalPath));
if (boundary === "directory-synced") {
  blockAt("directory-synced");
}

writeSync(1, "ready-for-database\n");
if (boundary === "database-completed") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

readFileSync(0, "utf8");
unlinkSync(partialPath);
if (boundary === "partial-unlinked") {
  blockAt("partial-unlinked");
}

throw new Error(`Unsupported publication boundary: ${boundary}`);
