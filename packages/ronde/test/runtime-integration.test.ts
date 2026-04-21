import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod/v4"
import { createFsRuntime } from "@ronde/fs"
import { CompletionError, CompletionErrorKind } from "@ronde/core/completion"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import { agentic, createRuntime, hydrate, replay } from "../src/index.js"
import {
  mockBackend,
  mockHandler,
  textResponse,
  toolResponse,
  useTmp,
} from "./support.js"
import { userMessage } from "@ronde/core/message"

const tmp = useTmp()

afterEach(() => {
  tmp.cleanup()
})

function textHistory(
  messages: readonly { parts: readonly { type: string }[] }[],
) {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) =>
      "content" in part ? (part as { content: string }).content : "",
    )
}

async function readSegmentArchive(dir: string): Promise<string> {
  const segmentsDir = path.join(dir, "segments")
  const entries = (await fs.readdir(segmentsDir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
  const bodies = await Promise.all(
    entries.map((name) => fs.readFile(path.join(segmentsDir, name), "utf8")),
  )
  return bodies.join("\n")
}

describe("@ronde runtime integration", () => {
  it("hydrate creates the default managed runtime when none is provided", async () => {
    const root = tmp.dir("ronde-hydrate-default-")
    const result = await hydrate([userMessage("seed")], {
      root,
      project: "acme",
      name: "hydrated",
    })

    expect(result.journal).toBeDefined()
    expect(result.workspace).toBeDefined()
    expect(textHistory(await replay(result.journal))).toEqual(["seed"])
  })

  it("explicit runtime pairs load history from the journal without duplicating it", async () => {
    const runtime = await createRuntime({
      root: tmp.dir("ronde-explicit-pair-"),
      project: "acme",
      name: "explicit-pair",
    })
    await hydrate([userMessage("seeded-once")], runtime)

    await agentic(mockBackend([textResponse("ok")]), {
      prompt: "continue",
      journal: runtime.journal,
      workspace: runtime.workspace,
    })

    const seedTexts = textHistory(await replay(runtime.journal)).filter(
      (text) => text === "seeded-once",
    )
    expect(seedTexts).toHaveLength(1)
  })

  it("schema retry shares one journal and workspace pair across both passes", async () => {
    const runtime = await createRuntime({
      root: tmp.dir("ronde-schema-retry-"),
      project: "acme",
      name: "schema",
    })

    await agentic(
      mockBackend([textResponse("bad"), textResponse("still bad")]),
      {
        prompt: "structured",
        journal: runtime.journal,
        workspace: runtime.workspace,
        output: z.object({ x: z.number() }),
      },
    )

    const transcript = await readSegmentArchive(runtime.workspace.dir)
    expect(transcript).toContain("bad")
    expect(transcript).toContain("still bad")
  })

  it("schema retry carries preStep and postStep hooks into the retry pass", async () => {
    const runtime = await createRuntime({
      root: tmp.dir("ronde-schema-retry-hooks-"),
      project: "acme",
      name: "schema-hooks",
    })
    const preSteps: number[] = []
    const postSteps: number[] = []

    await agentic(mockBackend([textResponse("bad"), textResponse('{"x":1}')]), {
      prompt: "structured",
      journal: runtime.journal,
      workspace: runtime.workspace,
      output: z.object({ x: z.number() }),
      hooks: {
        preStep(input) {
          preSteps.push(input.turn)
        },
        postStep(step) {
          postSteps.push(step.turn)
        },
      },
    })

    expect(preSteps).toEqual([1, 1])
    expect(postSteps).toEqual([1, 1])
  })

  it("schema retry carries approve hooks into tool-using retry turns", async () => {
    const runtime = await createRuntime({
      root: tmp.dir("ronde-schema-retry-approve-"),
      project: "acme",
      name: "schema-approve",
    })
    const approvals: string[] = []
    const echo = tool()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => ok(text),
    })

    await agentic(
      mockBackend([
        textResponse("bad"),
        toolResponse("echo", { text: "retry" }),
        textResponse('{"x":1}'),
      ]),
      {
        prompt: "structured",
        journal: runtime.journal,
        workspace: runtime.workspace,
        output: z.object({ x: z.number() }),
        tools: echo,
        hooks: {
          approve(call) {
            approvals.push(call.name)
            return true
          },
        },
      },
    )

    expect(approvals).toEqual(["echo"])
  })

  it("resume after compaction sees only post-partition active history", async () => {
    const root = tmp.dir("ronde-compact-resume-")
    const runtime = await createRuntime({
      root,
      project: "/p",
      name: "compact-run",
    })

    const backend = mockHandler((req, i) => {
      if (i === 0) {
        throw new CompletionError(
          CompletionErrorKind.ContextLengthExceeded,
          "too long",
        )
      }
      if (req.system?.includes("continuation context")) {
        return textResponse("Summary of prior work")
      }
      return textResponse("post-compaction reply")
    })

    await agentic(backend, {
      prompt: "original ask that should disappear",
      journal: runtime.journal,
      workspace: runtime.workspace,
      maxTurns: 3,
    })

    const allText = textHistory(
      await replay({ root, project: "/p", name: "compact-run" }),
    ).join(" ")
    expect(allText).not.toContain("original ask that should disappear")
    expect(allText).toContain("post-compaction reply")
  })

  it("segments preserve pre-compaction content for forensics", async () => {
    const root = tmp.dir("ronde-compact-audit-")
    const dir = path.join(root, "projects", "-p", "audit-run")
    const runtime = await createFsRuntime(dir)

    const backend = mockHandler((req, i) => {
      if (i === 0) {
        throw new CompletionError(
          CompletionErrorKind.ContextLengthExceeded,
          "too long",
        )
      }
      if (req.system?.includes("continuation context")) {
        return textResponse("Summary")
      }
      return textResponse("after")
    })

    await agentic(backend, {
      prompt: "preserved-in-audit",
      journal: runtime.journal,
      workspace: runtime.workspace,
      maxTurns: 3,
    })

    const transcript = await readSegmentArchive(dir)
    expect(transcript).toContain("preserved-in-audit")
  })
})
