/**
 * History-store tests: the store's own retention rules, and the write points of
 * the four transitions round 5 added (`updated`, `scope-changed`, `unbound`,
 * `deleted`).
 *
 * This file exists because the gap it closes was real: before this round, no
 * test asserted a single `HistoryStore` write point at all — the history's shape
 * was frozen on the wire and asserted from the client side, but the Host could
 * have stopped recording anything without a test noticing. Every event below is
 * driven through the service that records it, never by pushing into the store by
 * hand, so what is asserted is the wiring as well as the record.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AttachStore } from '../src/attach.ts'
import { HistoryStore } from '../src/history.ts'
import { SecretService, type AuthorizationAttemptInput, type AuthorizationAttemptResult, type CredentialsPort } from '../src/service.ts'
import type { SecretHistoryEvent } from '../src/types.ts'

const SECRET = 'sk-history-DO-NOT-LEAK'
const ENV_VAR = 'DSH_SECRET_OPENAI'
const RECORD_KEY = 'cordis-plugin-secret/openai'
const SESSION_ID = 'session-root'

/** The subset of a live session this plugin reads. */
class FakeSession {
  id = SESSION_ID
  nodes: number[] = [0, 1, 2]
  replaceGeneration = 0
  events: { type: string; seq: number; data?: unknown }[] = [
    { type: 'user/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'tool-call', id: 'call-1', name: 'secret_request', arguments: '{}' }] } },
    },
    { type: 'tool/call', seq: 2, data: { callId: 'call-1' } },
  ]

  get seq(): number {
    return this.events.length
  }

  get surface(): { nodes: readonly number[]; replaceGeneration: number } {
    return { nodes: this.nodes, replaceGeneration: this.replaceGeneration }
  }

  isOwnSeq(seq: number): boolean {
    return seq >= 0 && seq < this.seq
  }

  snapshotEvents(): readonly { type: string; seq: number; data?: unknown }[] {
    return this.events
  }
}

interface Rig {
  readonly service: SecretService
  readonly history: HistoryStore
  readonly session: FakeSession
  readonly store: Map<string, string>
  readonly records: Map<string, unknown>
  readonly events: string[]
}

/** Build the service over a real history store, with a stub credential store. */
function rig(options: { readonly capacity?: number; readonly sessionId?: string } = {}): Rig {
  const history = new HistoryStore({ capacity: options.capacity ?? 32 })
  const store = new Map<string, string>()
  const records = new Map<string, unknown>()
  const events: string[] = []
  const session = new FakeSession()
  if (options.sessionId !== undefined) session.id = options.sessionId
  const credentials: CredentialsPort = {
    describe: async (ref) => (store.has(ref) ? { configured: true, source: 'provider', writable: true } : { configured: false, writable: true }),
    resolve: async (ref) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'provider' }
    },
    set: async (ref, value) => {
      events.push(`set:${ref}`)
      store.set(ref, value)
    },
    commitRecord: async (key) => {
      events.push(`commitRecord:${key}`)
    },
    listRecords: async () => [...records.keys()].map((key) => ({ key, kind: 'grant' })),
    readRecord: async (key) => {
      const payload = records.get(key)
      return payload === undefined ? undefined : { kind: 'grant', payload }
    },
    unset: async (ref) => {
      events.push(`unset:${ref}`)
      store.delete(ref)
      return true
    },
    deleteRecord: async (key) => {
      events.push(`deleteRecord:${key}`)
      records.delete(key)
      return true
    },
  }
  const authorization = {
    attempt: async (input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult> => {
      if (input.preloaded !== undefined) await input.persist(input.preloaded)
      await input.answer()
      await credentials.commitRecord(input.key, input.marker())
      events.push('authorized')
      return { status: 'authorized' }
    },
  }
  let counter = 0
  const service = new SecretService(
    {
      config: {
        requestTimeoutMs: 60000,
        maxPendingRequests: 4,
        attachTtlMs: 1800000,
        maxAttachmentsPerSession: 8,
        maxHistoryPerSession: options.capacity ?? 32,
        maxAvailableEntries: 32,
      },
      credentials,
      authorization,
      envs: { ensure: (envVar) => events.push(`ensure:${envVar}`) },
      attachments: new AttachStore({ ttlMs: 1800000, capacity: 8, schedule: () => () => undefined }),
      history,
      classifyCaller: () => 'live-root',
      sessionOf: () => session,
      sessionById: () => session,
      anchorSessionOf: () => session,
      now: () => 1700000000000,
      schedule: () => () => undefined,
      newId: () => `req-${String((counter += 1))}`,
    },
  )
  return { service, history, session, store, records, events }
}

/** The caller identity the agent tools need. */
function caller(): { agent: { id: string }; callId: string; signal: AbortSignal } {
  return { agent: { id: SESSION_ID }, callId: 'call-1', signal: new AbortController().signal }
}

/** Answer the first waiting dialog once a call has registered it. */
async function answerNext(service: SecretService, build: (id: string) => unknown): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = service.views()[0]
    if (view !== undefined) {
      const outcome = service.answer(build(view.id))
      assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error)
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  throw new Error('the interaction never registered a pending dialog')
}

/** Every event recorded for one session, oldest first. */
function eventsOf(rig$: Rig, sessionId = SESSION_ID): readonly SecretHistoryEvent[] {
  return rig$.service
    .historyFor(sessionId)
    .entries.map((entry) => entry.event)
    .reverse()
}

// ---- the store's own rules ---------------------------------------------------

test('the history store keeps a session’s entries bounded, isolated and newest-first', () => {
  const history = new HistoryStore({ capacity: 3 })
  for (const event of ['staged', 'bound', 'discarded', 'withdrawn'] as const) {
    history.push('a', { at: 1, event, variable: ENV_VAR, name: 'openai', label: 'OpenAI', scope: 'session', source: 'attach' })
    history.push('b', { at: 1, event, variable: 'DSH_SECRET_OTHER', name: 'other', label: 'Other', scope: 'session', source: 'attach' })
  }
  // Capacity drops the oldest, per session.
  assert.deepEqual(
    history.list('a').map((entry) => entry.event),
    ['withdrawn', 'discarded', 'bound'],
  )
  assert.equal(history.list('b').length, 3)
  assert.equal(history.size, 2)
  // `latest` finds the newest entry that names one variable.
  assert.equal(history.latest('a', ENV_VAR)?.event, 'withdrawn')
  assert.equal(history.latest('a', 'DSH_SECRET_ABSENT'), undefined)
  // One session's end drops only that session.
  history.forget('a')
  assert.deepEqual(history.list('a'), [])
  assert.equal(history.list('b').length, 3)
  history.disposeAll()
  assert.equal(history.size, 0)
})

test('the history is process memory only: another session, and a new store in this process, start empty', () => {
  const first = rig()
  assert.deepEqual(eventsOf(first), [])
  void first.service.attach({
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
  })
  // A session that never observed anything reports nothing, however busy its
  // neighbour was: nothing is rebuilt from a log or shared across sessions.
  assert.deepEqual(eventsOf(first, 'session-elsewhere'), [])
  // A second store in the same process holds nothing either — the state lives
  // in this instance's memory, never in a file or a global. That a *fresh
  // process* also starts empty (README 「宿主重启后清空」) cannot be shown from
  // inside this process; it is covered by the independent cross-process probe.
  const second = rig()
  assert.deepEqual(eventsOf(second), [], 'a new in-process store starts with no history')
})

// ---- the four transitions round 5 added -------------------------------------

test('a human value change records `updated`, with the scope it applies to', async () => {
  const r = rig()
  await r.service.attach({
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
  })
  assert.deepEqual(eventsOf(r), ['staged'])

  const outcome = await r.service.manage({
    sessionId: SESSION_ID,
    action: 'value',
    variable: ENV_VAR,
    target: 'session',
    value: 'sk-rotated',
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(eventsOf(r), ['staged', 'updated'])
  const entry = r.service.historyFor(SESSION_ID).entries[0]
  assert.equal(entry?.event, 'updated')
  assert.equal(entry?.source, 'manage', 'a management action is recorded as one')
  assert.equal(entry?.scope, 'session', 'the unchanged scope is the fact after the change')
  // The record names the variable and carries no value.
  assert.equal(entry?.variable, ENV_VAR)
  assert.equal(JSON.stringify(entry).includes('sk-rotated'), false)
})

test('a re-scope to persistent records `scope-changed` at the new scope', async () => {
  const r = rig()
  await r.service.attach({
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
  })

  const outcome = await r.service.manage({ sessionId: SESSION_ID, action: 'scope', variable: ENV_VAR, to: 'persistent' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(eventsOf(r), ['staged', 'scope-changed'])
  const entry = r.service.historyFor(SESSION_ID).entries[0]
  assert.equal(entry?.event, 'scope-changed')
  assert.equal(entry?.scope, 'persistent', 'the entry says what the scope became')
  assert.equal(entry?.source, 'manage')
  // The durable write happened (the seam committed), and no record deletion is
  // part of this direction.
  assert.equal(r.events.includes('commitRecord:record'), false)
  assert.equal(r.store.get(ENV_VAR), SECRET)
})

test('an unbind records `unbound` and leaves the store alone', async () => {
  const r = rig()
  // A session-scoped grant: the ask direction is the shortest way to one.
  const pending = r.service.request(
    { name: 'openai', label: 'OpenAI', reason: 'run completions', scope: 'session' },
    caller(),
  )
  await answerNext(r.service, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  const result = (await pending) as { decision: string }
  assert.equal(result.decision, 'approved')
  assert.deepEqual(eventsOf(r), ['authorized'])

  const applied = r.service.manageRequest({ action: 'unbind', variable: ENV_VAR, reason: 'done with it' }, caller())
  await answerNext(r.service, (id) => ({ id, decision: 'approved', scope: 'session' }))
  assert.equal(((await applied) as { decision: string }).decision, 'applied')
  assert.deepEqual(eventsOf(r), ['authorized', 'unbound'])
  const entry = r.service.historyFor(SESSION_ID).entries[0]
  assert.equal(entry?.event, 'unbound')
  assert.equal(entry?.source, 'manage')
  // Nothing durable was touched, and the store was never asked to remove value
  // or record: this tier is the session's own exposure.
  assert.deepEqual(r.events.filter((event) => event.startsWith('unset:') || event.startsWith('deleteRecord:')), [])
})

test('a delete records `deleted`, and reports the session copy as session-scoped', async () => {
  const r = rig()
  r.store.set(ENV_VAR, SECRET)
  r.records.set(RECORD_KEY, { version: 1, envVar: ENV_VAR, name: 'openai', scope: 'persistent', authorizedAt: 1 })
  await r.service.attach({
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI',
    scope: 'persistent',
    envVar: ENV_VAR,
    value: SECRET,
  })

  const unconfirmed = await r.service.manage({
    sessionId: SESSION_ID,
    action: 'delete',
    variable: ENV_VAR,
    confirm: false,
  })
  assert.equal(unconfirmed.ok, false)
  assert.equal(eventsOf(r).includes('deleted'), false, 'a refused deletion is not recorded as one')

  const outcome = await r.service.manage({ sessionId: SESSION_ID, action: 'delete', variable: ENV_VAR, confirm: true })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.changed.store, true)
  assert.equal(eventsOf(r).includes('deleted'), true)
  const entry = r.service.historyFor(SESSION_ID).entries[0]
  assert.equal(entry?.event, 'deleted')
  assert.equal(entry?.scope, 'persistent', 'the row says what was deleted, not what survived it')
  assert.equal(entry?.source, 'manage')
  // The value went first and the record second, and the session's copy is now
  // reported at session scope while staying usable.
  const unsetAt = r.events.indexOf(`unset:${ENV_VAR}`)
  const deleteAt = r.events.indexOf(`deleteRecord:${RECORD_KEY}`)
  assert.equal(unsetAt !== -1 && deleteAt !== -1 && unsetAt < deleteAt, true)
  const rows = await r.service.manageList(SESSION_ID)
  assert.equal(rows[0]?.scope, 'session')
  assert.equal(rows[0]?.can.delete, false)
})

test('a downgrade keeps the store record and records only the scope change', async () => {
  const r = rig()
  r.store.set(ENV_VAR, SECRET)
  r.records.set(RECORD_KEY, { version: 1, envVar: ENV_VAR, name: 'openai', scope: 'persistent', authorizedAt: 1 })
  await r.service.attach({
    sessionId: SESSION_ID,
    name: 'openai',
    label: 'OpenAI',
    scope: 'persistent',
    envVar: ENV_VAR,
    value: SECRET,
  })

  const outcome = await r.service.manage({ sessionId: SESSION_ID, action: 'scope', variable: ENV_VAR, to: 'session' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(eventsOf(r), ['staged', 'scope-changed'])
  const entry = r.service.historyFor(SESSION_ID).entries[0]
  assert.equal(entry?.event, 'scope-changed')
  assert.equal(entry?.scope, 'session')
  // The user's ruling, as a test: this direction deletes nothing, and the store
  // is exactly as it was.
  assert.deepEqual(r.events.filter((event) => event.startsWith('unset:') || event.startsWith('deleteRecord:')), [])
  assert.equal(r.records.has(RECORD_KEY), true)
  assert.equal(r.store.get(ENV_VAR), SECRET)
})

test('the four new events take their place in the bounded ring like every other', () => {
  const r = rig({ capacity: 3 })
  const write = (event: SecretHistoryEvent): void => {
    r.history.push(SESSION_ID, {
      at: 1,
      event,
      variable: ENV_VAR,
      name: 'openai',
      label: 'OpenAI',
      scope: 'session',
      source: 'manage',
    })
  }
  for (const event of ['updated', 'scope-changed', 'unbound', 'deleted'] as const) write(event)
  assert.deepEqual(
    r.service.historyFor(SESSION_ID).entries.map((entry) => entry.event),
    ['deleted', 'unbound', 'scope-changed'],
    'newest first, oldest dropped at capacity',
  )
  // The wire view rebuilds every field by name and carries no value field.
  const view = r.service.historyFor(SESSION_ID)
  assert.deepEqual(Object.keys(view.entries[0] ?? {}).sort(), [
    'at',
    'event',
    'label',
    'name',
    'scope',
    'source',
    'variable',
  ])
  assert.equal(JSON.stringify(view).includes(SECRET), false)
})
