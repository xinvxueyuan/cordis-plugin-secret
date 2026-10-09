import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  attachSource,
  bindStaged,
  describeVariable,
  messageMarkers,
  renderAttachNote,
  seqOf,
  type AttachBinderDeps,
  type BoundVariable,
  type SecretAttachSource,
  type SessionEventLike,
} from './attach.ts'
import type { GrantSessionLike } from './grants.ts'

/**
 * The value-free note this plugin injects is a first-class message source, so a
 * transcript consumer can present it from metadata instead of re-parsing the
 * model-facing text.
 *
 * This is a type-level merge only: nothing here imports the package at runtime.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'secret-attach': SecretAttachSource
  }
}

/** Freeze a value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/**
 * Mint one identified, deeply frozen user message.
 *
 * The shape is the harness's own contract — the same one
 * `createUserMessage` produces (a fresh UUID identity, a detached copy, deep
 * freeze) — built here rather than imported, so the Host half gains no runtime
 * dependency on a package the profile may not resolve from a plugin directory.
 */
function userMessage(input: {
  readonly source: SecretAttachSource
  readonly text: string
}): UserMessage {
  return deepFreeze(
    structuredClone({
      id: globalThis.crypto.randomUUID(),
      role: 'user' as const,
      source: input.source,
      content: [{ type: 'text' as const, text: input.text }],
    }),
  ) as unknown as UserMessage
}

/** One session, as the note-dedupe pass reads it. */
export interface AttachNoteReader {
  /** Model-visible surface event sequences, in order. */
  readonly surface: { readonly nodes: readonly number[] }
  /** One logged event by sequence, or undefined. */
  eventAt(seq: number): { readonly type?: unknown; readonly data?: unknown } | undefined
}

/** Everything the two hooks read from their host. */
export interface AttachBindingDeps extends AttachBinderDeps {
  sessionOf(agent: unknown): GrantSessionLike | undefined
  /**
   * The attach notes already on this session's model-visible surface.
   *
   * Optional: without it the note is simply never deduplicated, which is safe
   * (a duplicate note is value-free) but noisy.
   */
  visibleNotes?(session: GrantSessionLike): readonly SecretAttachSource[]
}

/** Every attach note already present on one session's model-visible surface. */
export function noteSourcesOn(session: AttachNoteReader): readonly SecretAttachSource[] {
  const found: SecretAttachSource[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'user/message') continue
    const source = (event.data as { readonly source?: unknown } | undefined)?.source
    if (typeof source !== 'object' || source === null) continue
    if ((source as { readonly kind?: unknown }).kind !== 'secret-attach') continue
    found.push(source as SecretAttachSource)
  }
  return found
}

/** Whether one attach note is already visible, compared by its value-free source. */
function noteVisible(
  deps: AttachBindingDeps,
  session: GrantSessionLike,
  source: SecretAttachSource,
): boolean {
  const visible = deps.visibleNotes?.(session)
  if (visible === undefined) return false
  const key = JSON.stringify(source)
  for (const candidate of visible) {
    if (candidate.kind !== 'secret-attach') continue
    if (JSON.stringify(candidate) === key) return true
  }
  return false
}

/** Whether one recorded payload is this plugin's own injected note. */
function isAttachNote(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { readonly source?: unknown }).source
  return typeof source === 'object' && source !== null && (source as { readonly kind?: unknown }).kind === 'secret-attach'
}

/**
 * Install the two hooks that turn "the human attached a secret" into "this
 * session holds it, and this request says so".
 *
 * 1. **Binding** rides `session/event`. The sequence number of the message is
 *    only knowable once the message is durable, and the session service never
 *    publishes seed events, so replaying or resuming a log can never re-bind an
 *    historical marker. The grant is anchored to that exact sequence, which is
 *    what makes an edit-and-retry revoke it without any bookkeeping here.
 * 2. **Delivery** rides the `agent/pre-step` waterfall: it appends one
 *    value-free note per admitted batch that carries markers.
 *
 * ## Why the user's own message is NOT rewritten here
 *
 * The admission path makes "rewrite the model-facing text without touching the
 * durable log" impossible, so this plugin does not pretend otherwise:
 *
 * - `agent/pre-step` output *is* the durable record. The loop appends every
 *   returned message verbatim as `user/message` with `surfaceOp: 'append'`
 *   (`dsh-agent-loop/lib/index.js:1061`), and the model request for the same
 *   step is derived from that same surface (`:1262`). A rewrite here therefore
 *   lands in the log, and the log is what the conversation view renders.
 * - The model input is by contract a pure function of the log: a loop-built
 *   request is deep-frozen and `llm/stream` listeners "read it, never rewrite
 *   it" (`dsh-llm/lib/types/index.d.ts:37-45`).
 * - The one mechanism that *can* keep a model-only copy (a surface replacement
 *   or a message-projection event) has to be appended *after* its target, and
 *   there is no hook between the loop's append and its request build; appending
 *   the target ourselves first would move the human's message in front of the
 *   step's own `system/message` commit. Self-appended events would also have to
 *   carry a type the persisted-log reader accepts (`dsh-session-persistence/
 *   lib/index.js:184`), which an out-of-tree plugin cannot.
 *
 * So the marker stays in the log in the exact form the human's client sent and
 * the conversation view parses (`@DSH_SECRET_*` — the shipped `projectUserText`
 * projects it to a variable-name capsule), and the model-facing rewrite is
 * delivered by the note, which states per variable that the marker *is* that
 * variable and writes its model-side notation `[secret DSH_SECRET_*]`.
 *
 * @param ctx - the plugin's Host context.
 * @param deps - the staged store, the grant store, and the session lookup.
 */
export function installAttachBinding(ctx: Context, deps: AttachBindingDeps): void {
  // 1. Bind: the marker reached a durable message of this session.
  ctx.on('session/event', (session, event) => {
    const record = event as SessionEventLike
    if (record.type !== 'user/message') return
    // Our own note *names* the marker in its prose, so it must never be read as
    // a carrier: only a message the human's client submitted can bind.
    if (isAttachNote(record.data)) return
    const seq = seqOf(record)
    if (seq === undefined) return
    for (const envVar of messageMarkers(record.data)) {
      bindStaged(deps, session as unknown as GrantSessionLike, seq, envVar)
    }
  })

  // 2. Deliver: say what the markers in this batch are.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const session = deps.sessionOf(payload.agent)
    if (session === undefined) return decision
    const notes: BoundVariable[] = []
    for (const message of decision.messages) {
      if (message.source.kind !== 'user') continue
      for (const envVar of messageMarkers(message)) {
        const known = describeVariable(deps, session, envVar)
        if (known !== undefined && !notes.some((note) => note.variable === known.variable)) {
          notes.push(known)
        }
      }
    }
    if (notes.length === 0) return decision
    const source = attachSource(notes)
    // The note is durable (see above), so a step that re-admits the same
    // markers must not stack another copy: an identical note already on the
    // model-visible surface is the same statement said twice.
    if (noteVisible(deps, session, source)) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        userMessage({
          source,
          text: renderAttachNote(notes),
        }),
      ],
    }
  })
}
