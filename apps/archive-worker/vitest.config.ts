import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@rip-dvd/data-access": fileURLToPath(
        new URL("../../packages/data-access/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    fileParallelism: false,
  },
});
