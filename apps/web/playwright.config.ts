import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const browserDataRoot = resolve("test-results/catalog-review-browser-data");
// Loopback origins are secure contexts even over HTTP. Use a reserved test
// hostname so Chromium exercises the same API restrictions as an HTTP host.
const baseURL = "http://rip-dvd.test:3100";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/playwright",
  use: {
    baseURL,
    launchOptions: {
      args: ["--host-resolver-rules=MAP rip-dvd.test 127.0.0.1", "--no-proxy-server"],
    },
    locale: "en-CA",
    timezoneId: "America/Edmonton",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm test:browser:serve",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: "3100",
      RIP_DVD_DATABASE_PATH: resolve(browserDataRoot, "rip-dvd.sqlite"),
      RIP_DVD_MEDIA_LIBRARY_PATH: resolve(browserDataRoot, "media"),
      RIP_DVD_ORIGINALS_LIBRARY_PATH: resolve(browserDataRoot, "originals"),
      RIP_DVD_WEB_TRUSTED_ORIGIN: baseURL,
    },
  },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1_440, height: 1_000 } },
    },
    {
      name: "narrow-mobile",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
});
