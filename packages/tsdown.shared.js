// Shared tsdown config helper. Each sub-package imports this and
// overrides entry points. tsdown externalizes anything listed in the
// package's dependencies/peerDependencies automatically, so workspace
// imports between @ronde/* packages stay as runtime imports that
// resolve via each package's own dist/.

import { defineConfig } from "tsdown"

/**
 * @param {import("tsdown").UserConfig} overrides
 * @returns {import("tsdown").UserConfig}
 */
export function packageConfig(overrides) {
  return defineConfig({
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    ...overrides,
  })
}
