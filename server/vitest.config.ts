import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/tests/**/*.test.ts",
      "shared/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
