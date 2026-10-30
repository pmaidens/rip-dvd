import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const run = process.env.RIP_DVD_PREVIEW_BROWSER_RUN ?? "default";
if (!/^[a-zA-Z0-9-]{1,100}$/.test(run)) throw new Error("Choose a synthetic preview gate run name using letters, digits and hyphens.");
const root = resolve("test-results/preview-rendition-browser-data", run);
process.env.RIP_DVD_PREVIEW_BROWSER_DATA_PATH = root;
const externalBaseURL = process.env.RIP_DVD_PREVIEW_BROWSER_BASE_URL;
if (Boolean(externalBaseURL) !== Boolean(process.env.RIP_DVD_PREVIEW_BROWSER_FIXTURE)) throw new Error("External preview browser gates require both the base URL and matching fixture manifest.");
if (externalBaseURL && process.env.RIP_DVD_PREVIEW_RENDITION_BROWSER_GATE !== "true") throw new Error("External preview fixtures require the explicit browser gate.");
export default defineConfig({
  testDir: "./test/browser", testMatch: "damage-preview-rendition.e2e.ts", workers: 1, fullyParallel: false, retries: 0,
  outputDir: "test-results/preview-rendition-playwright", reporter: "line",
  use: { baseURL: externalBaseURL ?? "http://localhost:3123", httpCredentials: { username: "operator", password: "synthetic-browser-password" }, trace: "retain-on-failure" },
  webServer: externalBaseURL ? undefined : [{
    command: "node test/browser/start-preview-rendition-server.mjs", url: "http://localhost:3122/api/health", reuseExistingServer: false,
    env: { HOSTNAME: "127.0.0.1", PORT: "3122", RIP_DVD_DATABASE_PATH: resolve(root, "catalog.sqlite"), RIP_DVD_MEDIA_LIBRARY_PATH: resolve(root, "movies"), RIP_DVD_ORIGINALS_LIBRARY_PATH: resolve(root, "originals"), RIP_DVD_WEB_TRUSTED_ORIGIN: "http://localhost:3123", RIP_DVD_BROWSER_RENDITIONS_ENABLED: "true", RIP_DVD_BROWSER_RENDITIONS_PASSWORD: "synthetic-browser-password", RIP_DVD_PREVIEW_RENDITION_BROWSER_GATE: "true", RIP_DVD_PREVIEW_BROWSER_DATA_PATH: root },
  }, {
    command: "node test/browser/rendition-fault-proxy.mjs", url: "http://localhost:3123/__rendition-browser-fault/health", reuseExistingServer: false,
    env: { HOSTNAME: "127.0.0.1", PORT: "3123", RIP_DVD_RENDITION_BROWSER_UPSTREAM: "http://127.0.0.1:3122", RIP_DVD_RENDITION_BROWSER_GATE: "true" },
  }],
  projects: [
    { name: "stable-chrome", use: { browserName: "chromium", channel: "chrome", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-webkit-approximation", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
