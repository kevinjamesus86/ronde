import { genId } from "@ronde/core/id"
import { Journal } from "@ronde/core/journal"
import type { JournalSink, JournalEvent } from "@ronde/core/journal"

export class MemoryJournal extends Journal {
  readonly kind = "memory" as const
  readonly generations: { reason: string | null; events: JournalEvent[] }[] = [
    { reason: null, events: [] },
  ]
  private activeGeneration = 0

  constructor(readonly id = genId("rt")) {
    super()
  }

  async event(event: JournalEvent): Promise<void> {
    this.generations[this.activeGeneration]!.events.push(event)
  }

  async partition(
    reason: string,
    nextEvents: readonly JournalEvent[] = [],
  ): Promise<void> {
    this.generations.push({ reason, events: [...nextEvents] })
    this.activeGeneration = this.generations.length - 1
  }

  async scan(onEvent: JournalSink): Promise<void> {
    for (const event of this.generations[this.activeGeneration]!.events) {
      if (await onEvent(event)) {
        return
      }
    }
  }
}

export function memoryJournal(id?: string): MemoryJournal {
  return new MemoryJournal(id)
}
