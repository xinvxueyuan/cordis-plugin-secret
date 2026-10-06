/**
 * Host-half tests for the reverse direction: a secret the human attaches to
 * their own message.
 *
 * The sentinel value below is the only secret in this file. It exists to prove
 * the two things this feature must never do: expose the value before its
 * message is durable, and let the value reach any surface other than the shell
 * environment of the session that was granted it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AttachStore,
  attachSource,
  bindStaged,
  describeVariable,
  messageMarkers,
  renderAttachNote,
} from '../src/attach.ts'
import { GrantStore } from '../src/grants.ts'
import { installAttachBinding } from '../src/inject.ts'
import { markerFor, modelFormFor, parseMarkers, rewriteMarkers } from '../src/naming.ts'
import { attachedSessionId, parseAttach, parseRelease } from '../src/protocol.ts'
import { SecretService } from '../src/service.ts'

const SECRET = 'sk-attach-DO-NOT-LEAK'
const ENV_VAR = 'DSH_SECRET_OPENAI'
const SESSION_ID = 'session-root'

/** Minimal scripted session satisfying every structural contract the plugin reads. */
class FakeSession {
  readonly id: string
  readonly ownFrom: number
  nodes: number[] = []
  replaceGeneration = 0
  events: { type: string; seq: number; data?: unknown }[] = []

  constructor(id: string, ownFrom = 0) {
    this.id = id
    this.ownFrom = ownFrom
  }

  get seq(): number {
    return this.events.length
  }

  get surface(): { nodes: readonly number[]; replaceGeneration: number } {
    return { nodes: this.nodes, replaceGeneration: this.replaceGeneration }
  }

  isOwnSeq(seq: number): boolean {
    return seq >= this.ownFrom && seq < this.seq
  }

  snapshotEvents(): readonly { type: string; seq: number; data?: unknown }[] {
    return this.events
  }
}

/** A session whose log holds one durable user message carrying the marker. */
function sessionWithMarker(seq = 3, id = SESSION_ID): FakeSession {
  const session = new FakeSession(id)
  session.events = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'go' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { content: [] } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'user/message', seq, data: { content: [{ type: 'text', text: `请用 ${markerFor(ENV_VAR)} 跑测试` }] } },
    { type: 'turn/end', seq: 4, data: {} },
  ]
  session.nodes = [0, 1, 3]
  return session
}

/** One staged store a test can drive without a clock. */
function makeStore(options: { ttlMs?: number; capacity?: number } = {}): {
  readonly store: AttachStore
  readonly timers: { id: number; fire: () => void }[]
  fireAll(): void
} {
  const timers: { id: number; fire: () => void }[] = []
  let next = 0
  const store = new AttachStore({
    ttlMs: options.ttlMs ?? 1800000,
    capacity: options.capacity ?? 8,
    schedule: (_delayMs, callback) => {
      const entry = { id: (next += 1), fire: callback }
      timers.push(entry)
      return () => {
        const at = timers.indexOf(entry)
        if (at >= 0) timers.splice(at, 1)
      }
    },
  })
  return {
    store,
    timers,
    fireAll() {
      for (const timer of [...timers]) timer.fire()
    },
  }
}

function stagedInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'session' as const,
    envVar: ENV_VAR,
    value: SECRET,
    createdAt: 1700000000000,
    ...overrides,
  }
}

// ---- protocol ---------------------------------------------------------------

test('parseAttach rebuilds the request field by field and refuses malformed input', () => {
  const ok = parseAttach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  assert.equal(ok.value.envVar, ENV_VAR, 'the exposed name derives from the key')
  assert.equal(ok.value.label, 'openai', 'the label defaults to the key')
  assert.equal(ok.value.value, SECRET)
  assert.deepEqual(Object.keys(ok.value).sort(), ['envVar', 'label', 'name', 'scope', 'sessionId', 'value'])

  const labelled = parseAttach({
    sessionId: SESSION_ID,
    name: 'openai_key',
    label: '  OpenAI  ',
    scope: 'persistent',
    envVar: 'DSH_SECRET_CUSTOM',
    value: SECRET,
  })
  assert.equal(labelled.ok, true)
  if (labelled.ok) {
    assert.equal(labelled.value.label, 'OpenAI')
    assert.equal(labelled.value.envVar, 'DSH_SECRET_CUSTOM')
    assert.equal(labelled.value.scope, 'persistent')
  }

  const refusals: [unknown, RegExp][] = [
    [null, /must be a JSON object/u],
    [{ name: 'openai', scope: 'session', value: SECRET }, /sessionId is required/u],
    [{ sessionId: SESSION_ID, scope: 'session', value: SECRET }, /name is required/u],
    [{ sessionId: SESSION_ID, name: 'OpenAI', scope: 'session', value: SECRET }, /lowercase kebab\/snake/u],
    [{ sessionId: SESSION_ID, name: 'openai', value: SECRET }, /scope must be/u],
    [{ sessionId: SESSION_ID, name: 'openai', scope: 'forever', value: SECRET }, /scope must be/u],
    [{ sessionId: SESSION_ID, name: 'openai', scope: 'session' }, /value is required/u],
    [{ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: '' }, /value is required/u],
    [{ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: 'x'.repeat(65537) }, /at most 65536/u],
    [
      { sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET, envVar: 'OPENAI_KEY' },
      /must look like DSH_SECRET_OPENAI/u,
    ],
    [
      { sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET, envVar: 'DSH_HOME' },
      /must look like DSH_SECRET_OPENAI/u,
    ],
  ]
  for (const [raw, pattern] of refusals) {
    const refused = parseAttach(raw)
    assert.equal(refused.ok, false, `expected a refusal for ${JSON.stringify(raw)}`)
    if (!refused.ok) {
      assert.match(refused.error, pattern)
      // The rejection wording is ours and never quotes what was submitted.
      if (typeof raw === 'object' && raw !== null) {
        const value = (raw as { value?: unknown }).value
        if (typeof value === 'string' && value !== '' && value.length <= 65536) {
          assert.equal(refused.error.includes(value), false, 'a refusal must not echo the value')
        }
      }
    }
  }
})

test('parseRelease and the attached-list query accept only shaped input', () => {
  const ok = parseRelease({ sessionId: SESSION_ID, variable: ENV_VAR })
  assert.deepEqual(ok, { ok: true, value: { sessionId: SESSION_ID, envVar: ENV_VAR } })
  assert.equal(parseRelease({ sessionId: SESSION_ID, variable: 'OPENAI' }).ok, false)
  assert.equal(parseRelease({ variable: ENV_VAR }).ok, false)
  assert.equal(parseRelease(null).ok, false)
  assert.equal(attachedSessionId({ sessionId: ` ${SESSION_ID} ` }), SESSION_ID)
  assert.equal(attachedSessionId({}), undefined)
  assert.equal(attachedSessionId(null), undefined)
})

// ---- staged store -----------------------------------------------------------

test('AttachStore stages per session, replaces, caps, expires and forgets', () => {
  const { store, fireAll } = makeStore({ capacity: 1 })
  const first = store.put(stagedInput())
  assert.equal(first?.replaced, false)
  assert.equal(store.size, 1)
  assert.equal(store.get(SESSION_ID, ENV_VAR)?.value, SECRET)

  // A second variable in the same session hits the cap.
  assert.equal(store.put(stagedInput({ envVar: 'DSH_SECRET_OTHER', name: 'other' })), undefined)
  assert.equal(store.countFor(SESSION_ID), 1)

  // Replacing the same variable is allowed and reports it.
  const replaced = store.put(stagedInput({ value: `${SECRET}-2` }))
  assert.equal(replaced?.replaced, true)
  assert.equal(store.get(SESSION_ID, ENV_VAR)?.value, `${SECRET}-2`)

  // Another session is independent, including of the cap.
  assert.equal(store.put(stagedInput({ sessionId: 'session-other' }))?.replaced, false)
  assert.deepEqual(
    store.list(SESSION_ID).map((item) => item.envVar),
    [ENV_VAR],
  )
  assert.equal(store.forget(SESSION_ID), 1)
  assert.equal(store.get(SESSION_ID, ENV_VAR), undefined)
  assert.equal(store.size, 1, 'forgetting one session leaves another session alone')

  // The TTL drops what was staged, and the timer of a replaced entry cannot
  // drop its replacement.
  fireAll()
  assert.equal(store.size, 0)
})

test('a staged attach exposes nothing until its message is durable', () => {
  const { store } = makeStore()
  const grants = new GrantStore()
  const ensured: string[] = []
  const deps = {
    store,
    grants,
    envs: { ensure: (envVar: string) => ensured.push(envVar) },
    now: () => 1700000000000,
  }
  const session = sessionWithMarker()
  store.put(stagedInput())

  // The invariant at the store level: a staged entry is invisible to the
  // resolution path the shell environment uses.
  assert.equal(grants.valueFor(session, ENV_VAR), undefined)
  assert.deepEqual(ensured, [], 'no contributor is declared before binding')
  assert.equal(grants.size(), 0)

  const bound = bindStaged(deps, session, 3, ENV_VAR)
  assert.equal(bound?.variable, ENV_VAR)
  assert.equal(bound?.scope, 'session')
  assert.equal(store.get(SESSION_ID, ENV_VAR), undefined, 'binding consumes the staged entry')
  assert.deepEqual(ensured, [ENV_VAR])
  assert.equal(grants.valueFor(session, ENV_VAR), SECRET)

  // Idempotent: a second hook finds nothing staged and must not double-register.
  assert.equal(bindStaged(deps, session, 3, ENV_VAR), undefined)
  assert.deepEqual(ensured, [ENV_VAR])

  // Taking the message back takes the exposure back, with no bookkeeping.
  session.nodes = [0, 1]
  assert.equal(grants.valueFor(session, ENV_VAR), undefined)
  assert.equal(describeVariable(deps, session, ENV_VAR), undefined)

  // An unknown variable is never described.
  assert.equal(describeVariable(deps, session, 'DSH_SECRET_NOPE'), undefined)
})

test('attachment views report staged and bound state, and forget a dead binding', () => {
  const { store } = makeStore()
  const grants = new GrantStore()
  const deps = { store, grants, envs: { ensure: () => undefined }, now: () => 1700000000000 }
  const session = sessionWithMarker()

  // The service-side view assembly is exercised through the same helper the
  // capsule uses; here the store half is what matters.
  store.put(stagedInput())
  assert.equal(store.list(SESSION_ID)[0]?.scope, 'session')
  bindStaged(deps, session, 3, ENV_VAR)
  assert.deepEqual(store.list(SESSION_ID), [], 'a bound entry is no longer staged')
  assert.equal(grants.valueFor(session, ENV_VAR), SECRET)
  session.nodes = []
  assert.equal(grants.valueFor(session, ENV_VAR), undefined)
})

// ---- model side -------------------------------------------------------------

test('the model text is rewritten by a pure function, and the marker is not a file path', () => {
  const before = `请用 ${markerFor(ENV_VAR)} 跑测试`
  const after = rewriteMarkers(before)
  assert.equal(after, '请用 [secret DSH_SECRET_OPENAI] 跑测试')
  assert.equal(after.includes('@'), false, 'no @-prefixed token may survive into the request')
  assert.equal(rewriteMarkers(before), after, 'the rewrite is idempotent for the same input')
  assert.equal(rewriteMarkers(after), after, 'a rewritten text is already stable')
  assert.equal(rewriteMarkers('普通文本，没有标记'), '普通文本，没有标记')

  // Boundary discipline matches the composer editor's own token scan.
  assert.deepEqual(parseMarkers(`a ${markerFor(ENV_VAR)} b`), [ENV_VAR])
  assert.deepEqual(parseMarkers(markerFor(ENV_VAR)), [ENV_VAR])
  assert.deepEqual(parseMarkers(`x${markerFor(ENV_VAR)}`), [], 'no whitespace boundary, no marker')
  assert.deepEqual(parseMarkers('@DSH_SECRET_'), [])
  assert.deepEqual(parseMarkers(`${markerFor(ENV_VAR)} ${markerFor(ENV_VAR)}`), [ENV_VAR], 'deduplicated')
  assert.equal(modelFormFor(ENV_VAR), '[secret DSH_SECRET_OPENAI]')

  // The value is not part of any of this: these are pure text functions.
  assert.equal(after.includes(SECRET), false)
  assert.equal(JSON.stringify({ after, markers: parseMarkers(before) }).includes(SECRET), false)
})

test('the injected note names the variables and how to read them, and carries no value', () => {
  const note = renderAttachNote([
    { variable: ENV_VAR, name: 'openai', scope: 'session' },
  ])
  assert.equal(
    note,
    [
      '本条消息附带 1 个由人类主动提供的密钥；明文不进入对话，只能按变量名取用。',
      `- ${ENV_VAR} · 仅本次会话有效`,
      '',
      `取用方式：PowerShell 用 $env:${ENV_VAR}，POSIX shell 用 "$${ENV_VAR}"。`,
      '不要把该标记当作文件路径读取。',
    ].join('\n'),
  )
  assert.equal(note.includes(SECRET), false)

  const two = renderAttachNote([
    { variable: ENV_VAR, name: 'openai', scope: 'session' },
    { variable: 'DSH_SECRET_OTHER', name: 'other', scope: 'persistent' },
  ])
  assert.equal(two.includes('附带 2 个'), true)
  assert.equal(two.includes('持久保存到凭据库'), true)
  assert.equal(renderAttachNote([]), '')

  const source = attachSource([{ variable: ENV_VAR, name: 'openai', scope: 'session' }])
  assert.equal(source.kind, 'secret-attach')
  assert.equal(source.form, 'instructions')
  assert.deepEqual(source.variables, [{ variable: ENV_VAR, name: 'openai', scope: 'session' }])
  assert.equal(JSON.stringify(source).includes(SECRET), false)
})

// ---- the two hooks ----------------------------------------------------------

/** A fake Cordis context capturing the listeners `installAttachBinding` registers. */
function makeBinding(options: { ttlMs?: number; capacity?: number } = {}) {
  const listeners = new Map<string, ((...args: any[]) => any)[]>()
  const { store } = makeStore(options)
  const grants = new GrantStore()
  const ensured: string[] = []
  const boundNotes: { variable: string; label: string }[] = []
  const session = sessionWithMarker()
  installAttachBinding(
    {
      on(name: string, handler: (...args: any[]) => any) {
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
      },
    } as never,
    {
      store,
      grants,
      envs: { ensure: (envVar) => ensured.push(envVar) },
      now: () => 1700000000000,
      sessionOf: () => session,
      onBound: (attach) => boundNotes.push({ variable: attach.variable, label: attach.label }),
    },
  )
  return {
    store,
    grants,
    ensured,
    boundNotes,
    session,
    emit(name: string, ...args: unknown[]) {
      for (const handler of listeners.get(name) ?? []) void handler(...args)
    },
    /** Drive the pre-step waterfall exactly as the agent loop does. */
    async preStep(messages: unknown[], next?: () => unknown) {
      const handlers = listeners.get('agent/pre-step') ?? []
      assert.equal(handlers.length, 1)
      const outcome = await handlers[0]?.(
        { agent: { id: SESSION_ID }, messages, turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve(next === undefined ? { kind: 'enter', messages } : next()),
      )
      return outcome as { messages: { content?: { text?: string }[]; source?: { kind?: string } }[] }
    },
  }
}

test('binding rides session/event and the note rides agent/pre-step', async () => {
  const harness = makeBinding()
  harness.store.put(stagedInput({ label: 'OpenAI API Key' }))

  const userText = `请用 ${markerFor(ENV_VAR)} 跑测试`
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
    { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: `引用 ${markerFor(ENV_VAR)}` }] },
  ]

  // Delivery works before the message is durable, and it must not expose
  // anything on its own: the text is rewritten and the note describes the
  // attachment, but no variable exists yet.
  const beforeBinding = await harness.preStep(messages)
  assert.equal(harness.grants.valueFor(harness.session, ENV_VAR), undefined, 'no exposure before the message is durable')
  assert.deepEqual(harness.ensured, [])
  assert.equal(beforeBinding.messages.length, 3, 'the note describes a staged attachment')
  assert.equal(beforeBinding.messages[0]?.content?.[0]?.text, '请用 [secret DSH_SECRET_OPENAI] 跑测试')
  assert.equal(beforeBinding.messages[2]?.content?.[0]?.text?.includes('- DSH_SECRET_OPENAI · 仅本次会话有效'), true)

  // A non-user event, and a user event without a marker, bind nothing.
  harness.emit('session/event', harness.session, { type: 'tool/result', seq: 3, data: {} })
  harness.emit('session/event', harness.session, { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'no marker' }] } })
  assert.equal(harness.store.size, 1, 'nothing was consumed')

  // The durable message binds it, exactly once.
  const durable = { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: userText }] } }
  harness.emit('session/event', harness.session, durable)
  assert.equal(harness.store.size, 0, 'the staged entry was consumed')
  assert.deepEqual(harness.ensured, [ENV_VAR])
  assert.deepEqual(harness.boundNotes, [{ variable: ENV_VAR, label: 'OpenAI API Key' }])
  assert.equal(harness.grants.valueFor(harness.session, ENV_VAR), SECRET)
  harness.emit('session/event', harness.session, durable)
  assert.deepEqual(harness.boundNotes, [{ variable: ENV_VAR, label: 'OpenAI API Key' }], 'no duplicate registration')

  // Now the request carries the rewritten marker plus one value-free note.
  const after = await harness.preStep(messages)
  assert.equal(after.messages.length, 3)
  assert.equal(after.messages[0]?.content?.[0]?.text, '请用 [secret DSH_SECRET_OPENAI] 跑测试')
  // A message from another producer is left exactly as it was.
  assert.equal(after.messages[1]?.content?.[0]?.text, `引用 ${markerFor(ENV_VAR)}`)
  const note = after.messages[2]
  assert.equal(note?.source?.kind, 'secret-attach')
  assert.equal(note?.content?.[0]?.text?.includes(`- ${ENV_VAR} · 仅本次会话有效`), true)
  assert.equal(note?.content?.[0]?.text?.includes('不要把该标记当作文件路径读取。'), true)

  // The whole request is value-free, and stable across a second step.
  assert.equal(JSON.stringify(after).includes(SECRET), false, 'the value reached the model request')
  const again = await harness.preStep(messages)
  assert.equal(again.messages[0]?.content?.[0]?.text, after.messages[0]?.content?.[0]?.text)
  assert.equal(JSON.stringify(again).includes(SECRET), false)
})

test('a rejected step and a marker-free step both pass through untouched', async () => {
  const harness = makeBinding()
  harness.store.put(stagedInput())
  const rejected = { kind: 'reject' as const }
  const outcome = await harness.preStep([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: markerFor(ENV_VAR) }] }], () => rejected)
  assert.equal(outcome as unknown, rejected, 'a rejected step is returned as the very object it was')
  // The marker-free step keeps its message identity, so no consumer sees a
  // spurious new value on an ordinary turn.
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] }
  const plain = await harness.preStep([message])
  assert.equal(plain.messages.length, 1)
  assert.equal(plain.messages[0], message)
  // And rewriting an already-stable text produces the same object.
  const stable = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'already [secret DSH_SECRET_OPENAI]' }] }
  const unchanged = await harness.preStep([stable])
  assert.equal(unchanged.messages[0], stable)
})

test('messageMarkers reads both recorded payload shapes and ignores non-text blocks', () => {
  assert.deepEqual(messageMarkers({ content: [{ type: 'text', text: `a ${markerFor(ENV_VAR)}` }] }), [ENV_VAR])
  assert.deepEqual(messageMarkers({ message: { content: [{ type: 'text', text: markerFor(ENV_VAR) }] } }), [ENV_VAR])
  assert.deepEqual(messageMarkers({ content: [{ type: 'image', text: markerFor(ENV_VAR) }] }), [])
  assert.deepEqual(messageMarkers({ content: [null, 7, 'x'] }), [])
  assert.deepEqual(messageMarkers(null), [])
  assert.deepEqual(messageMarkers({}), [])
})

// ---- the service faces the capsule talks to ---------------------------------

/** A minimal service over stub ports, so the attach routes' behaviour is provable. */
function makeService(options: { ttlMs?: number; capacity?: number; session?: FakeSession | undefined } = {}) {
  const { store } = makeStore(options)
  const grants = new GrantStore()
  const writes: { ref: string; value: string }[] = []
  const records: { key: string; payload: unknown }[] = []
  const failures = { set: false }
  const session = 'session' in options ? options.session : sessionWithMarker()
  const service = new SecretService({
    config: { requestTimeoutMs: 60000, maxPendingRequests: 4, attachTtlMs: options.ttlMs ?? 1800000, maxAttachmentsPerSession: options.capacity ?? 8 },
    credentials: {
      async describe() {
        return { configured: false, writable: true }
      },
      async resolve() {
        return undefined
      },
      async set(ref, value) {
        if (failures.set) throw new Error(`backend refused ${value}`)
        writes.push({ ref, value })
      },
      async commitRecord(key, payload) {
        records.push({ key, payload })
      },
    },
    authorization: { attempt: async () => ({ status: 'cancelled' }) },
    envs: { ensure: () => undefined },
    attachments: store,
    classifyCaller: () => 'live-root',
    sessionOf: () => session,
    sessionById: (id) => (session !== undefined && String(session.id) === id ? session : undefined),
    anchorSessionOf: () => session,
    now: () => 1700000000000,
    schedule: () => () => undefined,
    newId: () => 'req-1',
  }, grants)
  return { service, store, grants, writes, records, failures, session }
}

test('a session-scope attach stages in memory and never touches a credential store', async () => {
  const { service, store, writes, records } = makeService()
  const outcome = await service.attach({ sessionId: SESSION_ID, name: 'openai', label: 'OpenAI', scope: 'session', value: SECRET })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(outcome.outcome, { variable: ENV_VAR, scope: 'session', replaced: false })
  assert.equal(JSON.stringify(outcome).includes(SECRET), false, 'the response must not echo the value')
  assert.deepEqual(writes, [], 'a session attach must not write the credential store')
  assert.deepEqual(records, [])
  assert.equal(store.get(SESSION_ID, ENV_VAR)?.value, SECRET, 'the value is staged for the message')

  // The staged view is value-free and reports the default scope.
  const views = service.attachedViews(SESSION_ID)
  assert.equal(views.length, 1)
  assert.equal(views[0]?.state, 'staged')
  assert.equal(views[0]?.scope, 'session')
  assert.equal(views[0]?.variable, ENV_VAR)
  assert.equal(JSON.stringify(views).includes(SECRET), false)
  assert.deepEqual(service.attachedViews('session-other'), [])
})

test('a persistent attach is the one path that writes the store, and it records a value-free marker', async () => {
  const { service, writes, records, failures } = makeService()
  const outcome = await service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'persistent', value: SECRET })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.outcome.scope, 'persistent')
  assert.deepEqual(writes, [{ ref: ENV_VAR, value: SECRET }])
  assert.equal(records.length, 1)
  assert.equal(records[0]?.key, 'cordis-plugin-secret/openai')
  assert.equal(JSON.stringify(records[0]).includes(SECRET), false, 'the durable marker must carry no value')

  // A failing backend is collapsed into our own wording, and nothing is staged.
  const failing = makeService()
  failing.failures.set = true
  const refused = await failing.service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'persistent', value: SECRET })
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.status, 500)
    assert.equal(refused.error, '凭据库写入失败；细节已省略，本次附加未登记')
    assert.equal(refused.error.includes(SECRET), false, 'the upstream text quoted the value and must be dropped')
  }
  assert.equal(failing.store.size, 0)
})

test('attach refuses an unknown session, an over-capacity session and malformed input', async () => {
  const unknown = makeService({ session: undefined })
  const missing = await unknown.service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.status, 404)
  assert.equal(unknown.store.size, 0)

  const small = makeService({ capacity: 1 })
  assert.equal((await small.service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })).ok, true)
  const over = await small.service.attach({ sessionId: SESSION_ID, name: 'other', scope: 'session', value: SECRET })
  assert.equal(over.ok, false)
  if (!over.ok) {
    assert.equal(over.status, 409)
    assert.match(over.error, /已达上限/u)
    assert.equal(over.error.includes(SECRET), false)
  }
  // Replacing the same variable at the cap is still allowed.
  assert.equal((await small.service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: `${SECRET}-2` })).ok, true)

  const malformed = await small.service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'nope', value: SECRET })
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.status, 400)
})

test('release drops a staged attach, refuses to pretend a bound one is gone, and reports no trace left', async () => {
  const { service, store, grants, session } = makeService()
  // Releasing something that was never attached is honest about it.
  assert.deepEqual(service.release({ sessionId: SESSION_ID, variable: ENV_VAR }), { ok: true, released: false, state: 'none' })

  await service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })
  assert.deepEqual(service.release({ sessionId: SESSION_ID, variable: ENV_VAR }), { ok: true, released: true, state: 'staged' })
  assert.equal(store.size, 0, 'cancel leaves no ghost attach')
  assert.deepEqual(service.attachedViews(SESSION_ID), [])
  assert.equal(service.release({ sessionId: SESSION_ID, variable: ENV_VAR }).ok, true)

  // A bound attachment is anchored to a message: the only truthful answer is
  // that it is still there, and only taking the message back ends it.
  await service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })
  const bound = bindStaged(
    { store, grants, envs: { ensure: () => undefined }, now: () => 1700000000000, onBound: (attach) => service.noteBound(attach) },
    session as FakeSession,
    3,
    ENV_VAR,
  )
  assert.notEqual(bound, undefined)
  assert.deepEqual(service.release({ sessionId: SESSION_ID, variable: ENV_VAR }), { ok: true, released: false, state: 'bound' })
  assert.equal(service.attachedViews(SESSION_ID)[0]?.state, 'bound')

  // Rewinding the message away ends the exposure, and the view says so.
  if (session !== undefined) session.nodes = []
  assert.deepEqual(service.attachedViews(SESSION_ID), [], 'a dead binding is forgotten, never reported as live')
  assert.deepEqual(service.release({ sessionId: SESSION_ID, variable: ENV_VAR }), { ok: true, released: false, state: 'none' })

  // Session end drops everything, staged and recorded alike.
  await service.attach({ sessionId: SESSION_ID, name: 'openai', scope: 'session', value: SECRET })
  service.forgetAttachments(SESSION_ID)
  assert.equal(store.size, 0)
  assert.deepEqual(service.attachedViews(SESSION_ID), [])
  assert.equal(JSON.stringify(service.attachedViews(SESSION_ID)).includes(SECRET), false)
})

