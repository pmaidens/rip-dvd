import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const standaloneRoot = resolve(".next/standalone");
const standaloneAppRoot = resolve(standaloneRoot, "apps/web");
const staticDestination = resolve(standaloneAppRoot, ".next/static");

mkdirSync(staticDestination, { recursive: true });
cpSync(resolve(".next/static"), staticDestination, { recursive: true });

process.chdir(standaloneRoot);
await import(pathToFileURL(resolve(standaloneAppRoot, "server.js")).href);
