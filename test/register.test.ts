/**
 * Register-level tests: build the plugin through its real `apply` with a fake
 * Cordis context, then drive one authorization end to end through the object
 * graph the profile actually mounts — the `secret_request` tool, the two
 * `/api` routes, the real `ctx.authorization`/`ctx.credentials` ports (through
 * `src/adapters.ts`) and the real `shellEnv` contributor registry.
 *
 * Everything here is wiring the unit tests deliberately stub out: without this
 * file a regression in `src/index.ts`, `src/routes.ts`, `src/adapters.ts`,
 * `src/envs.ts`, `src/tool.ts` or `src/config.ts` would keep the suite green.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config, inject, name } from '../src/index.ts'
import { ATTACH_PATH, ATTACHED_PATH, ANSWER_PATH, PENDING_PATH, RELEASE_PATH } from '../src/routes.ts'

const SECRET = 'sk-register-DO-NOT-LEAK'
const ENV_VAR = 'DSH_SECRET_OPENAI'

/** Minimal scripted session satisfying every structural contract the plugin reads. */
class FakeSession {
  id: string
  ownFrom: number
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

/** A session whose event log holds the assistant message that issued `callId`. */
function sessionWithCall(callId: string, id = 'session-root', ownFrom = 0): FakeSession {
  const session = new FakeSession(id, ownFrom)
  session.events = [
    { type: 'user/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'tool-call', id: callId, name: 'secret_request', arguments: '{}' }] } },
    },
    { type: 'tool/call', seq: 2, data: { callId } },
  ]
  session.nodes = [0, 1]
  return session
}

interface RouteRegistration {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: never) => Promise<Response>
}

/** One captured `shellEnv` contributor declaration. */
interface Contributor {
  name: string
  variables: Record<string, unknown>
  resolve: (execution: { agent?: unknown }) => Record<string, string>
}

interface Harness {
  readonly ctx: unknown
  readonly tools: { name: string; parameters: unknown; timeoutMs?: number; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]
  readonly routes: RouteRegistration[]
  readonly contributors: Contributor[]
  readonly listeners: Map<string, ((...args: unknown[]) => void)[]>
  readonly teardowns: (() => void)[]
  readonly sessions: Map<string, FakeSession>
  readonly store: Map<string, string>
  readonly setCalls: string[]
  /** Authorization records the seam's flow committed through the dialog session. */
  readonly commits: { key: string; record: unknown }[]
  /** Writes the plugin itself made through the credentials port. */
  readonly recordWrites: { key: string; payload: unknown }[]
  readonly flowDisposals: number[]
  readonly events: string[]
  emit(event: string, ...args: unknown[]): void
}

/**
 * Build a fake context offering exactly the surface this plugin consumes, plus
 * an `authorization` seam that drives the registered flow the way the real seam
 * does (prompt + commit, then `begin` resolves with a status).
 */
function buildContext(main: FakeSession): Harness {
  const tools: Harness['tools'] = []
  const routes: RouteRegistration[] = []
  const contributors: Contributor[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const teardowns: (() => void)[] = []
  const sessions = new Map<string, FakeSession>([[main.id, main]])
  const store = new Map<string, string>()
  const setCalls: string[] = []
  const commits: { key: string; record: unknown }[] = []
  const recordWrites: { key: string; payload: unknown }[] = []
  const flowDisposals: number[] = []
  const events: string[] = []
  const flows: { key: string; methods: { id: string }[]; run: (session: unknown) => Promise<void> }[] = []

  const ctx = {
    effect(fn: () => void | (() => void)) {
      const teardown = fn()
      if (typeof teardown === 'function') teardowns.push(teardown)
      // Cordis returns an awaitable disposer; the plugin never awaits it.
      return () => undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    tools: {
      register(tool: Harness['tools'][number]) {
        tools.push(tool)
        return () => undefined
      },
    },
    connection: {
      fetch: {
        register(route: RouteRegistration) {
          routes.push(route)
          return () => undefined
        },
      },
    },
    shellEnv: {
      register(contributor: Contributor) {
        contributors.push(contributor)
        return () => undefined
      },
    },
    sessions: {
      get(id: unknown) {
        return sessions.get(String(id))
      },
    },
    agents: {
      get(id: unknown) {
        return sessions.has(String(id)) ? { id: String(id) } : undefined
      },
      roots() {
        return [...sessions.keys()].map((id) => ({ id }))
      },
    },
    credentials: {
      async describe(ref: string) {
        events.push(`describe:${ref}`)
        return store.has(ref) ? { configured: true, source: 'provider', writable: true } : { configured: false, writable: true }
      },
      async resolve(ref: string) {
        events.push(`resolve:${ref}`)
        const value = store.get(ref)
        return value === undefined ? undefined : { value, source: 'provider' }
      },
      async set(ref: string, value: string) {
        events.push(`set:${ref}`)
        setCalls.push(value)
        store.set(ref, value)
      },
      async modifyRecord(key: string, update: (previous: unknown) => Promise<unknown>) {
        events.push(`modifyRecord:${key}`)
        recordWrites.push({ key, payload: await update(undefined) })
      },
    },
    authorization: {
      registerFlow(flow: { key: string; methods: { id: string }[]; run: (session: unknown) => Promise<void> }) {
        flows.push(flow)
        return () => {
          flowDisposals.push(1)
        }
      },
      async begin(options: { key: string; method: string; interaction: unknown }) {
        const flow = flows.at(-1)
        assert.notEqual(flow, undefined)
        events.push(`begin:${options.key}:${options.method}`)
        await flow?.run({
          // The seam's own prompt is answered from the value the dialog already
          // collected; returning it here is what the real interaction does.
          prompt: async () => SECRET,
          // The seam owns the durable write: what the flow commits here is the
          // value-free marker the plugin handed it.
          commit: async (record: unknown) => {
            commits.push({ key: String(flow?.key), record })
          },
        })
        return { status: 'authorized' }
      },
    },
  }

  return {
    ctx,
    tools,
    routes,
    contributors,
    listeners,
    teardowns,
    sessions,
    store,
    setCalls,
    commits,
    recordWrites,
    flowDisposals,
    events,
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
}

function applyPlugin(harness: Harness, config: unknown = Config({})): void {
  apply(harness.ctx as never, config as never)
}

/** Read the dialog's pending list through the plugin's own GET route. */
async function pendingPayload(harness: Harness): Promise<{ requests?: { id: string; variable?: string }[] }> {
  const route = harness.routes.find((candidate) => candidate.path === PENDING_PATH)
  assert.notEqual(route, undefined, 'the pending route was never registered')
  const response = await (route as RouteRegistration).fetch(undefined as never)
  assert.equal(response.status, 200)
  return (await response.json()) as { requests?: { id: string; variable?: string }[] }
}

/** Submit one decision through the plugin's own POST route. */
async function submit(harness: Harness, body: unknown): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const route = harness.routes.find((candidate) => candidate.path === ANSWER_PATH)
  assert.notEqual(route, undefined, 'the answer route was never registered')
  const response = await (route as RouteRegistration).fetch({ json: async () => body } as never)
  return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } }
}

/** Wait until the dialog has registered a request, and return its id. */
async function firstPendingId(harness: Harness): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const payload = await pendingPayload(harness)
    const view = payload.requests?.[0]
    if (view !== undefined) return view.id
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  throw new Error('the secret request never registered a pending dialog')
}

/** Wait until the dialog has registered its request, then submit one answer. */
async function answerNext(harness: Harness, build: (id: string) => unknown): Promise<void> {
  const id = await firstPendingId(harness)
  const outcome = await submit(harness, build(id))
  assert.equal(outcome.body.ok, true, outcome.body.error ?? 'the answer route refused the decision')
}

function call(harness: Harness, session: FakeSession, args: unknown, callId = 'call-1'): Promise<unknown> {
  const tool = harness.tools.find((candidate) => candidate.name === 'secret_request')
  assert.notEqual(tool, undefined, 'secret_request was never registered')
  return (tool as Harness['tools'][number]).execute(args, {
    agent: { id: session.id },
    callId,
    signal: new AbortController().signal,
  })
}

function requestArgs(scope: 'session' | 'persistent' = 'session') {
  return { name: 'openai', label: 'OpenAI', reason: 'run completions', scope }
}

test('plugin metadata, Config defaults and apply wiring', () => {
  assert.equal(name, 'cordis-plugin-secret')
  for (const dependency of ['tools', 'authorization', 'credentials', 'shellEnv', 'sessions', 'agents', 'connection']) {
    assert.equal(inject.includes(dependency), true, `inject is missing ${dependency}`)
  }
  const defaults = Config({}) as { requestTimeoutMs: number; maxPendingRequests: number }
  assert.equal(defaults.requestTimeoutMs, 300000)
  assert.equal(defaults.maxPendingRequests, 4)

  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const tool = harness.tools.find((candidate) => candidate.name === 'secret_request')
  assert.notEqual(tool, undefined)
  const parameters = (tool as { parameters: { properties?: Record<string, unknown>; required?: string[] } }).parameters
  assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), [
    'description',
    'envVar',
    'label',
    'name',
    'reason',
    'scope',
  ])
  assert.deepEqual([...(parameters.required ?? [])].sort(), ['label', 'name', 'reason', 'scope'])
  // The plugin's own human timeout must fire before any cooperative call timeout.
  assert.equal((tool as { timeoutMs?: number }).timeoutMs, defaults.requestTimeoutMs + 30000)

  const registered = harness.routes.map((route) => ({ path: route.path, methods: [...route.methods] }))
  // The agent-ask direction's two routes are asserted exactly as before: same
  // paths, same methods. The reverse direction only appends to the list.
  for (const expected of [
    { path: PENDING_PATH, methods: ['GET'] },
    { path: ANSWER_PATH, methods: ['POST'] },
  ]) {
    const found = registered.find((route) => route.path === expected.path)
    assert.deepEqual(found, expected)
  }
  assert.deepEqual(registered, [
    { path: PENDING_PATH, methods: ['GET'] },
    { path: ATTACHED_PATH, methods: ['GET'] },
    { path: ATTACH_PATH, methods: ['POST'] },
    { path: RELEASE_PATH, methods: ['POST'] },
    { path: ANSWER_PATH, methods: ['POST'] },
  ])
  assert.equal(harness.listeners.get('session/disposed')?.length, 1)
  assert.equal(harness.contributors.length, 0, 'no variable is declared before the first approval')
})

test('apply refuses a config the schema accepts but the plugin forbids', () => {
  const harness = buildContext(sessionWithCall('call-1'))
  assert.throws(
    () => applyPlugin(harness, { requestTimeoutMs: 0, maxPendingRequests: 4 }),
    /requestTimeoutMs must be a positive integer/u,
  )
  assert.throws(
    () => applyPlugin(harness, { requestTimeoutMs: 1000, maxPendingRequests: 0 }),
    /maxPendingRequests must be a positive integer/u,
  )
  assert.equal(harness.tools.length, 0)
})

test('a session-scope approval flows tool -> dialog -> shellEnv and never reaches the store', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const pending = call(harness, session, requestArgs())
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  const result = (await pending) as { decision: string; variable?: string; scope?: string; ref?: { space?: string } }

  assert.equal(result.decision, 'approved')
  assert.equal(result.variable, ENV_VAR)
  assert.equal(result.scope, 'session')
  assert.equal(result.ref?.space, 'session-shell-env')
  // The invariant, at the real wiring level: no value anywhere in the result.
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(harness.setCalls.length, 0, 'a session grant must not write the credential store')
  assert.equal(harness.commits.length, 0, 'a session grant must not commit a durable record')

  // The value really is delivered through the declared contributor...
  assert.equal(harness.contributors.length, 1)
  const contributor = harness.contributors[0]
  assert.equal(contributor?.name, `cordis-plugin-secret:${ENV_VAR}`)
  assert.deepEqual(Object.keys(contributor?.variables ?? {}), [ENV_VAR])
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  // ...but an execution without an agent, and a forked child session, get nothing.
  assert.deepEqual(contributor?.resolve({}), {})
  const child = sessionWithCall('call-1', 'session-child', 3)
  harness.sessions.set(child.id, child)
  assert.deepEqual(contributor?.resolve({ agent: { id: child.id } }), {})

  // A session-scope approval carries no variable name from controller code paths
  // other than the one it was declared for.
  assert.equal(harness.contributors.length, 1)
})

test('rewinding the surface and ending the session both withdraw the injected value', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const pending = call(harness, session, requestArgs())
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await pending

  const contributor = harness.contributors[0]
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  // Edit-and-retry shadows the anchoring assistant message: the next execution
  // of this same session must not receive the value.
  session.nodes = []
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), {})

  // Re-authorize, then dispose the session: the plugin's own `session/disposed`
  // listener must drop what the rewind had kept alive.
  session.nodes = [0, 1]
  const again = call(harness, session, requestArgs())
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await again
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  harness.emit('session/disposed', session)
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), {})
})

test('a persistent approval runs the real authorization seam and stores the value', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const pending = call(harness, session, requestArgs('persistent'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'persistent', value: SECRET }))
  const result = (await pending) as { decision: string; variable?: string; scope?: string; ref?: { space?: string } }

  assert.equal(result.decision, 'approved')
  assert.equal(result.scope, 'persistent')
  assert.equal(result.ref?.space, 'credential-ref')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  // The value was written through the credentials service and nowhere else.
  assert.deepEqual(harness.setCalls, [SECRET])
  assert.equal(harness.store.get(ENV_VAR), SECRET)
  // The durable authorization marker is committed by the seam's flow, never by
  // the plugin, and it carries no secret material.
  assert.equal(harness.commits.length, 1)
  assert.equal(harness.commits[0]?.key, 'cordis-plugin-secret/openai')
  const committed = harness.commits[0]?.record as { kind?: string; payload?: Record<string, unknown> } | undefined
  assert.equal(committed?.kind, 'grant')
  assert.equal(JSON.stringify(committed).includes(SECRET), false, 'the durable marker must carry no value')
  assert.equal(committed?.payload?.envVar, ENV_VAR)
  assert.equal(committed?.payload?.scope, 'persistent')
  // The plugin itself never wrote a record through the credentials port.
  assert.equal(harness.recordWrites.length, 0)
  // The flow is disposed after the attempt, whatever its outcome.
  assert.equal(harness.flowDisposals.length, 1)
  // A persistent approval authenticates the same reference space for this session.
  assert.deepEqual(harness.contributors[0]?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })
})

test('the answer route refuses a malformed body and a repeated answer', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const malformed = await submit(harness, { id: '', decision: 'ignored' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.ok, false)

  const pending = call(harness, session, requestArgs())
  const requestId = await firstPendingId(harness)
  const first = await submit(harness, { id: requestId, decision: 'ignored' })
  assert.equal(first.status, 200)
  const result = (await pending) as { decision: string }
  assert.equal(result.decision, 'ignored')

  // The dialog is gone: a second submission for it is a conflict, not a retry.
  // That 409 is exactly what makes the Client half close instead of sticking.
  const repeated = await submit(harness, { id: requestId, decision: 'ignored' })
  assert.equal(repeated.status, 409)
  assert.equal(repeated.body.ok, false)
})
