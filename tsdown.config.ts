import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "packages/ronde/src/index.ts",
    toolkit: "packages/core/src/toolkit.ts",
    stream: "packages/core/src/stream.ts",
    "tools/index": "packages/tools/src/index.ts",
    journal: "packages/core/src/journal.ts",
    workspace: "packages/core/src/workspace.ts",
    "completion/errors": "packages/backend/src/errors.ts",
    result: "packages/core/src/result.ts",
  },
  deps: {
    neverBundle: ["@ronde/lock"],
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
