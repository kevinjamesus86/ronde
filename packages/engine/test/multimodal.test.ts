import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { BlockKind, image, text } from "@ronde/core/block"
import type { JournalEvent } from "@ronde/core/journal"
import { MessageType, type ToolResultPart } from "@ronde/core/message"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import {
  driveEngine,
  mockHandler,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine multimodal round-trip", () => {
  it("threads a multimodal Block[] tool result into the journal and the next backend request", async () => {
    const screenshot = tool({
      name: "screenshot",
      description: "Capture a screenshot.",
      parameters: z.object({}),
      execute: async () =>
        ok({
          data: "aGVsbG8=", // "hello" in base64 — small enough to inline
          width: 320,
          height: 200,
        }),
      format: (data) => [
        text(`Captured ${data.width}×${data.height}.`),
        image(data.data, "image/png"),
      ],
    })

    const backend = mockHandler((_request, call) => {
      if (call === 0) {
        return toolResponse("screenshot", {})
      }
      return textResponse("done")
    })

    const { journal } = await driveEngine(backend, {
      prompt: "go",
      toolkit: screenshot,
    })

    // 1. Journal records the tool_result message with multimodal Block[]
    const messageEvents = journal.active.filter(
      (e): e is Extract<JournalEvent, { type: "message" }> =>
        e.type === "message",
    )
    const pair = messageEvents.find((e) =>
      e.message.parts.some((p) => p.type === MessageType.ToolResult),
    )
    expect(pair).toBeDefined()
    const toolResultPart = pair!.message.parts.find(
      (p): p is ToolResultPart => p.type === MessageType.ToolResult,
    )
    expect(toolResultPart).toBeDefined()
    expect(toolResultPart!.content).toHaveLength(2)
    expect(toolResultPart!.content[0]).toEqual({
      kind: BlockKind.Text,
      text: "Captured 320×200.",
    })
    expect(toolResultPart!.content[1]).toEqual({
      kind: BlockKind.Binary,
      data: "aGVsbG8=",
      mediaType: "image/png",
    })

    // 2. The next backend request carries the canonical Block[] forward.
    expect(backend.requests).toHaveLength(2)
    const replayMessages = backend.requests[1]!.messages
    const replayToolResult = replayMessages
      .flatMap((m) => m.parts)
      .find((p): p is ToolResultPart => p.type === MessageType.ToolResult)
    expect(replayToolResult).toBeDefined()
    expect(replayToolResult!.content).toEqual(toolResultPart!.content)
  })

  it("substitutes oversized tool output as [text-slice, ref] and journals the substituted shape", async () => {
    const noisy = tool({
      name: "noisy",
      description: "Produce too much output.",
      parameters: z.object({}),
      execute: async () => ok("x".repeat(200)),
      format: (data) => data as string,
    })

    const backend = mockHandler((_request, call) => {
      if (call === 0) {
        return toolResponse("noisy", {})
      }
      return textResponse("done")
    })

    const { journal, workspace } = await driveEngine(backend, {
      prompt: "go",
      toolkit: noisy,
      truncation: { maxInline: 30 },
    })

    const messageEvents = journal.active.filter(
      (e): e is Extract<JournalEvent, { type: "message" }> =>
        e.type === "message",
    )
    const pair = messageEvents.find((e) =>
      e.message.parts.some((p) => p.type === MessageType.ToolResult),
    )!
    const trp = pair.message.parts.find(
      (p): p is ToolResultPart => p.type === MessageType.ToolResult,
    )!

    expect(trp.content).toHaveLength(2)
    expect(trp.content[0]!.kind).toBe(BlockKind.Text)
    expect(trp.content[1]!.kind).toBe(BlockKind.Ref)
    if (trp.content[1]!.kind === BlockKind.Ref) {
      expect(trp.content[1]!.uri).toBe("memory://spill/1")
      expect(trp.content[1]!.summary).toBe("truncated to first 30 of 200 bytes")
    }
    expect(workspace.spills).toHaveLength(1)
  })
})
