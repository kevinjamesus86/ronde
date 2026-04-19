import { describe, expect, it } from "vitest"
import { CompletionMode } from "@ronde/core/completion"
import {
  modeWantsThoughtReplay,
  modeWantsThoughtText,
  normalizeCompletionMode,
} from "../src/mode.js"

describe("@ronde/backend normalizeCompletionMode", () => {
  it("preserves known agentic mode", () => {
    expect(normalizeCompletionMode(CompletionMode.Agentic)).toBe(
      CompletionMode.Agentic,
    )
  })

  it("preserves known structured mode", () => {
    expect(normalizeCompletionMode(CompletionMode.Structured)).toBe(
      CompletionMode.Structured,
    )
  })

  it("preserves known compaction mode", () => {
    expect(normalizeCompletionMode(CompletionMode.Compaction)).toBe(
      CompletionMode.Compaction,
    )
  })

  it("falls back to agentic for unknown mode values", () => {
    expect(normalizeCompletionMode("unknown" as CompletionMode)).toBe(
      CompletionMode.Agentic,
    )
  })
})

describe("@ronde/backend mode policy helpers", () => {
  it("requests thought text only for agentic mode", () => {
    expect(modeWantsThoughtText(CompletionMode.Agentic)).toBe(true)
    expect(modeWantsThoughtText(CompletionMode.Structured)).toBe(false)
    expect(modeWantsThoughtText(CompletionMode.Compaction)).toBe(false)
  })

  it("replays thought traces for agentic mode", () => {
    expect(modeWantsThoughtReplay(CompletionMode.Agentic)).toBe(true)
  })

  it("replays thought traces for structured mode", () => {
    expect(modeWantsThoughtReplay(CompletionMode.Structured)).toBe(true)
  })

  it("suppresses thought replay for compaction mode", () => {
    expect(modeWantsThoughtReplay(CompletionMode.Compaction)).toBe(false)
  })
})
