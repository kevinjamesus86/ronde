const { platform, arch } = process

function load() {
  if (platform === "darwin" && arch === "arm64") {
    return require("./ronde-lock.darwin-arm64.node")
  }
  if (platform === "linux" && arch === "x64") {
    return require("./ronde-lock.linux-x64-gnu.node")
  }
  throw new Error(
    `@ronde/lock: no native binding for ${platform}-${arch}. ` +
      `Supported platforms: darwin-arm64, linux-x64 (glibc).`,
  )
}

const binding = load()

module.exports = binding
module.exports.FileLock = binding.FileLock
module.exports.tryAcquire = binding.tryAcquire
