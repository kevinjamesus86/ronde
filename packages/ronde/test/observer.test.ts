import { describe, expectTypeOf, it } from "vitest"
import type { AgentStep } from "@ronde/engine"
import type { RunObserver } from "../src/observer.js"

describe("@ronde RunObserver", () => {
  it("keys callbacks to emitted engine event semantics", () => {
    expectTypeOf<RunObserver>().toMatchTypeOf<{
      onTurnStart?: (turn: number) => void
      onTurnEnd?: (turn: number, step: AgentStep) => void
      onText?: (turn: number, content: string) => void
    }>()
  })

  it("uses onText rather than the old assistant-specific callback name", () => {
    expectTypeOf<
      Extract<keyof RunObserver, "onAssistantText">
    >().toEqualTypeOf<never>()
  })

  it("treats observer callbacks as optional across the entire surface", () => {
    const observer = {} satisfies RunObserver
    void observer
  })
})
