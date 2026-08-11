import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      {
        find: "@rip-dvd/data-access/dvd-content-id",
        replacement: fileURLToPath(
          new URL(
            "../../packages/data-access/src/dvd-content-id.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: "@rip-dvd/data-access/dvd-scan",
        replacement: fileURLToPath(
          new URL("../../packages/data-access/src/dvd-scan.ts", import.meta.url),
        ),
      },
      {
        find: "@rip-dvd/data-access/legacy-sidecars",
        replacement: fileURLToPath(
          new URL(
            "../../packages/data-access/src/legacy-sidecars.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: "@rip-dvd/data-access",
        replacement: fileURLToPath(
        new URL("../../packages/data-access/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    fileParallelism: false,
  },
});
