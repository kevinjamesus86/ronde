import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd, shell: true })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

function lockBinaryName() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "ronde-lock.darwin-arm64.node"
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "ronde-lock.linux-x64-gnu.node"
  }
  return null
}

const lockName = lockBinaryName()
if (!lockName) {
  console.error(
    `ronde: unsupported platform ${process.platform}-${process.arch}. ` +
      `Supported: darwin-arm64, linux-x64.`,
  )
  process.exit(1)
}

const lockBin = path.join(root, "packages", "lock", lockName)
if (!existsSync(lockBin)) {
  run("npm", ["run", "build"], path.join(root, "packages", "lock"))
}

if (!existsSync(path.join(root, "dist"))) {
  run("npm", ["run", "build"], root)
}
