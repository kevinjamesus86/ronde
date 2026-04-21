import { Journal, JournalEvent } from "@ronde/core/journal"
import type { Message } from "@ronde/core/message"
import type { Runtime } from "@ronde/core/runtime"
import type { Workspace } from "@ronde/core/workspace"
import {
  createRuntime,
  openRuntime,
  type ManagedRuntimeOptions,
} from "./managed.js"

/**
 * Runtime-lifecycle inputs a caller can pass into the agentic surface.
 * Structural subset of `AgenticConfig`; typed locally so this module
 * doesn't import back from `api.ts`.
 */
export interface Input<W extends Workspace> {
  resume?: string | ManagedRuntimeOptions
  messages?: Message[]
  journal?: Journal
  workspace?: W
}

export async function prepare<W extends Workspace>(
  config: Input<W>,
): Promise<{
  journal: Journal
  workspace: W
}> {
  // `resume`, `messages`, and explicit `journal`/`workspace` are
  // pairwise exclusive — each leaves the journal with a different
  // history, and combining them would silently pick one.
  if (config.resume && config.messages) {
    throw new Error(
      'Pass either "resume" or "messages", not both. Use replay() to inspect durable history separately.',
    )
  }
  if (config.resume && (config.journal || config.workspace)) {
    throw new Error(
      'Pass either "resume" or explicit "journal" + "workspace", not both.',
    )
  }
  if (config.messages && (config.journal || config.workspace)) {
    throw new Error(
      'Pass either caller-owned "messages" or explicit "journal" + "workspace", not both. Use hydrate() to seed a provided runtime pair.',
    )
  }

  if (config.resume) {
    const resumed = await openRuntime(config.resume)
    return {
      journal: resumed.journal,
      workspace: resumed.workspace as unknown as W,
    }
  }

  const { journal, workspace } = await ensure({
    journal: config.journal,
    workspace: config.workspace,
  })

  // `EngineConfig` deliberately has no in-memory message list — the
  // agentic surface seeds them into the journal instead so replay
  // reconstructs them like any other turn.
  if (config.messages && config.messages.length > 0) {
    await seed(journal, config.messages)
  }

  return {
    journal,
    workspace: workspace as W,
  }
}

export async function ensure(
  opts:
    | Runtime
    | ManagedRuntimeOptions
    | {
        journal?: Journal
        workspace?: Workspace
      },
): Promise<Runtime> {
  if (isRuntime(opts)) {
    return { journal: opts.journal, workspace: opts.workspace }
  }

  const journal = "journal" in opts ? opts.journal : undefined
  const workspace = "workspace" in opts ? opts.workspace : undefined
  if (journal && workspace) {
    return { journal, workspace }
  }
  if (journal || workspace) {
    throw new Error(
      'Pass both "journal" and "workspace", or neither and let ronde create the default pair.',
    )
  }

  return createRuntime(isManagedRuntimeOptions(opts) ? opts : {})
}

export async function seed(
  journal: Journal,
  messages: Message[],
): Promise<void> {
  for (const message of messages) {
    await journal.event(JournalEvent.message(message))
  }
  if (messages.length > 0) {
    await journal.commit()
  }
}

function isRuntime(
  value:
    | Runtime
    | ManagedRuntimeOptions
    | {
        journal?: Journal
        workspace?: Workspace
      },
): value is Runtime {
  return (
    typeof value === "object" &&
    value !== null &&
    "journal" in value &&
    "workspace" in value &&
    value.journal !== undefined &&
    value.workspace !== undefined
  )
}

function isManagedRuntimeOptions(
  value:
    | Runtime
    | ManagedRuntimeOptions
    | {
        journal?: Journal
        workspace?: Workspace
      },
): value is ManagedRuntimeOptions {
  return !("journal" in value) && !("workspace" in value)
}
