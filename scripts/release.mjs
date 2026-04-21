import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const input = process.argv[2]
const version = input ? semver.clean(input) : null

if (!version) {
  console.error("usage: node scripts/release.mjs <version>   # e.g. 0.11.0")
  process.exit(1)
}

const tag = `v${version}`

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" })
  return r.stdout?.trim() ?? ""
}

if (capture("git", ["status", "--porcelain"])) {
  console.error("working tree has uncommitted changes; commit or stash first")
  process.exit(1)
}

if (capture("git", ["tag", "-l", tag])) {
  console.error(`tag ${tag} already exists`)
  process.exit(1)
}

function bumpJson(file) {
  const pkg = JSON.parse(readFileSync(file, "utf8"))
  pkg.version = version
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@ronde/") || name === "ronde") {
        deps[name] = version
      }
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
}

function bumpCargoToml(file) {
  const src = readFileSync(file, "utf8")
  const next = src.replace(
    /^version\s*=\s*"[^"]+"\s*$/m,
    `version = "${version}"`,
  )
  if (src === next) {
    throw new Error(`no version line updated in ${file}`)
  }
  writeFileSync(file, next)
}

const targets = [path.join(root, "package.json")]
for (const entry of readdirSync(path.join(root, "packages"))) {
  const pkgPath = path.join(root, "packages", entry, "package.json")
  if (existsSync(pkgPath)) {
    targets.push(pkgPath)
  }
}

console.log(`bumping ${targets.length} package.json files to ${version}`)
for (const t of targets) {
  bumpJson(t)
}

const cargoToml = path.join(root, "packages", "lock", "Cargo.toml")
console.log(`bumping ${path.relative(root, cargoToml)}`)
bumpCargoToml(cargoToml)

console.log("running verification")
sh("npm", ["run", "check"])
sh("npm", ["test"])
sh("npm", ["run", "build"])

console.log("committing")
sh("git", ["add", "-u"])
sh("git", ["commit", "-m", `chore: release ${tag}`])

console.log("tagging")
sh("git", ["tag", tag])

console.log(`
done — ${tag} prepared locally.
push with:
  git push && git push origin ${tag}

CI will build binaries and publish release/${tag}.
`)
