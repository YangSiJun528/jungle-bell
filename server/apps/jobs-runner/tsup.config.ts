import { defineConfig } from "tsup";

export default defineConfig({
  entry: { jobs: "src/jobs.ts" },
  tsconfig: "../../tsconfig.jobs-runner.json",
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "../../dist/jobs",
  clean: true,
  noExternal: [/^@jungle-bell\/backend-common(?:\/|$)/u],
  external: ["web-push"],
});
