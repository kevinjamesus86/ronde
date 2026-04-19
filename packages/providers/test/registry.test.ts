import { describe, expect, it } from "vitest"
import { getProvider, allProviders, registerProvider } from "../src/registry.js"

describe("@ronde/providers registry", () => {
  it("registers provider descriptors by name", () => {
    const name = `test-${Date.now()}-register`
    const descriptor = {
      name,
      defaultURL: "https://example.test",
      envVar: "TEST_API_KEY",
      create: () => ({
        specVersion: "v1" as const,
        complete: async () => {
          throw new Error("not implemented")
        },
      }),
    }

    registerProvider(descriptor)

    expect(getProvider(name)).toBe(descriptor)
  })

  it("lets later registrations replace the same provider name", () => {
    const name = `test-${Date.now()}-replace`
    const first = {
      name,
      defaultURL: "https://one.test",
      envVar: null,
      create: () => ({
        specVersion: "v1" as const,
        complete: async () => {
          throw new Error("first")
        },
      }),
    }
    const second = {
      ...first,
      defaultURL: "https://two.test",
    }

    registerProvider(first)
    registerProvider(second)

    expect(getProvider(name)).toBe(second)
  })

  it("returns undefined for unknown providers", () => {
    expect(getProvider("__does_not_exist__")).toBeUndefined()
  })

  it("exposes built-in providers through allProviders()", () => {
    const names = [...allProviders()].map((provider) => provider.name)

    expect(names).toEqual(
      expect.arrayContaining(["openai", "anthropic", "gemini", "llamacpp"]),
    )
  })

  it("exposes built-in providers through getProvider() at module load", () => {
    expect(getProvider("openai")?.envVar).toBe("OPENAI_API_KEY")
    expect(getProvider("anthropic")?.envVar).toBe("ANTHROPIC_API_KEY")
    expect(getProvider("gemini")?.envVar).toBe("GEMINI_API_KEY")
    expect(getProvider("llamacpp")?.envVar).toBeNull()
  })
})
