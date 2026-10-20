import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createArchiveImageOwnership } from "../../dist/archive-image-ownership.js";

const [
  originalsLibraryPath,
  imagePath,
  readyPath,
  writePath,
  authorityRootPath,
] = process.argv.slice(2);
const ownership = createArchiveImageOwnership({
  authorityRootPath,
  claimLeaseDurationMs: 150,
  ownershipCheckIntervalMs: 25,
});
await ownership.withInitialPublicationWriter({
  archiveId: "surviving-helper-archive",
  imagePath,
  originalsLibraryPath,
  signal: new AbortController().signal,
  async task({ descriptor }) {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./archive-image-ownership-helper.mjs", import.meta.url)),
        readyPath,
        writePath,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", descriptor] },
    );
    child.unref();
    setInterval(() => undefined, 60_000);
    await new Promise(() => undefined);
  },
});
