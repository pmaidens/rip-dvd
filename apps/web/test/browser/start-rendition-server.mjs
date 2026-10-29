import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve("test-results/rendition-browser-data");
if (resolve(process.env.RIP_DVD_DATABASE_PATH ?? "") !== resolve(root, "catalog.sqlite")) throw new Error("Synthetic rendition gate requires its dedicated data directory.");
rmSync(root, { recursive: true, force: true });
for (const directory of [root, resolve(root, "originals"), resolve(root, "movies"), resolve(root, "operator-host")]) mkdirSync(directory, { recursive: true });
await import("./start-catalog-review-server.mjs");
