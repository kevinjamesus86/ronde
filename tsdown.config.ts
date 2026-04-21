import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "packages/ronde/src/index.ts",
  },
  deps: {
    neverBundle: ["@ronde/lock"],
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
