import { describe, expect, it } from "vitest"
import { Effort } from "@ronde/core/completion"
import type { BackendConfig, InternalBackendConfig } from "../src/types.js"

describe("@ronde/providers backend config contract", () => {
  it("carries provider, model, and apiKey for factory creation", () => {
    const config = {
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "secret",
    } satisfies BackendConfig

    expect(config.provider).toBe("openai")
    expect(config.model).toBe("gpt-5.4")
    expect(config.apiKey).toBe("secret")
  })

  it("allows caller overrides for effort and token budgets", () => {
    const config = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "secret",
      effort: Effort.High,
      maxContext: 300_000,
      maxOutput: 8_000,
    } satisfies BackendConfig

    expect(config.effort).toBe(Effort.High)
    expect(config.maxContext).toBe(300_000)
    expect(config.maxOutput).toBe(8_000)
  })

  it("allows optional baseURL overrides", () => {
    const config = {
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "secret",
      baseURL: "https://example.test/v1",
    } satisfies BackendConfig

    expect(config.baseURL).toBe("https://example.test/v1")
  })
})

describe("@ronde/providers internal backend config contract", () => {
  it("carries nativeOpenAI capability only for provider constructors", () => {
    const config = {
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    } satisfies InternalBackendConfig

    expect(config.nativeOpenAI).toBe(true)
  })

  it("carries resolved apiKey and baseURL into provider constructors", () => {
    const config = {
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://example.test",
    } satisfies InternalBackendConfig

    expect(config.apiKey).toBe("secret")
    expect(config.baseURL).toBe("https://example.test")
  })
})
