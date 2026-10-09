import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AttachStore, renderAttachNote, type StagedAttach } from '../src/attach.ts'
import { GrantStore } from '../src/grants.ts'
import { installAttachBinding, noteSourcesOn, type AttachNoteReader } from '../src/inject.ts'
import { markerFor } from '../src/naming.ts'

/**
 * The admission wiring, end to end.
 *
 * The defect this file exists for is a wiring-level one: the plugin used to
 * hand the loop a rewritten copy of the human's message, and the loop appends
 * what it is handed (`dsh-agent-loop/lib/index.js:1061`) — so the durable
 * `user/message`, which is also the only thing the model request is derived
 * from (`:1262`) and the only thing the `session/event` binding hook can read,
 * no longer carried the marker. Calling a handler directly cannot show that;
 * driving the real order can.
 *
 * The loop itself is not available in-process, so this harness plays exactly
 * the loop's own steps, and nothing else, against a REAL `Session` log:
 *
 * 1. the inbox claim, handed to the `agent/pre-step` waterfall as `next()`;
 * 2. `session.append('user/message', message, { surfaceOp: 'append' })` for
 *    every message the decision carries;
 * 3. the store's synchronous `session/event` publication for that event.
 */

const SESSION_ID = 'wiring-session'
const NAME = 'openai'
const ENV_VAR = 'DSH_SECRET_OPENAI'
const SECRET = 'sk-wiring-4f9c2a-do-not-echo'

/**
 * The shipped conversation view's own reference-token scan, verbatim
 * (`dsh-client-ui-primitives/lib/index.js:6724`) — this is what
 * `projectUserText` runs over a durable user message to decide whether a token
 * becomes a reference capsule. Its `@[^\s]+` alternative is what matches a
 * marker like `@DSH_SECRET_OPENAI`.
 */
const TEXT_REF_RE = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu

/** The token the conversation view would project to a capsule, if any. */
function referenceToken(text: string): string | undefined {
  TEXT_REF_RE.lastIndex = 0
  return TEXT_REF_RE.exec(text)?.[2]
}

/** One ordinary user message, as the client submits it. */
function userMessage(id: string, text: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

function staged(input: Partial<StagedAttach> = {}): StagedAttach {
  return {
    sessionId: SESSION_ID,
    name: NAME,
    label: 'OpenAI API Key',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
    createdAt: 1,
    ...input,
  }
}

/** The loop's admission order, driven against a real session log. */
function makeLoop() {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const session = Session.create(SessionId(SESSION_ID))
  const store = new AttachStore({ ttlMs: 60_000, capacity: 4, schedule: () => () => undefined })
  const grants = new GrantStore()
  const ensured: string[] = []
  const bound: string[] = []

  installAttachBinding(
    {
      on(name: string, handler: (...args: never[]) => unknown) {
        const list = listeners.get(name) ?? []
        list.push(handler as (...args: unknown[]) => unknown)
        listeners.set(name, list)
      },
    } as never,
    {
      store,
      grants,
      envs: {
        ensure: (envVar: string) => {
          ensured.push(envVar)
        },
      },
      now: () => 1700000000000,
      sessionOf: () => session as never,
      visibleNotes: (live) => noteSourcesOn(live as unknown as AttachNoteReader),
      onBound: (attach) => {
        bound.push(attach.variable)
      },
    },
  )

  /** Append one event and publish it exactly as the store does. */
  function append(type: string, data: unknown, opts?: { surfaceOp: 'append' }): SessionEvent {
    const log = session.append as unknown as (type: string, data: unknown, opts?: unknown) => SessionEvent
    const event = log.call(session, type, data, opts)
    for (const handler of listeners.get('session/event') ?? []) handler(session, event)
    return event
  }

  return {
    session,
    store,
    grants,
    ensured,
    bound,
    append,
    /** Every durable user/message, in order. */
    durableUserMessages(): readonly SessionEvent[] {
      return session.snapshotEvents().filter((event) => event.type === 'user/message')
    },
    /** One full step of the loop: the waterfall, then the append of its decision. */
    async admit(messages: readonly Record<string, unknown>[], position = { turn: 1, step: 1 }) {
      const handlers = listeners.get('agent/pre-step') ?? []
      assert.equal(handlers.length, 1, 'exactly one pre-step hook is installed')
      const outcome = (await handlers[0]?.(
        { agent: { id: SESSION_ID }, messages, ...position, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter', messages: [...messages] }),
      )) as { messages: { id: string; source: { kind: string }; content: { type: string; text?: string }[] }[] }
      for (const message of outcome.messages) {
        append('user/message', message, { surfaceOp: 'append' })
      }
      return outcome
    },
  }
}

test('an attached secret binds on the real admission wiring and reaches the shell env', async () => {
  const loop = makeLoop()
  assert.equal(loop.store.put(staged())?.replaced, false)

  const text = `请用 ${markerFor(ENV_VAR)} 跑测试`
  const outcome = await loop.admit([userMessage('m-1', text)])

  // (b) The core promise first: the attached variable is bound to this very
  // message, its contributor is declared, and the staged record is consumed.
  const durable = loop.durableUserMessages()
  const anchorSeq = durable[0]?.seq
  assert.equal(typeof anchorSeq, 'number')
  assert.equal(loop.grants.valueFor(loop.session as never, ENV_VAR), SECRET, 'the attached variable reached the shell env')
  assert.equal(loop.grants.resolve(loop.session as never, NAME).grant?.anchorSeq, anchorSeq)
  assert.deepEqual(loop.ensured, [ENV_VAR])
  assert.deepEqual(loop.bound, [ENV_VAR])
  assert.equal(loop.store.size, 0, 'the staged record was consumed, not left staged')

  // (c) The durable record keeps the form the human's client sent and the
  // conversation view projects to a variable-name capsule.
  assert.equal(durable.length, 2, 'the human message plus one injected note')
  const stored = durable[0]?.data as { id: string; content: { text: string }[] }
  assert.equal(stored.id, 'm-1', 'the admitted message keeps the identity the client sent')
  assert.equal(stored.content[0]?.text, text, 'the durable text is not rewritten')
  assert.equal(referenceToken(text), markerFor(ENV_VAR), 'the client would project exactly this token to a capsule')

  // (a) The model-visible batch states the correspondence literally, and only
  // the note is added: the human's own message is admitted unchanged.
  assert.equal(outcome.messages[0]?.id, 'm-1')
  assert.equal(outcome.messages[0]?.content[0]?.text, text)
  const note = outcome.messages.at(-1)
  assert.equal(note?.source.kind, 'secret-attach')
  const noteText = note?.content[0]?.text ?? ''
  assert.equal(noteText.includes(`- ${ENV_VAR} · 仅本次会话有效`), true)
  assert.equal(noteText.includes(`正文里的 @${ENV_VAR} 即该变量，模型侧写作 [secret ${ENV_VAR}]；它不是文件路径。`), true)
  assert.equal(JSON.stringify(outcome).includes(SECRET), false, 'the value reached the model request')

  // The note is durable too, so the transcript shows it as an injected row.
  assert.equal(loop.durableUserMessages().length, 2)
  assert.equal((loop.durableUserMessages()[1]?.data as { source: { kind: string } }).source.kind, 'secret-attach')
})

test('a marker-free admitted body cannot bind: that is the defect this wiring test guards', async () => {
  const loop = makeLoop()
  loop.store.put(staged())

  // The shipped-before shape: the loop was handed (and logged) the rewritten
  // copy, so the admission event the binding hook reads no longer has a marker.
  const rewritten = '请用 [secret DSH_SECRET_OPENAI] 跑测试'
  loop.append('user/message', userMessage('m-1', rewritten), { surfaceOp: 'append' })

  assert.equal(loop.grants.valueFor(loop.session as never, ENV_VAR), undefined)
  assert.deepEqual(loop.ensured, [])
  assert.deepEqual(loop.bound, [])
  assert.equal(loop.store.size, 1, 'the staged record stays staged forever in that shape')
})

test('the note is written once per attachment, not once per step', async () => {
  const loop = makeLoop()
  loop.store.put(staged())

  const first = await loop.admit([userMessage('m-1', `请用 ${markerFor(ENV_VAR)} 跑测试`)])
  assert.equal(first.messages.length, 2, 'one note beside the admitted message')

  // A later message may legitimately cite the same (already bound) variable; the
  // identical note is already on the model-visible surface, so it is not stacked.
  const second = await loop.admit([userMessage('m-2', `再用 ${markerFor(ENV_VAR)} 一次`)], { turn: 2, step: 1 })
  assert.equal(second.messages.length, 1, 'the identical note is not repeated')
  assert.equal(second.messages[0]?.id, 'm-2')
  assert.equal(loop.durableUserMessages().length, 3, 'message, note, message')
})

test('a step without markers adds nothing at all', async () => {
  const loop = makeLoop()
  loop.store.put(staged())
  const outcome = await loop.admit([userMessage('m-1', '普通的一句话')])
  assert.equal(outcome.messages.length, 1)
  assert.equal(loop.durableUserMessages().length, 1)
  assert.equal(loop.store.size, 1, 'the staged record is untouched')
  assert.deepEqual(loop.ensured, [])
})

test('the note names the marker in prose, and that prose never binds anything', async () => {
  const loop = makeLoop()
  loop.store.put(staged())

  // A note-shaped message whose body *names* the marker (exactly what the plugin
  // injects) must not be read as a carrier by the binding hook: the value it
  // would bind belongs to the human's message, not to our own prose.
  const note = renderAttachNote([{ variable: ENV_VAR, name: NAME, scope: 'session' }])
  assert.equal(note.includes(`正文里的 @${ENV_VAR} 即该变量`), true)
  loop.append(
    'user/message',
    {
      id: 'n-1',
      role: 'user',
      source: { kind: 'secret-attach', form: 'instructions', version: 1, variables: [{ variable: ENV_VAR, name: NAME, scope: 'session' }] },
      content: [{ type: 'text', text: note }],
    },
    { surfaceOp: 'append' },
  )
  assert.equal(loop.grants.valueFor(loop.session as never, ENV_VAR), undefined)
  assert.equal(loop.store.size, 1, 'the staged record is still waiting for the human message')

  // The human's own message then binds it, once.
  await loop.admit([userMessage('m-1', `请用 ${markerFor(ENV_VAR)} 跑测试`)])
  assert.equal(loop.grants.valueFor(loop.session as never, ENV_VAR), SECRET)
  assert.deepEqual(loop.ensured, [ENV_VAR])
  assert.equal(loop.store.size, 0)
})
