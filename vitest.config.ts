import { commonTestConfig, packageAliases } from "./vitest.shared.js"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: packageAliases,
  },
  test: {
    ...commonTestConfig,
    include: ["packages/*/test/**/*.test.ts"],
  },
})
