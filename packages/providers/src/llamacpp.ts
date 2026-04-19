import OpenAI from "openai"
import type {
  Response as OAIResponse,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses.js"
import { OpenAICompletionBackend } from "./openai.js"
import { wrapSdkError } from "@ronde/backend"
import type { ProviderDescriptor } from "./registry.js"

export const llamacppDescriptor: ProviderDescriptor = {
  name: "llamacpp",
  defaultURL: "http://127.0.0.1:8000/v1",
  envVar: null,
  create: (config) => new LlamaCppCompletionBackend(config),
}

/**
 * OpenAI-compatible Responses API without streaming — llama-server's SSE
 * format is not fully compatible with the OpenAI SDK's stream accumulator.
 */
export class LlamaCppCompletionBackend extends OpenAICompletionBackend {
  protected override buildProviderMeta(response: OAIResponse): unknown {
    return {
      provider: "llamacpp",
      responseId: response.id,
      status: response.status ?? null,
      incompleteReason: response.incomplete_details?.reason ?? null,
    }
  }

  protected override serializeOptions(): {
    replayReasoningItems: boolean
  } {
    return { replayReasoningItems: false }
  }

  protected override async doRequest(
    client: OpenAI,
    payload: Record<string, unknown>,
  ): Promise<OAIResponse> {
    try {
      const response = await client.responses.create(
        payload as unknown as ResponseCreateParamsNonStreaming,
      )
      return response
    } catch (err) {
      throw wrapSdkError(err)
    }
  }
}
