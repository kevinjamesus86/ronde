import { genHex, genId } from "@ronde/core/id"
import {
  Workspace,
  sanitizeFilename,
  makePreview,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"

export class MemoryWorkspace extends Workspace {
  readonly kind = "memory" as const
  readonly resources = new Map<string, string>()

  constructor(readonly id = genId("rt")) {
    super()
  }

  async spill(content: string, o: SpillOpts = {}): Promise<SpillResult> {
    const base = sanitizeFilename(o.name ?? "") || `spill-${genHex()}`
    const uri = `memory://workspace/${this.id}/${base}.txt`
    this.resources.set(uri, content)

    const head = o.previewHead ?? 2000
    const tail = o.previewTail ?? 1000
    return {
      uri,
      preview: makePreview(content, head, tail),
      truncated: content.length > head + tail,
      bytes: new TextEncoder().encode(content).length,
    }
  }

  read(uri: string): string | undefined {
    return this.resources.get(uri)
  }
}

export function memoryWorkspace(id?: string): MemoryWorkspace {
  return new MemoryWorkspace(id)
}
