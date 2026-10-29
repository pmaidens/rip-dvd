import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve("test-results/rendition-browser-data");
export default defineConfig({
  testDir: "./test/browser", testMatch: "encode-output-rendition.e2e.ts", workers: 1, fullyParallel: false, retries: 0,
  outputDir: "test-results/rendition-playwright", reporter: "line",
  use: { baseURL: "http://localhost:3112", httpCredentials: { username: "operator", password: "synthetic-browser-password" }, trace: "retain-on-failure" },
  webServer: {
    command: "node test/browser/start-rendition-server.mjs", url: "http://localhost:3112/api/health", reuseExistingServer: false,
    env: { HOSTNAME: "127.0.0.1", PORT: "3112", RIP_DVD_DATABASE_PATH: resolve(root, "catalog.sqlite"), RIP_DVD_MEDIA_LIBRARY_PATH: resolve(root, "movies"), RIP_DVD_ORIGINALS_LIBRARY_PATH: resolve(root, "originals"), RIP_DVD_WEB_TRUSTED_ORIGIN: "http://localhost:3112", RIP_DVD_BROWSER_RENDITIONS_ENABLED: "true", RIP_DVD_BROWSER_RENDITIONS_PASSWORD: "synthetic-browser-password", RIP_DVD_RENDITION_BROWSER_GATE: "true" },
  },
  projects: [
    { name: "stable-chrome", use: { browserName: "chromium", channel: "chrome", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-webkit-approximation", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
