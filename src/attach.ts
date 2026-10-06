import type { GrantStore, GrantSessionLike } from './grants.ts'
import { markerFor, modelFormFor, parseMarkers } from './naming.ts'
import type { SecretScope } from './types.ts'

/**
 * One secret a human attached to the conversation, waiting for the message that
 * carries it.
 *
 * This is the *staged* half of the two-phase lifecycle: the value is here (it
 * has to be — the human typed it and the agent must be able to read it later),
 * but nothing is injected and no grant exists until the marker reaches a durable
 * user message. A staged attach that is never sent is dropped by its TTL or by
 * the end of its session, and nothing was ever exposed.
 */
export interface StagedAttach {
  readonly sessionId: string
  /** Credential key: lowercase kebab/snake. */
  readonly name: string
  /** Human-facing title shown by the capsule and the injected note. */
  readonly label: string
  readonly scope: SecretScope
  /** Exposed variable name (`DSH_SECRET_*`). */
  readonly envVar: string
  /** The value the human typed. Never logged, echoed, or returned. */
  readonly value: string
  readonly createdAt: number
}

/** Timer seam so tests never depend on the wall clock (mirrors `Scheduler`). */
export type AttachScheduler = (delayMs: number, callback: () => void) => () => void

/** Everything the staged store needs from its host. */
export interface AttachStoreDeps {
  /** How long a staged attach waits before it is dropped. */
  readonly ttlMs: number
  /** How many staged attaches one session may hold. */
  readonly capacity: number
  readonly schedule: AttachScheduler
}

/** The result of staging one attach. */
export interface StagedWrite {
  readonly attach: StagedAttach
  /** True when this replaced an earlier attach for the same exposed variable. */
  readonly replaced: boolean
}

/**
 * In-memory, session-scoped staged attaches.
 *
 * Nothing here is persisted, and nothing here is a grant: `valueFor` on the
 * grant store cannot see a staged entry, so a value that never reached a
 * message can never be injected into a shell.
 */
export class AttachStore {
  private readonly items = new Map<string, StagedAttach>()
  private readonly timers = new Map<string, () => void>()
  private readonly deps: AttachStoreDeps

  constructor(deps: AttachStoreDeps) {
    this.deps = deps
  }

  /** Number of staged attaches across every session (diagnostics and tests). */
  get size(): number {
    return this.items.size
  }

  /** How many staged attaches one session currently holds. */
  countFor(sessionId: string): number {
    let count = 0
    for (const item of this.items.values()) {
      if (item.sessionId === sessionId) count += 1
    }
    return count
  }

  /**
   * Stage one attach.
   * @returns the stored entry, or undefined at this session's capacity.
   */
  put(input: StagedAttach): StagedWrite | undefined {
    const key = pairKey(input.sessionId, input.envVar)
    const replaced = this.items.has(key)
    if (!replaced && this.countFor(input.sessionId) >= this.deps.capacity) return undefined
    const stored: StagedAttach = { ...input }
    this.clearTimer(key)
    this.items.set(key, stored)
    this.timers.set(
      key,
      this.deps.schedule(this.deps.ttlMs, () => {
        // A replacement installed a new entry under the same key: only the
        // entry this timer was armed for may be dropped.
        if (this.items.get(key) === stored) this.drop(key)
      }),
    )
    return { attach: stored, replaced }
  }

  /** One staged attach, or undefined. */
  get(sessionId: string, envVar: string): StagedAttach | undefined {
    return this.items.get(pairKey(sessionId, envVar))
  }

  /** Every staged attach of one session, oldest first. */
  list(sessionId: string): readonly StagedAttach[] {
    return [...this.items.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Drop one staged attach. Returns whether it was there. */
  remove(sessionId: string, envVar: string): boolean {
    const key = pairKey(sessionId, envVar)
    if (!this.items.has(key)) return false
    this.drop(key)
    return true
  }

  /** Drop every staged attach of one session (session end). */
  forget(sessionId: string): number {
    let dropped = 0
    for (const [key, item] of [...this.items]) {
      if (item.sessionId !== sessionId) continue
      this.drop(key)
      dropped += 1
    }
    return dropped
  }

  /** Drop everything and cancel every timer (plugin unload). */
  disposeAll(): void {
    for (const key of [...this.timers.keys()]) this.clearTimer(key)
    this.items.clear()
  }

  private drop(key: string): void {
    this.clearTimer(key)
    this.items.delete(key)
  }

  private clearTimer(key: string): void {
    const cancel = this.timers.get(key)
    if (cancel === undefined) return
    this.timers.delete(key)
    cancel()
  }
}

/** One attached variable as the injected note and the capsule describe it. */
export interface BoundVariable {
  readonly variable: string
  readonly name: string
  readonly scope: SecretScope
}

/** One attachment that has reached a message, with the metadata the capsule shows. */
export interface BoundAttach extends BoundVariable {
  readonly label: string
  readonly createdAt: number
  readonly sessionId: string
}

/** Everything promoting a staged attach needs. */
export interface AttachBinderDeps {
  readonly store: AttachStore
  readonly grants: GrantStore
  readonly envs: { ensure(envVar: string): void }
  now(): number
  /** Reported once per promotion, so the capsule can still describe the entry. */
  onBound?(attach: BoundAttach): void
}

/** `仅本次会话有效` / `持久保存到凭据库`, the wording both surfaces share. */
export function scopeLabel(scope: SecretScope): string {
  return scope === 'persistent' ? '持久保存到凭据库' : '仅本次会话有效'
}

/**
 * Promote one staged attach into a session grant anchored at one message.
 *
 * The anchor is what makes "bound to this message" real rather than a slogan:
 * the grant store re-derives validity from the live surface on every read, so
 * an edit-and-retry that rewrites the message away revokes the exposure without
 * any bookkeeping here.
 *
 * Order matters. The `shellEnv` contributor is declared **before** the grant is
 * recorded and the staged entry is consumed, so a registry failure leaves the
 * session exactly as it was (no grant, nothing consumed, the staged entry still
 * armed for a later attempt). The reverse order would leave a grant with no
 * contributor and an unconsumed staged entry — an exposure that silently never
 * injects. In the other direction a recorded grant whose contributor
 * registration failed for an unrelated reason is harmless: the resolver asks
 * `valueFor`, so a missing contributor injects nothing (fail-closed) while the
 * staged entry stays consumed.
 *
 * @returns the bound variable, or undefined when nothing was staged for it.
 */
export function bindStaged(
  deps: AttachBinderDeps,
  session: GrantSessionLike,
  seq: number,
  envVar: string,
): BoundAttach | undefined {
  const sessionId = String(session.id)
  const staged = deps.store.get(sessionId, envVar)
  if (staged === undefined) return undefined
  deps.envs.ensure(staged.envVar)
  deps.grants.put({
    sessionId,
    name: staged.name,
    envVar: staged.envVar,
    scope: staged.scope,
    value: staged.value,
    source: 'entered',
    anchorSeq: seq,
    replaceGenerationAtApproval: session.surface.replaceGeneration,
    authorizedAt: deps.now(),
  })
  // Consuming the staged entry is what makes binding idempotent: whichever hook
  // gets there first wins, and the other finds nothing to do.
  deps.store.remove(sessionId, staged.envVar)
  const bound: BoundAttach = {
    sessionId,
    variable: staged.envVar,
    name: staged.name,
    label: staged.label,
    scope: staged.scope,
    createdAt: staged.createdAt,
  }
  deps.onBound?.(bound)
  return bound
}

/**
 * Describe one attached variable for the injected note: a staged entry, or a
 * grant this session still holds. Neither knows anything about the value.
 */
export function describeVariable(
  deps: AttachBinderDeps,
  session: GrantSessionLike,
  envVar: string,
): BoundVariable | undefined {
  const staged = deps.store.get(String(session.id), envVar)
  if (staged !== undefined) {
    return { variable: staged.envVar, name: staged.name, scope: staged.scope }
  }
  for (const name of deps.grants.namesForEnvVar(envVar)) {
    const lookup = deps.grants.resolve(session, name)
    if (lookup.code === 'ok' && lookup.grant !== undefined) {
      return { variable: envVar, name: lookup.grant.name, scope: lookup.grant.scope }
    }
  }
  return undefined
}

/** One recorded session event, as the durable-log hooks see it. */
export interface SessionEventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
}

function contentBlocks(data: unknown): readonly unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { content?: unknown; message?: unknown }
  if (Array.isArray(record.content)) return record.content
  // Defensive: an event payload that wrapped its message one level down reads
  // the same way, so neither shape can silently hide a marker.
  const nested = record.message
  if (typeof nested === 'object' && nested !== null && Array.isArray((nested as { content?: unknown }).content)) {
    return (nested as { content: readonly unknown[] }).content
  }
  return undefined
}

/** The text blocks of one message payload, in order. */
export function messageTextBlocks(data: unknown): readonly string[] {
  const blocks = contentBlocks(data)
  if (blocks === undefined) return []
  const texts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts
}

/** Every attached-secret marker one message payload carries, in first-seen order. */
export function messageMarkers(data: unknown): readonly string[] {
  const found: string[] = []
  for (const text of messageTextBlocks(data)) {
    for (const envVar of parseMarkers(text)) {
      if (!found.includes(envVar)) found.push(envVar)
    }
  }
  return found
}

/** Read one recorded event's sequence number, or undefined. */
export function seqOf(event: SessionEventLike): number | undefined {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : undefined
}

/**
 * The value-free note injected beside a message that carried attachments.
 *
 * It names the variables and how to read them, and it says out loud the two
 * things the surrounding prompt would otherwise get wrong: what the marker in
 * the message body *is*, and that it is not a file path.
 *
 * The mapping line is the model-facing rewrite. The harness derives every model
 * request from the durable log, so the message body keeps the marker form the
 * human's client sent (which is also the form the conversation view projects to
 * a variable-name capsule); the rewrite therefore rides this note, which states
 * the correspondence per variable, literally.
 */
export function renderAttachNote(notes: readonly BoundVariable[]): string {
  if (notes.length === 0) return ''
  const heading = `本条消息附带 ${String(notes.length)} 个由人类主动提供的密钥；明文不进入对话，只能按变量名取用。`
  const bullets = notes.map((note) => `- ${note.variable} · ${scopeLabel(note.scope)}`)
  const mappings = notes.map(
    (note) => `正文里的 ${markerFor(note.variable)} 即该变量，模型侧写作 ${modelFormFor(note.variable)}；它不是文件路径。`,
  )
  const reads = notes.map((note) => `PowerShell 用 $env:${note.variable}，POSIX shell 用 "$${note.variable}"`).join('；')
  return [
    heading,
    ...bullets,
    ...mappings,
    '',
    `取用方式：${reads}。`,
    '不要把该标记当作文件路径读取。',
  ].join('\n')
}

/** The durable, value-free source of the injected note. */
export interface SecretAttachSource {
  readonly kind: 'secret-attach'
  readonly form: 'instructions'
  readonly version: 1
  readonly variables: readonly BoundVariable[]
}

/** The durable source of one injected attach note. Carries names, never values. */
export function attachSource(notes: readonly BoundVariable[]): SecretAttachSource {
  return {
    kind: 'secret-attach',
    form: 'instructions',
    version: 1,
    variables: notes.map((note) => ({ variable: note.variable, name: note.name, scope: note.scope })),
  }
}

function pairKey(sessionId: string, envVar: string): string {
  return `${sessionId}\u0000${envVar}`
}
