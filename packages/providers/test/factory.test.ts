import { describe, expect, it, vi } from "vitest"
import { Effort, StopReason, emptyUsage } from "@ronde/core/completion"
import { DEFAULT_MAX_CONTEXT, DEFAULT_MAX_OUTPUT } from "@ronde/backend"
import { createBackend } from "../src/factory.js"
import { registerProvider } from "../src/registry.js"

describe("@ronde/providers createBackend", () => {
  it("looks up the requested provider descriptor from the registry", async () => {
    const complete = vi.fn(async () => {
      throw new Error("stop")
    })
    const create = vi.fn(() => ({ specVersion: "v1" as const, complete }))
    const name = `test-${Date.now()}-factory`

    registerProvider({
      name,
      defaultURL: "https://example.test",
      envVar: "TEST_API_KEY",
      create,
    })

    const backend = createBackend({
      provider: name,
      model: "custom-model",
      apiKey: "secret",
    })

    expect(create).toHaveBeenCalledOnce()
    expect(backend.config.model).toBe("custom-model")
  })

  it("throws a clear error for unknown provider names", () => {
    expect(() =>
      createBackend({
        provider: "__missing__",
        model: "whatever",
        apiKey: "secret",
      }),
    ).toThrow(/Register it with registerProvider/)
  })

  it("fills in default token budgets when omitted", () => {
    const backend = createBackend({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "secret",
    })

    expect(backend.config.maxContext).toBe(DEFAULT_MAX_CONTEXT)
    expect(backend.config.maxOutput).toBe(DEFAULT_MAX_OUTPUT)
  })

  it("preserves explicit token budgets when provided", () => {
    const backend = createBackend({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "secret",
      maxContext: 400_000,
      maxOutput: 16_000,
    })

    expect(backend.config.maxContext).toBe(400_000)
    expect(backend.config.maxOutput).toBe(16_000)
  })

  it("normalizes effort onto the resolved backend config", () => {
    const backend = createBackend({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "secret",
      effort: Effort.High,
    })

    expect(backend.config.effort).toBe(Effort.High)
  })

  it("uses the descriptor defaultURL when baseURL is omitted", () => {
    const create = vi.fn(() => ({
      specVersion: "v1" as const,
      complete: async () => {
        throw new Error("stop")
      },
    }))
    const name = `test-${Date.now()}-default-url`

    registerProvider({
      name,
      defaultURL: "https://default.test",
      envVar: null,
      create,
    })

    createBackend({
      provider: name,
      model: "model",
      apiKey: "secret",
    })

    expect(create).toHaveBeenCalledWith({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://default.test",
    })
  })

  it("preserves an explicit baseURL override", () => {
    const create = vi.fn(() => ({
      specVersion: "v1" as const,
      complete: async () => {
        throw new Error("stop")
      },
    }))
    const name = `test-${Date.now()}-override-url`

    registerProvider({
      name,
      defaultURL: "https://default.test",
      envVar: null,
      create,
    })

    createBackend({
      provider: name,
      model: "model",
      apiKey: "secret",
      baseURL: "https://override.test",
    })

    expect(create).toHaveBeenCalledWith({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://override.test",
    })
  })

  it("marks nativeOpenAI only for the official openai provider", () => {
    const openai = createBackend({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "secret",
    })
    const anthropic = createBackend({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "secret",
    })

    expect(openai.config.model).toBe("gpt-5.4")
    expect(anthropic.config.model).toBe("claude-sonnet-4-6")
  })

  it("throws the missing-env-var message in a browser-like env instead of a reference error", () => {
    const name = `test-${Date.now()}-browser`
    const envKey = `RONDE_TEST_BROWSER_${Date.now()}`

    registerProvider({
      name,
      defaultURL: "https://default.test",
      envVar: envKey,
      create: () => ({
        specVersion: "v1" as const,
        complete: async () => {
          throw new Error("stop")
        },
      }),
    })

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "process",
    )
    try {
      Object.defineProperty(globalThis, "process", {
        value: undefined,
        configurable: true,
        writable: true,
      })

      expect(() =>
        createBackend({
          provider: name,
          model: "model",
        }),
      ).toThrow(new RegExp(`Missing ${envKey}`))
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "process", originalDescriptor)
      }
    }
  })

  it("accepts an explicit apiKey when process is undefined", () => {
    const name = `test-${Date.now()}-browser-key`
    const create = vi.fn(() => ({
      specVersion: "v1" as const,
      complete: async () => {
        throw new Error("stop")
      },
    }))

    registerProvider({
      name,
      defaultURL: "https://default.test",
      envVar: "UNSET_KEY",
      create,
    })

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "process",
    )
    try {
      Object.defineProperty(globalThis, "process", {
        value: undefined,
        configurable: true,
        writable: true,
      })

      createBackend({
        provider: name,
        model: "model",
        apiKey: "explicit-secret",
      })

      expect(create).toHaveBeenCalledWith({
        nativeOpenAI: false,
        apiKey: "explicit-secret",
        baseURL: "https://default.test",
      })
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "process", originalDescriptor)
      }
    }
  })

  it("returns a configured backend that delegates complete() to the provider backend", async () => {
    const response = {
      messages: [],
      stopReason: StopReason.EndTurn,
      usage: emptyUsage(),
      providerMeta: null,
      warnings: [],
    }
    const complete = vi.fn(async () => response)
    const name = `test-${Date.now()}-delegate`

    registerProvider({
      name,
      defaultURL: undefined,
      envVar: null,
      create: () => ({ specVersion: "v1" as const, complete }),
    })

    const backend = createBackend({
      provider: name,
      model: "model",
      apiKey: "secret",
    })

    await expect(
      backend.complete({
        model: "model",
        system: "",
        messages: [],
        tools: [],
        maxOutput: 128,
      }),
    ).resolves.toBe(response)
    expect(complete).toHaveBeenCalledOnce()
  })
})
