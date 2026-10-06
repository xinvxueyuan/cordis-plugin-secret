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
import { rewriteMarkers } from './naming.ts'

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

/** Everything the binding hooks read from their host. */
export interface AttachBindingDeps extends AttachBinderDeps {
  sessionOf(agent: unknown): GrantSessionLike | undefined
}

/** One message, as the pre-step waterfall sees it. */
interface MessageLike {
  readonly role?: unknown
  readonly source?: { readonly kind?: unknown }
  readonly content?: readonly unknown[]
}

/**
 * Rewrite one message's text blocks into their model-facing form.
 *
 * Returns the original object when nothing changed, so an untouched message
 * keeps its identity and no consumer sees a spurious new value.
 */
function rewriteMessage<Message extends MessageLike>(message: Message): Message {
  const content = message.content
  if (!Array.isArray(content)) return message
  let changed = false
  const next = content.map((block) => {
    if (typeof block !== 'object' || block === null) return block
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') return block
    const text = rewriteMarkers(candidate.text)
    if (text === candidate.text) return block
    changed = true
    return { ...candidate, text }
  })
  if (!changed) return message
  return Object.freeze({ ...message, content: next })
}

/**
 * Install the two hooks that turn "the human attached a secret" into "this
 * session holds it, and this request says so".
 *
 * They are deliberately split, and deliberately independent of each other's
 * order:
 *
 * 1. **Binding** rides `session/event`. The sequence number of the message is
 *    only knowable once the message is durable, and the session service never
 *    publishes seed events, so replaying or resuming a log can never re-bind an
 *    historical marker. The grant is anchored to that exact sequence, which is
 *    what makes an edit-and-retry revoke it without any bookkeeping here.
 * 2. **Delivery** rides the `agent/pre-step` waterfall. The rewrite and the note
 *    are a pure function of the text plus the current attachment state, so the
 *    request the model sees is reproducible for the same log, and nothing about
 *    it is written back to the durable log.
 *
 * @param ctx - the plugin's Host context.
 * @param deps - the staged store, the grant store, and the session lookup.
 */
export function installAttachBinding(ctx: Context, deps: AttachBindingDeps): void {
  // 1. Bind: the marker reached a durable message of this session.
  ctx.on('session/event', (session, event) => {
    const record = event as SessionEventLike
    if (record.type !== 'user/message') return
    const seq = seqOf(record)
    if (seq === undefined) return
    for (const envVar of messageMarkers(record.data)) {
      bindStaged(deps, session as unknown as GrantSessionLike, seq, envVar)
    }
  })

  // 2. Deliver: rewrite each marker and say what it is.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const session = deps.sessionOf(payload.agent)
    const messages: typeof decision.messages = []
    const notes: BoundVariable[] = []
    let changed = false
    for (const message of decision.messages) {
      const markers = message.source.kind === 'user' ? messageMarkers(message) : []
      if (markers.length === 0) {
        messages.push(message)
        continue
      }
      changed = true
      if (session !== undefined) {
        for (const envVar of markers) {
          const known = describeVariable(deps, session, envVar)
          if (known !== undefined && !notes.some((note) => note.variable === known.variable)) {
            notes.push(known)
          }
        }
      }
      messages.push(rewriteMessage(message as unknown as MessageLike) as unknown as (typeof decision.messages)[number])
    }
    if (!changed) return decision
    if (notes.length === 0) return { ...decision, messages }
    return {
      ...decision,
      messages: [
        ...messages,
        userMessage({
          source: attachSource(notes),
          text: renderAttachNote(notes),
        }),
      ],
    }
  })
}
