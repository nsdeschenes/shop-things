import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
