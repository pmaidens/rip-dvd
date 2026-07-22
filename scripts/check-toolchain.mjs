import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);
const nodeVersion = readFileSync(
  resolve(repositoryRoot, ".node-version"),
  "utf8",
).trim();
const expectedPnpm = packageJson.packageManager;
const expectedEngine = `>=${nodeVersion} <23`;
const dockerfile = readFileSync(
  resolve(repositoryRoot, "docker/runtime.Dockerfile"),
  "utf8",
);
const pnpmUserAgent = process.env.npm_config_user_agent?.split(" ")[0];

const mismatches = [];
if (process.versions.node !== nodeVersion) {
  mismatches.push(
    `running Node is ${process.versions.node}; expected ${nodeVersion}`,
  );
}
if (pnpmUserAgent !== expectedPnpm.replace("@", "/")) {
  mismatches.push(
    `running package manager is ${pnpmUserAgent ?? "unknown"}; expected ${expectedPnpm}`,
  );
}
if (packageJson.engines.node !== expectedEngine) {
  mismatches.push(
    `package.json engines.node is ${packageJson.engines.node}; expected ${expectedEngine}`,
  );
}
const dockerPins = dockerfile.match(
  new RegExp(`FROM node:${nodeVersion.replaceAll(".", "\\.")}-`, "g"),
);
if (dockerPins?.length !== 2) {
  mismatches.push(
    `docker/runtime.Dockerfile must pin both build and runtime images to Node ${nodeVersion}`,
  );
}

if (mismatches.length > 0) {
  throw new Error(`Toolchain mismatch:\n- ${mismatches.join("\n- ")}`);
}

console.log(`Toolchain verified: Node ${nodeVersion}, ${expectedPnpm}`);
