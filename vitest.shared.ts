import path from "node:path"

function packagePath(pkg: string, file: string) {
  return path.resolve(import.meta.dirname, "packages", pkg, "src", file)
}

export const packageAliases = [
  {
    find: /^@ronde\/backend$/,
    replacement: packagePath("backend", "index.ts"),
  },
  {
    find: /^@ronde\/backend\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "backend",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/core$/,
    replacement: packagePath("core", "index.ts"),
  },
  {
    find: /^@ronde\/core\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "core",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/engine$/,
    replacement: packagePath("engine", "index.ts"),
  },
  {
    find: /^@ronde\/engine\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "engine",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/fs$/,
    replacement: packagePath("fs", "index.ts"),
  },
  {
    find: /^@ronde\/fs\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "fs",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/lock$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "lock",
      "index.js",
    ),
  },
  {
    find: /^@ronde\/mem$/,
    replacement: packagePath("mem", "index.ts"),
  },
  {
    find: /^@ronde\/mem\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "mem",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/providers$/,
    replacement: packagePath("providers", "index.ts"),
  },
  {
    find: /^@ronde\/providers\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "providers",
      "src",
      "$1.ts",
    ),
  },
  {
    find: /^@ronde\/tools$/,
    replacement: packagePath("tools", "index.ts"),
  },
  {
    find: /^@ronde\/tools\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "tools",
      "src",
      "$1.ts",
    ),
  },
  { find: /^ronde$/, replacement: packagePath("ronde", "index.ts") },
  {
    find: /^ronde\/(.+)$/,
    replacement: path.resolve(
      import.meta.dirname,
      "packages",
      "ronde",
      "src",
      "$1.ts",
    ),
  },
] as const

export const commonTestConfig = {
  testTimeout: 120_000,
  hookTimeout: 30_000,
} as const
