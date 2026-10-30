import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const parent = resolve("test-results/preview-rendition-browser-data");
const root = resolve(process.env.RIP_DVD_PREVIEW_BROWSER_DATA_PATH ?? "");
if (!root.startsWith(`${parent}/`) || process.env.RIP_DVD_PREVIEW_RENDITION_BROWSER_GATE !== "true" || resolve(process.env.RIP_DVD_DATABASE_PATH ?? "") !== resolve(root, "catalog.sqlite")) throw new Error("Preview rendition gates require their dedicated synthetic directory.");
if (existsSync(resolve(root, "catalog.sqlite"))) throw new Error("This synthetic preview fixture already exists. Preserve it or choose a fresh gate workspace before another run.");
for (const directory of [root, resolve(root, "originals"), resolve(root, "movies"), resolve(root, "operator-host")]) mkdirSync(directory, { recursive: true });
await import("./start-catalog-review-server.mjs");
