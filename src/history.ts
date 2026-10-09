import type { SecretHistoryEntry } from './types.ts'

/** Everything the history store needs from its host. */
export interface HistoryStoreDeps {
  /** How many entries one session may keep; the oldest are dropped first. */
  readonly capacity: number
}

/**
 * In-memory, session-scoped attachment/authorization history.
 *
 * This is the one data class the capsule's history area reads. It exists because
 * nothing else in this plugin remembers the past: a staged entry is deleted when
 * it is released, a bound entry is dropped the moment its grant stops resolving,
 * and a TTL expiry leaves no trace. Everything here is value-free — an entry
 * names a variable and says what happened to it, and there is no field a value
 * could travel in.
 *
 * The store is deliberately *not* durable and deliberately not rebuilt from the
 * session log: after a Host restart, on a replayed session, or in a forked child
 * the history is empty, and the plugin says so rather than reconstructing a past
 * it did not observe.
 */
export class HistoryStore {
  private readonly items = new Map<string, SecretHistoryEntry[]>()
  private readonly deps: HistoryStoreDeps

  constructor(deps: HistoryStoreDeps) {
    this.deps = deps
  }

  /** Number of sessions with at least one entry (diagnostics and tests). */
  get size(): number {
    return this.items.size
  }

  /** Record one transition, dropping the session's oldest entry at capacity. */
  push(sessionId: string, entry: SecretHistoryEntry): void {
    const list = this.items.get(sessionId)
    if (list === undefined) {
      this.items.set(sessionId, [entry])
      return
    }
    list.push(entry)
    const overflow = list.length - this.deps.capacity
    if (overflow > 0) list.splice(0, overflow)
  }

  /** One session's entries, newest first. */
  list(sessionId: string): readonly SecretHistoryEntry[] {
    return [...(this.items.get(sessionId) ?? [])].reverse()
  }

  /**
   * The newest entry of one session that names one variable, or undefined.
   *
   * A transition that reports no facts of its own (a TTL expiry, a revoked
   * anchor) inherits the name, label and scope of the variable's last recorded
   * state instead of inventing them — and when there is no such entry, the
   * transition is simply not recorded rather than recorded as a half-truth.
   */
  latest(sessionId: string, variable: string): SecretHistoryEntry | undefined {
    const list = this.items.get(sessionId)
    if (list === undefined) return undefined
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]
      if (entry !== undefined && entry.variable === variable) return entry
    }
    return undefined
  }

  /** Drop one session's history (session end). */
  forget(sessionId: string): void {
    this.items.delete(sessionId)
  }

  /** Drop everything (plugin unload). */
  disposeAll(): void {
    this.items.clear()
  }
}
