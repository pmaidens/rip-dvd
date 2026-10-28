import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createArchiveImageOwnership } from "../../dist/archive-image-ownership.js";

const [root, source, mode, ready, release, contention] = process.argv.slice(2);
const ownership = createArchiveImageOwnership({ authorityRootPath: root, inspectStorage: () => ({ filesystemType: "ext", storageClass: "local" }) });
await ownership.withConsistentRead({
  archiveId: "synthetic-preview-ownership", imagePath: source, originalsLibraryPath: root,
  signal: new AbortController().signal,
  ...(mode === "preview" ? { previewRead: { onContention(urgent, waiting) { if (waiting) writeFileSync(contention, JSON.stringify({ urgent })); } } } : {}),
  async task({ descriptor }) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", "import {openSync} from 'node:fs';openSync(process.argv[1],'r');setInterval(()=>{},1000)", source], { detached: true, stdio: ["ignore", "ignore", "ignore", descriptor] });
    writeFileSync(ready, JSON.stringify({ pid: process.pid, helperPid: child.pid }));
    while (!existsSync(release)) await delay(10);
    const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
  },
});
