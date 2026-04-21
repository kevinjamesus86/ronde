import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { JournalEvent } from "@ronde/core/journal"
import { emptyUsage, StopReason } from "@ronde/core/completion"
import { statFsRuntime } from "@ronde/fs"
import { createManagedRuntime, openRuntime } from "../src/managed.js"
import { useTmp, withEnv } from "./support.js"

const tmp = useTmp()

afterEach(() => {
  tmp.cleanup()
})

describe("@ronde managed runtime layout", () => {
  it("falls back to RONDE_HOME when no root override is supplied", async () => {
    const root = tmp.dir("ronde-home-")

    await withEnv("RONDE_HOME", root, async () => {
      const runtime = await createManagedRuntime({ project: "acme" })
      expect(
        runtime.workspace.dir.startsWith(path.join(root, "projects")),
      ).toBe(true)
    })
  })

  it("sanitizes project and runtime names for filesystem safety", async () => {
    const root = tmp.dir("ronde-managed-sanitize-")
    const runtime = await createManagedRuntime({
      root,
      project: "acme/prod",
      name: 'my "unsafe" runtime',
    })

    expect(runtime.workspace.dir).toContain(path.join("projects", "acme-prod"))
    expect(runtime.workspace.dir).toContain("my__unsafe__runtime")
  })
})

describe("@ronde createManagedRuntime", () => {
  it("creates a named managed runtime under the project bucket", async () => {
    const root = tmp.dir("ronde-managed-named-")
    const runtime = await createManagedRuntime({
      root,
      project: "acme",
      name: "named-run",
    })

    await expect(statFsRuntime(runtime.workspace.dir)).resolves.toMatchObject({
      id: runtime.journal.id,
    })
  })

  it("allocates unnamed runtimes with generated ids", async () => {
    const root = tmp.dir("ronde-managed-generated-")
    const runtime = await createManagedRuntime({ root, project: "acme" })

    expect(path.basename(runtime.workspace.dir)).toMatch(/^[a-z0-9-]+$/)
  })

  it("fails on named collisions", async () => {
    const root = tmp.dir("ronde-managed-collision-")
    await createManagedRuntime({ root, project: "acme", name: "same" })

    await expect(
      createManagedRuntime({ root, project: "acme", name: "same" }),
    ).rejects.toThrow(/already exists/i)
  })

  it("rejects empty or whitespace-only managed runtime names", async () => {
    const root = tmp.dir("ronde-managed-invalid-")

    await expect(
      createManagedRuntime({ root, project: "acme", name: "" }),
    ).rejects.toThrow(/invalid managed runtime name/i)
    await expect(
      createManagedRuntime({ root, project: "acme", name: "   " }),
    ).rejects.toThrow(/invalid managed runtime name/i)
  })

  it("rejects names that sanitize to only slashes or separators", async () => {
    const root = tmp.dir("ronde-managed-slashes-")

    await expect(
      createManagedRuntime({ root, project: "acme", name: "////" }),
    ).rejects.toThrow(/invalid managed runtime name/i)
  })

  it("strips control characters from managed names that remain valid", async () => {
    const root = tmp.dir("ronde-managed-control-")
    const runtime = await createManagedRuntime({
      root,
      project: "acme",
      name: "run\n1\t2",
    })

    const name = path.basename(runtime.workspace.dir)
    expect(name).toContain("run")
    expect(name).not.toContain("\n")
    expect(name).not.toContain("\t")
  })
})

describe("@ronde openRuntime", () => {
  it("opens a named managed runtime directly", async () => {
    const root = tmp.dir("ronde-open-named-")
    const created = await createManagedRuntime({
      root,
      project: "acme",
      name: "named-run",
    })

    await created.journal.event(JournalEvent.warning(1, "hello"))

    const opened = await openRuntime("named-run", {
      root,
      project: "acme",
    })

    expect(opened.journal.id).toBe(created.journal.id)
    expect(opened.workspace.dir).toBe(created.workspace.dir)
  })

  it("opens the latest valid runtime by active-segment mtime, createdAt, then id", async () => {
    const root = tmp.dir("ronde-open-latest-")
    const project = "acme"

    const older = await createManagedRuntime({ root, project })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await createManagedRuntime({ root, project })

    await older.journal.event(
      JournalEvent.turnEnd(1, emptyUsage(), StopReason.EndTurn),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    await newer.journal.event(
      JournalEvent.turnEnd(1, emptyUsage(), StopReason.EndTurn),
    )

    const olderStat = await statFsRuntime(older.workspace.dir)
    const newerStat = await statFsRuntime(newer.workspace.dir)
    expect(newerStat.mtime).toBeGreaterThanOrEqual(olderStat.mtime)

    const opened = await openRuntime({ root, project })
    expect(opened.journal.id).toBe(newer.journal.id)
  })

  it("ignores corrupt or non-runtime directories when selecting latest", async () => {
    const root = tmp.dir("ronde-open-ignore-")
    const project = "acme"
    await fs.mkdir(path.join(root, "projects", "acme", "junk"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, "projects", "acme", "junk", "not-a-runtime.txt"),
      "junk",
      "utf8",
    )

    const runtime = await createManagedRuntime({ root, project })
    const opened = await openRuntime({ root, project })
    expect(opened.journal.id).toBe(runtime.journal.id)
  })

  it("fails clearly when no runtimes exist in the project bucket", async () => {
    const root = tmp.dir("ronde-open-empty-")
    await expect(openRuntime({ root, project: "acme" })).rejects.toThrow(
      /No runtimes found/i,
    )
  })
})
