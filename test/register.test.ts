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
import { afterEach, test } from 'node:test'
import { apply, Config, inject, name } from '../src/index.ts'
import {
  ADOPT_PATH,
  ATTACH_PATH,
  ATTACHED_PATH,
  AVAILABLE_PATH,
  ANSWER_PATH,
  HISTORY_PATH,
  MANAGE_PATH,
  PENDING_PATH,
  RELEASE_PATH,
} from '../src/routes.ts'
import { fixtureFingerprint, fixtureToken } from './secret-fixtures.ts'

const SECRET = fixtureToken('sk-', 'register-DO-NOT-LEAK')
/** The value a human types into a *change* form: a second sentinel, so a scan
 * can never pass because it looked for the string that was there all along. */
const ROTATED = fixtureToken('sk-', 'register-ROTATED-DO-NOT-LEAK')
const ENV_VAR = 'DSH_SECRET_OPENAI'

/** Minimal scripted session satisfying every structural contract the plugin reads. */
class FakeSession {
  id: string
  ownFrom: number
  nodes: number[] = []
  replaceGeneration = 0
  events: { type: string; seq: number; data?: unknown }[] = []
  /** The logged request route a key suggestion reads through `requestHeader`. */
  header: { provider: string; model: string } | undefined
  /** How many events somebody tried to append: a suggestion must not append any. */
  appends = 0

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

  /** The conversation's own call configuration, when this session has one. */
  requestHeader(): { config: { provider: string; model: string } } | undefined {
    return this.header === undefined ? undefined : { config: this.header }
  }

  /** Nothing in this plugin may append during a key suggestion. */
  append(): void {
    this.appends += 1
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

/**
 * Whether this harness's fake `connection.fetch` registry enforces the real
 * registry's rules.
 *
 * The fake registry used by every other test only *records* registrations, so a
 * second registration for the same exact path passes here and throws in the
 * field. `strictFetch` closes that gap for the one test that is about the
 * registry's own contract, replicating the real implementation:
 *
 * - the table is keyed by pathname alone, and a second registration for a path
 *   that is already there throws
 *   ``connection: exact Fetch route "<path>" is already registered``
 *   (`@deepseek-ai/dsh-client-connection/lib/index.js:625-639`; the `fetch`
 *   getter that hands out `register` is at `:581-584` — the user's field stack
 *   named `:583` — and the throw is at `:633`; the `methods` a route was
 *   registered with are irrelevant to it) — that is the error the field
 *   reported when 0.4.0 was mounted;
 * - a route declaring no methods, or repeating one, is refused
 *   (`:758-762`, `assertFetchRoute`).
 *
 * Not replicated: `endpointFromPath('/api', path)` path-shape validation
 * (`:759`), because every path this plugin registers is a literal constant of
 * the form the validator accepts.
 */
interface HarnessOptions {
  readonly strictFetch?: boolean
}

/** The real registry's duplicate-path error, verbatim (`.../index.js:633`). */
function alreadyRegistered(path: string): Error {
  return new Error(`connection: exact Fetch route ${JSON.stringify(path)} is already registered`)
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
  /** Durable records the fake store holds, keyed by their `<scope>/<id>`. */
  readonly records: Map<string, unknown>
  /** References whose value was removed through the port. */
  readonly unsetCalls: string[]
  /** Record keys that were removed through the port. */
  readonly deleteCalls: string[]
  /**
   * Session ids the harness reports as delegated children rather than live
   * roots. This is the one axis of `classifyCaller` a plain session map cannot
   * express, and the whole of the caller boundary rides on it.
   */
  readonly delegated: Set<string>
  /**
   * R1: install (or clear) a fake optional `llm` service before `apply`.
   *
   * Left unset — the default — the harness models a profile with no model at
   * all, which is the positive control for the optional wiring.
   */
  setLlm(service: unknown): void
  emit(event: string, ...args: unknown[]): void
}

/**
 * Every harness this file has built, so the plugin's unload path can be run for
 * each of them when its test ends.
 *
 * This is not tidiness: a staged attach arms the plugin's production TTL timer
 * (30 minutes by default, `src/index.ts` -> `AttachStore.put`), and a test that
 * stages one through the real route without unloading leaves that timer armed,
 * which keeps the test process alive long after the last assertion. That leak is
 * exactly why `npm test` stopped exiting this round; the fix is to run the
 * teardowns the plugin itself registered, never to kill the process.
 */
const harnesses: Harness[] = []

/** Harnesses whose teardowns have already run; unloading twice must be a no-op. */
const unloaded = new WeakSet<Harness>()

/**
 * Build a fake context offering exactly the surface this plugin consumes, plus
 * an `authorization` seam that drives the registered flow the way the real seam
 * does (prompt + commit, then `begin` resolves with a status).
 */
function buildContext(main: FakeSession, options: HarnessOptions = {}): Harness {
  const strictFetch = options.strictFetch === true
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
  const records = new Map<string, unknown>()
  const unsetCalls: string[] = []
  const deleteCalls: string[] = []
  const delegated = new Set<string>()
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
          if (strictFetch) {
            if (route.methods.length === 0) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
            if (new Set(route.methods).size !== route.methods.length) {
              throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
            }
            if (routes.some((existing) => existing.path === route.path)) throw alreadyRegistered(route.path)
          }
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
        // A session listed in `delegated` is a child of some root: it exists and
        // its own facts are readable, but it is not the runtime root.
        return [...sessions.keys()].filter((id) => !delegated.has(id)).map((id) => ({ id }))
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
        const record = (await update(records.get(key))) as { payload?: unknown } | undefined
        recordWrites.push({ key, payload: record })
        // The store keeps the payload, exactly as the real seam does: a read
        // hands back `{kind, payload}`, never the wrapper it was written with.
        if (record !== undefined) records.set(key, record.payload)
      },
      async listRecords() {
        events.push('listRecords')
        return [...records.keys()].map((key) => ({ key, kind: 'grant' }))
      },
      async readRecord(key: string) {
        const payload = records.get(key)
        return payload === undefined ? undefined : { kind: 'grant', payload }
      },
      async unset(ref: string) {
        events.push(`unset:${ref}`)
        unsetCalls.push(ref)
        store.delete(ref)
      },
      async deleteRecord(key: string) {
        events.push(`deleteRecord:${key}`)
        deleteCalls.push(key)
        records.delete(key)
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
    // R1: the optional `llm` service, resolved the way cordis resolves an
    // optional dependency — an absent service is `undefined`, never a throw.
    get(name: string) {
      return name === 'llm' ? llmService : undefined
    },
  }

  let llmService: unknown

  const harness: Harness = {
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
    records,
    unsetCalls,
    deleteCalls,
    delegated,
    setLlm(service: unknown) {
      llmService = service
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
  harnesses.push(harness)
  return harness
}

function applyPlugin(harness: Harness, config: unknown = Config({})): void {
  apply(harness.ctx as never, config as never)
}

/**
 * Find the plugin's one registration for an exact path, failing loudly.
 *
 * A path is registered once (`methods` carries every method it owns), because
 * the real registry keys its table by pathname alone; the method the caller is
 * about to use is passed on the request, the way the real dispatcher does.
 */
function routeFor(harness: Harness, path: string, method: 'GET' | 'POST'): RouteRegistration {
  const route = harness.routes.find((candidate) => candidate.path === path)
  assert.notEqual(route, undefined, `the ${path} route was never registered`)
  const found = route as RouteRegistration
  assert.equal(found.methods.includes(method), true, `${path} does not own ${method}`)
  return found
}

/** Read the dialog's pending list through the plugin's own GET route. */
async function pendingPayload(harness: Harness): Promise<{ requests?: { id: string; variable?: string }[] }> {
  const response = await routeFor(harness, PENDING_PATH, 'GET').fetch({
    method: 'GET',
    url: `http://local${PENDING_PATH}`,
  } as never)
  assert.equal(response.status, 200)
  return (await response.json()) as { requests?: { id: string; variable?: string }[] }
}

/** Submit one decision through the plugin's own POST route. */
async function submit(harness: Harness, body: unknown): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const response = await routeFor(harness, ANSWER_PATH, 'POST').fetch({
    method: 'POST',
    url: `http://local${ANSWER_PATH}`,
    json: async () => body,
  } as never)
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

/** Drive one `secret_manage` call through the tool the plugin registered. */
function manage(harness: Harness, session: FakeSession, args: unknown, callId = 'call-m1'): Promise<unknown> {
  const tool = harness.tools.find((candidate) => candidate.name === 'secret_manage')
  assert.notEqual(tool, undefined, 'secret_manage was never registered')
  return (tool as Harness['tools'][number]).execute(args, {
    agent: { id: session.id },
    callId,
    signal: new AbortController().signal,
  })
}

/**
 * Render one `secret_manage` result through the tool's own model-facing
 * renderer, so a test reads exactly what the model would read.
 */
function renderManage(harness: Harness, args: unknown, value: unknown): string {
  const tool = harness.tools.find((candidate) => candidate.name === 'secret_manage')
  assert.notEqual(tool, undefined, 'secret_manage was never registered')
  const output = (tool as unknown as {
    output: { render: (args: unknown, value: unknown) => { type: string; text: string }[] }
  }).output
  return output.render(args, value).map((part) => part.text).join('\n')
}

/** Post one management body through the plugin's own route. */
async function postManage(
  harness: Harness,
  body: unknown,
): Promise<{ status: number; body: { ok?: boolean; error?: string; changed?: { session?: boolean; store?: boolean }; notice?: string } }> {
  const response = await routeFor(harness, MANAGE_PATH, 'POST').fetch({
    method: 'POST',
    url: `http://local${MANAGE_PATH}`,
    json: async () => body,
  } as never)
  return { status: response.status, body: (await response.json()) as never }
}

/** Read the management list through the plugin's own GET route. */
async function manageList(harness: Harness, sessionId: string): Promise<{
  entries?: {
    variable: string
    can: Record<string, boolean>
    source: string
    scope: string
    state: string
    origin?: string
    name?: string
    label?: string
  }[]
}> {
  const response = await routeFor(harness, MANAGE_PATH, 'GET').fetch({
    method: 'GET',
    url: `http://local${MANAGE_PATH}?sessionId=${sessionId}`,
  } as never)
  return (await response.json()) as never
}

/** Read one session's history through the plugin's own GET route. */
async function historyFor(harness: Harness, sessionId: string): Promise<{ entries?: { event: string; variable: string; source: string; scope: string }[] }> {
  const response = await routeFor(harness, HISTORY_PATH, 'GET').fetch({
    method: 'GET',
    url: `http://local${HISTORY_PATH}?sessionId=${sessionId}`,
  } as never)
  return (await response.json()) as never
}

/**
 * Stage one attach through the plugin's own route (the reverse direction's
 * entry), so a management action has a session-side record to act on.
 */
async function postAttach(harness: Harness, session: FakeSession, body: Record<string, unknown>): Promise<void> {
  const response = await routeFor(harness, ATTACH_PATH, 'POST').fetch({
    method: 'POST',
    url: `http://local${ATTACH_PATH}`,
    json: async () => ({ sessionId: session.id, ...body }),
  } as never)
  assert.equal(response.status, 200)
}

/**
 * Run the plugin's own unload path.
 *
 * A staged attach arms a real TTL timer (the plugin's production scheduler),
 * which would otherwise keep the test process alive for its full 30 minutes.
 * Running the teardowns is exactly what an unload does, so this is the honest
 * way to end a test that staged something. It is idempotent, because every
 * harness is also unloaded automatically when its test ends (see `afterEach`
 * below): a test may call this explicitly mid-flight, or not at all.
 */
function unload(harness: Harness): void {
  if (unloaded.has(harness)) return
  unloaded.add(harness)
  for (const teardown of harness.teardowns) teardown()
}

// The safety net that makes the leak impossible to reintroduce: whichever test
// staged something, and whether or not it remembered to unload, the plugin's
// registered teardowns run before the process is asked to exit.
afterEach(() => {
  for (const harness of harnesses.splice(0)) unload(harness)
})

/** Give one session a staged attach and a durable credential-store record for the
 * same variable, so every management action has something to act on. */
async function seedSession(harness: Harness, session: FakeSession): Promise<void> {
  harness.store.set(ENV_VAR, SECRET)
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })
  await postAttach(harness, session, {
    name: 'openai',
    label: 'OpenAI',
    scope: 'persistent',
    envVar: ENV_VAR,
    value: SECRET,
  })
}

test('the composed sentinels and the vendor fixture are byte-identical to the literals they replaced', () => {
  // Composed at run time (`fixtureToken`, `./secret-fixtures.ts`) so this
  // repository carries no matchable vendor token; the digests below are the
  // ones the single-literal forms had, so a "simplification" or an edit to a
  // fixture cannot slip through unnoticed.
  assert.equal(fixtureFingerprint(SECRET), '4aebcb85b6fa')
  assert.equal(fixtureFingerprint(ROTATED), '965d5e0ea4b0')
  assert.equal(fixtureFingerprint(fixtureToken('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz')), '6675cd0c365d')
})

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
  // Round 4 appended three routes to the five the previous rounds pinned:
  // the history flow, the `@` menu's available list, and the adopt write. Round
  // 5 appends the management surface as **one** registration owning both
  // methods. The original five are unchanged, in the same order.
  //
  // Disclosed change (t9, the 0.4.0 release blocker): this list used to end with
  // TWO rows for `MANAGE_PATH` — `['GET']` and `['POST']` — because the plugin
  // really did register that exact path twice. The real registry keys its table
  // by pathname alone, so the second registration threw and the whole entry
  // failed to activate in the field; this fake registry accepted it, and this
  // assertion then pinned the broken shape as expected. The two rows are now one
  // row with both methods. No other row was altered or removed.
  assert.deepEqual(registered, [
    { path: PENDING_PATH, methods: ['GET'] },
    { path: ATTACHED_PATH, methods: ['GET'] },
    { path: ATTACH_PATH, methods: ['POST'] },
    { path: RELEASE_PATH, methods: ['POST'] },
    { path: HISTORY_PATH, methods: ['GET'] },
    { path: AVAILABLE_PATH, methods: ['GET'] },
    { path: ADOPT_PATH, methods: ['POST'] },
    { path: ANSWER_PATH, methods: ['POST'] },
    { path: MANAGE_PATH, methods: ['GET', 'POST'] },
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

// ---------------------------------------------------------------------------
// Round 5: the management surface (`secret_manage` + `/api/secret.manage`).
//
// These tests are about the two things that make the surface safe rather than
// merely useful: an agent can never carry a value, and nothing durable happens
// until a human says so — with "unbind" and "delete" kept apart at every layer.
// ---------------------------------------------------------------------------

test('secret_manage is registered with no way to pass a value', () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)

  const tool = harness.tools.find((candidate) => candidate.name === 'secret_manage')
  assert.notEqual(tool, undefined, 'secret_manage was never registered')
  const parameters = (tool as { parameters: { properties?: Record<string, unknown>; required?: string[] } }).parameters
  // The whole point, as a schema property set: there is no `value` here, and no
  // alias for one either.
  assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), [
    'action',
    'reason',
    'target',
    'to',
    'variable',
  ])
  assert.deepEqual([...(parameters.required ?? [])].sort(), ['action', 'reason'])
  assert.equal((tool as { timeoutMs?: number }).timeoutMs, 300000 + 30000)

  // `secret_request` is untouched by the round: same schema, same required set.
  const request = harness.tools.find((candidate) => candidate.name === 'secret_request')
  assert.deepEqual(
    Object.keys(
      (request as { parameters: { properties?: Record<string, unknown> } }).parameters.properties ?? {},
    ).sort(),
    ['description', 'envVar', 'label', 'name', 'reason', 'scope'],
  )
})

/**
 * U1 as a machine-checkable fact: `list` is read-only, so a delegated child may
 * ask it — and what it gets back is *its own* session's facts, never the
 * parent's. Every action that changes something needs a human answerer, and a
 * child has none, so it must fail closed and hang nowhere.
 */
test('only the live root may change anything: a delegated child can list its own session and nothing else', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // The root really does hold a store-backed row and a session-only one, so a
  // child's listing proves isolation rather than an empty world.
  await seedSession(harness, session)
  // The second variable exists in this session and in no store: the parent's own
  // fact, the thing a child must never be handed.
  await postAttach(harness, session, {
    name: 'local-only',
    label: 'Local Only',
    scope: 'session',
    envVar: 'DSH_SECRET_LOCAL_ONLY',
    value: SECRET,
  })

  const root = (await manage(harness, session, { action: 'list', reason: 'mine' })) as {
    entries: { variable: string; source: string; can: Record<string, boolean> }[]
  }
  assert.deepEqual(
    root.entries.map((entry) => ({ variable: entry.variable, source: entry.source })),
    [
      { variable: 'DSH_SECRET_LOCAL_ONLY', source: 'session' },
      { variable: ENV_VAR, source: 'both' },
    ],
    'the root holds the session-only row and the store-backed one',
  )

  const child = sessionWithCall('call-child', 'session-child')
  harness.sessions.set(child.id, child)
  harness.delegated.add(child.id)
  // Seeding is the only thing allowed to have written anything by now; every
  // refusal below must leave these two counts untouched.
  const writesBefore = harness.setCalls.length
  const commitsBefore = harness.commits.length

  // list: allowed. What comes back is the store's global, value-free rows only —
  // never the parent session's own variable, and never a session-side fact.
  const listed = (await manage(harness, child, { action: 'list', reason: 'what can I use' })) as {
    decision: string
    entries: { variable: string; source: string; can: Record<string, boolean> }[]
  }
  assert.equal(listed.decision, 'listed')
  assert.deepEqual(
    listed.entries.some((entry) => entry.variable === 'DSH_SECRET_LOCAL_ONLY'),
    false,
    'a child never sees the parent session’s own variables',
  )
  assert.deepEqual(listed.entries.map((entry) => entry.variable), [ENV_VAR])
  for (const entry of listed.entries) {
    assert.equal(entry.source, 'store', 'only the credential store’s side is visible to a child')
    assert.deepEqual(entry.can, { unbind: false, delete: true, scope: false, value: true })
  }
  // No dialog was created for a read, for a child any more than for a root.
  assert.deepEqual((await pendingPayload(harness)).requests ?? [], [])

  // The four changing actions: refused structurally, before any dialog exists.
  const write: readonly { args: Record<string, unknown>; caller: FakeSession; code: string }[] = [
    { args: { action: 'unbind', variable: ENV_VAR, reason: 'done' }, caller: child, code: 'DELEGATED_CALLER' },
    { args: { action: 'delete', variable: ENV_VAR, reason: 'gone' }, caller: child, code: 'DELEGATED_CALLER' },
    { args: { action: 'scope', variable: ENV_VAR, to: 'session', reason: 'soften' }, caller: child, code: 'DELEGATED_CALLER' },
    { args: { action: 'value', variable: ENV_VAR, target: 'session', reason: 'rotate' }, caller: child, code: 'DELEGATED_CALLER' },
    // A stale id is a different failure with its own code, not a delegated one.
    { args: { action: 'list', reason: 'anything' }, caller: { id: 'session-gone' } as unknown as FakeSession, code: 'CALLER_NOT_LIVE' },
  ]
  let callId = 0
  for (const entry of write) {
    callId += 1
    await assert.rejects(
      () => manage(harness, entry.caller, entry.args, `call-d${String(callId)}`),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, entry.code, String(error))
        return true
      },
    )
  }

  // Nothing changed anywhere: no dialog, no durable write, no session-side
  // exposure touched, and the root's own listing is exactly as it was.
  assert.deepEqual((await pendingPayload(harness)).requests ?? [], [])
  assert.deepEqual(harness.unsetCalls, [])
  assert.deepEqual(harness.deleteCalls, [])
  assert.equal(harness.setCalls.length, writesBefore, 'a refused action writes no value')
  assert.equal(harness.commits.length, commitsBefore, 'a refused action commits no record')
  const still = (await manage(harness, session, { action: 'list', reason: 'still mine' })) as {
    entries: { variable: string; source: string; can: Record<string, boolean> }[]
  }
  assert.deepEqual(
    still.entries.map((entry) => ({ variable: entry.variable, source: entry.source, can: entry.can })),
    [
      {
        variable: 'DSH_SECRET_LOCAL_ONLY',
        source: 'session',
        can: { unbind: true, delete: false, scope: true, value: true },
      },
      { variable: ENV_VAR, source: 'both', can: { unbind: true, delete: true, scope: true, value: true } },
    ],
    'every refused action left the root’s own state exactly as it was',
  )
  unload(harness)
})

test('list answers without a human and reports names and metadata only', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  await seedSession(harness, session)

  const result = (await manage(harness, session, { action: 'list', reason: 'what can I use' })) as {
    decision: string
    entries: { variable: string; source: string; scope: string; can: Record<string, boolean> }[]
  }
  assert.equal(result.decision, 'listed')
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.equal(entry?.variable, ENV_VAR)
  assert.equal(entry?.source, 'both', 'the session side and the store side are reported as one row')
  assert.deepEqual(entry?.can, { unbind: true, delete: true, scope: true, value: true })
  // The invariant, at the wiring level: no value anywhere in the listing.
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  // No dialog was created: a read needs no human.
  const pending = await pendingPayload(harness)
  assert.deepEqual(pending.requests ?? [], [])
  unload(harness)
})

test('a staged-free session can still be listed from the store side alone', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })

  const list = await manageList(harness, session.id)
  assert.deepEqual(list.entries?.map((entry) => entry.variable), [ENV_VAR])
  assert.equal(list.entries?.[0]?.source, 'store')
  assert.deepEqual(list.entries?.[0]?.can, { unbind: false, delete: true, scope: false, value: true })
})

test('unbind needs a human, never touches the store, and says so in the history', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A session-scoped grant: really exposed, with nothing durable behind it.
  const granted = call(harness, session, requestArgs('session'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await granted
  const contributor = harness.contributors[0]
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  const pending = manage(harness, session, { action: 'unbind', variable: ENV_VAR, reason: 'done with it' })
  const id = await firstPendingId(harness)

  // Nothing happens while the question is still open, and the exposure stays live.
  assert.deepEqual(harness.unsetCalls, [])
  assert.deepEqual(harness.deleteCalls, [])
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  // Refusing leaves everything exactly as it was.
  await submit(harness, { id, decision: 'rejected', reason: 'no' })
  const refused = (await pending) as { decision: string }
  assert.equal(refused.decision, 'rejected')
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })
  assert.deepEqual(harness.unsetCalls, [])
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), false)

  // Approving removes the session's exposure and nothing else.
  const second = manage(harness, session, { action: 'unbind', variable: ENV_VAR, reason: 'done with it' }, 'call-m2')
  await answerNext(harness, (requestId) => ({ id: requestId, decision: 'approved', scope: 'session' }))
  const applied = (await second) as { decision: string; action?: string; changed?: { session?: boolean; store?: boolean } }
  assert.equal(applied.decision, 'applied')
  assert.equal(applied.action, 'unbind')
  assert.deepEqual(applied.changed, { session: true, store: false })
  // The store's two halves are untouched: this tier never deletes anything.
  assert.deepEqual(harness.unsetCalls, [])
  assert.deepEqual(harness.deleteCalls, [])
  // The variable stops being injected for this session.
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), {})
  // And the history says which of the two things happened.
  const history = await historyFor(harness, session.id)
  const unbound = history.entries?.find((entry) => entry.event === 'unbound')
  assert.notEqual(unbound, undefined, 'an unbind must be recorded as its own event')
  assert.equal(unbound?.source, 'manage')
})

test('the two downgrade buttons do two different things, and neither is hidden', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  await seedSession(harness, session)

  // Button one: "only make it session" keeps the store record. Nothing
  // destructive happens, so it needs no danger confirmation.
  const softened = await postManage(harness, { sessionId: session.id, action: 'scope', variable: ENV_VAR, to: 'session' })
  assert.equal(softened.status, 200)
  assert.deepEqual(softened.body.changed, { session: true, store: false })
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), true, 'the record stays')
  assert.equal(harness.store.get(ENV_VAR), SECRET, 'the value stays')
  assert.deepEqual(harness.unsetCalls, [])
  assert.deepEqual(harness.deleteCalls, [])
  let list = await manageList(harness, session.id)
  assert.equal(list.entries?.[0]?.scope, 'session')
  assert.equal(list.entries?.[0]?.source, 'both', 'the store half is reported separately, and honestly')
  assert.equal(list.entries?.[0]?.can.delete, true, 'and it can still be deleted, by its own button')

  // Button two: "stop being durable and delete the record" is the delete action.
  const purged = await postManage(harness, { sessionId: session.id, action: 'delete', variable: ENV_VAR, confirm: true })
  assert.equal(purged.status, 200)
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), false)
  assert.equal(harness.store.has(ENV_VAR), false)
  list = await manageList(harness, session.id)
  assert.equal(list.entries?.[0]?.scope, 'session', 'the session copy stays usable, reported as session-scoped')
  assert.equal(list.entries?.[0]?.can.delete, false)
  unload(harness)
})

test('delete needs a confirmation, then removes the value before the record', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  await seedSession(harness, session)

  const pending = manage(harness, session, { action: 'delete', variable: ENV_VAR, reason: 'rotate it' })
  const id = await firstPendingId(harness)

  // Unconfirmed: no durable side effect at all, and no history row claiming one.
  assert.deepEqual(harness.unsetCalls, [])
  assert.deepEqual(harness.deleteCalls, [])
  assert.equal(harness.store.get(ENV_VAR), SECRET)
  const before = await historyFor(harness, session.id)
  assert.equal(before.entries?.some((entry) => entry.event === 'deleted'), false)

  await submit(harness, { id, decision: 'approved', scope: 'persistent' })
  const applied = (await pending) as { decision: string; changed?: { store?: boolean }; notice?: string }
  assert.equal(applied.decision, 'applied')
  assert.equal(applied.changed?.store, true)
  // The order is the mechanism: the refusal-prone value removal first, the
  // record second, so a refusal cannot leave a marker without a value.
  const unsetAt = harness.events.findIndex((event) => event === `unset:${ENV_VAR}`)
  const deleteAt = harness.events.findIndex((event) => event === 'deleteRecord:cordis-plugin-secret/openai')
  assert.notEqual(unsetAt, -1)
  assert.notEqual(deleteAt, -1)
  assert.equal(unsetAt < deleteAt, true)
  assert.equal(harness.store.has(ENV_VAR), false)
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), false)
  // The session's copy stays usable, and its scope is reported as session-only.
  const list = await manageList(harness, session.id)
  assert.equal(list.entries?.[0]?.scope, 'session')
  assert.equal(list.entries?.[0]?.can.delete, false)
  const history = await historyFor(harness, session.id)
  assert.equal(history.entries?.some((entry) => entry.event === 'deleted'), true)
  unload(harness)
})

test('delete refuses a variable the store does not hold, without asking anyone', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A session-side record with no durable half: the one shape a real deletion
  // must refuse, because there is nothing in the store to delete.
  await postAttach(harness, session, {
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
  })

  await assert.rejects(
    () => manage(harness, session, { action: 'delete', variable: ENV_VAR, reason: 'nothing there' }),
    /凭据库里没有/u,
  )
  const pending = await pendingPayload(harness)
  assert.deepEqual(pending.requests ?? [], [], 'a refusal before the dialog asks nobody')
  unload(harness)
})

test('a scope change to persistent goes through the authorization seam', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A session-side record with no durable half yet: the case a re-scope exists
  // for.
  await postAttach(harness, session, {
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    envVar: ENV_VAR,
    value: SECRET,
  })
  assert.deepEqual(harness.setCalls, [], 'a session-scope attach writes no value')
  assert.deepEqual(harness.commits, [])

  const pending = manage(harness, session, { action: 'scope', variable: ENV_VAR, to: 'persistent', reason: 'keep it' })
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'persistent' }))
  const applied = (await pending) as { decision: string; scope?: string; changed?: { store?: boolean } }
  assert.equal(applied.decision, 'applied')
  assert.equal(applied.scope, 'persistent')
  assert.equal(applied.changed?.store, true)
  // The value this session already held was written, and the seam committed the
  // value-free marker — the plugin never wrote the record itself.
  assert.deepEqual(harness.setCalls, [SECRET])
  assert.equal(harness.commits.length, 1)
  assert.equal(
    JSON.stringify((harness.commits[0] as { record?: unknown } | undefined)?.record).includes(SECRET),
    false,
  )
  assert.equal(harness.events.some((event) => event.startsWith('begin:cordis-plugin-secret/openai')), true)
  const history = await historyFor(harness, session.id)
  const changed = history.entries?.find((entry) => entry.event === 'scope-changed')
  assert.notEqual(changed, undefined)
  assert.equal(changed?.scope, 'persistent')
})

test('a value change carries the human’s value and never echoes it', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  await seedSession(harness, session)
  const writesBefore = harness.setCalls.length

  const pending = manage(harness, session, {
    action: 'value',
    variable: ENV_VAR,
    target: 'session',
    reason: 'the key rotated',
  })
  const id = await firstPendingId(harness)

  // An approval without a value is refused: the Host decides that a value action
  // needs one, and the answer route holds the approval to it.
  const empty = await submit(harness, { id, decision: 'approved', scope: 'session' })
  assert.equal(empty.status, 400)

  await submit(harness, { id, decision: 'approved', scope: 'session', value: 'sk-rotated-2' })
  const applied = (await pending) as { decision: string; changed?: { session?: boolean; store?: boolean } }
  assert.equal(applied.decision, 'applied')
  assert.deepEqual(applied.changed, { session: true, store: false })
  // The result the agent gets never carries the human's value.
  assert.equal(JSON.stringify(applied).includes('sk-rotated-2'), false)
  // A session-target change writes nothing durable.
  assert.equal(harness.setCalls.length, writesBefore, 'a session-target change writes nothing durable')
  const history = await historyFor(harness, session.id)
  const updated = history.entries?.find((entry) => entry.event === 'updated')
  assert.notEqual(updated, undefined)
  assert.equal(updated?.source, 'manage')
  unload(harness)
})

/**
 * The positive control for every value scan in this file.
 *
 * A `JSON.stringify(...).includes(SECRET) === false` assertion only means
 * something if the value really was in the system when the scan ran. This drives
 * the *change* path with a second sentinel and reads the session's own exposure
 * back: the new value is provably there, and the surface the agent sees still
 * carries none of it.
 */
test('the value the human typed really lands in this session, and still not in the agent’s result', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A session-scoped grant: a real exposure with a live contributor, which is
  // the one surface that may hand the value to a shell.
  const granted = call(harness, session, requestArgs('session'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await granted
  const contributor = harness.contributors[0]
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  const pending = manage(harness, session, {
    action: 'value',
    variable: ENV_VAR,
    target: 'session',
    reason: 'the key rotated',
  })
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: ROTATED }))
  const applied = await pending

  // Positive control: the human's new value is what this session now injects.
  assert.deepEqual(
    contributor?.resolve({ agent: { id: session.id } }),
    { [ENV_VAR]: ROTATED },
    'the change really took effect in this session',
  )
  // Negative result of the same kind of scan, now provably not vacuous.
  assert.equal(JSON.stringify(applied).includes(ROTATED), false, 'the tool result never carries the new value')
  assert.equal(JSON.stringify(applied).includes(SECRET), false, 'nor the one it replaced')
  // …and the scan itself would have caught it: the value is in the object that
  // holds it, so `false` above is about the result, not about a broken sweep.
  assert.equal(JSON.stringify({ value: ROTATED }).includes(ROTATED), true)
  // The pending payload the page reads carries metadata only.
  const payload = await pendingPayload(harness)
  assert.equal(JSON.stringify(payload).includes(ROTATED), false)
  unload(harness)
})

test('the manage route keeps the two deletion tiers apart, by construction', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  await seedSession(harness, session)

  // A value is only accepted for the action that has a use for it.
  const smuggled = await postManage(harness, {
    sessionId: session.id,
    action: 'delete',
    variable: ENV_VAR,
    confirm: true,
    value: SECRET,
  })
  assert.equal(smuggled.status, 400)
  // A real deletion without the explicit confirmation is refused.
  const unconfirmed = await postManage(harness, { sessionId: session.id, action: 'delete', variable: ENV_VAR })
  assert.equal(unconfirmed.status, 400)
  assert.deepEqual(harness.deleteCalls, [])
  // Unbind carries no confirmation, because there is nothing irreversible about it.
  const wrongTier = await postManage(harness, {
    sessionId: session.id,
    action: 'unbind',
    variable: ENV_VAR,
    confirm: true,
  })
  assert.equal(wrongTier.status, 400)
  assert.deepEqual(harness.unsetCalls, [])

  // The unbind the human asked for, through the route the info box uses.
  const released = await postManage(harness, { sessionId: session.id, action: 'unbind', variable: ENV_VAR })
  assert.equal(released.status, 200)
  assert.deepEqual(released.body.changed, { session: true, store: false })
  assert.deepEqual(harness.unsetCalls, [], 'the unbind tier must never remove a stored value')
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), true)
  // And the store record survives it: that is what makes it re-adoptable.
  const list = await manageList(harness, session.id)
  assert.equal(list.entries?.[0]?.can.delete, true)
  unload(harness)
})

// ---------------------------------------------------------------------------
// Round 5, second pass (the user's ruling ①): "usable in this session" means
// *both* directions that put a record in this session — the human's attach
// direction and the agent's ask direction — and each row says which one it is.
// ---------------------------------------------------------------------------

test('the session section lists the ask direction too, and keeps the two directions apart', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // (a) the attach direction: a staged entry this session holds.
  await postAttach(harness, session, {
    name: 'local-only',
    label: 'Local Only',
    scope: 'session',
    envVar: 'DSH_SECRET_LOCAL_ONLY',
    value: SECRET,
  })
  // (b) the ask direction: a live grant the human approved through
  // `secret_request`. Before the ruling this variable was usable and invisible.
  const granted = call(harness, session, requestArgs('session'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'session', value: SECRET }))
  await granted

  const list = await manageList(harness, session.id)
  assert.deepEqual(
    list.entries?.map((entry) => ({
      variable: entry.variable,
      state: entry.state,
      origin: entry.origin,
      source: entry.source,
      scope: entry.scope,
      can: entry.can,
    })),
    [
      {
        variable: 'DSH_SECRET_LOCAL_ONLY',
        state: 'staged',
        origin: 'attach',
        source: 'session',
        scope: 'session',
        can: { unbind: true, delete: false, scope: true, value: true },
      },
      {
        variable: ENV_VAR,
        state: 'authorized',
        origin: 'request',
        source: 'session',
        scope: 'session',
        can: { unbind: true, delete: false, scope: true, value: true },
      },
    ],
    'both directions are in the session section, each row saying which one it is',
  )
  // The ask direction's own facts, not the variable name standing in for them.
  assert.equal(list.entries?.[1]?.name, 'openai')
  assert.equal(list.entries?.[1]?.label, 'OpenAI', 'the label the human approved, not the variable name')
  // Whichever direction put a row there, the list stays value-free.
  assert.equal(JSON.stringify(list).includes(SECRET), false)
  assert.equal(JSON.stringify(list).includes(ROTATED), false)

  // The model-facing rendering says the same two things — and calls `can` what
  // it is (what the row supports), never "what you can run".
  const args = { action: 'list', reason: 'what can I use' }
  const rendered = renderManage(harness, args, await manage(harness, session, args))
  assert.equal(rendered.includes('DSH_SECRET_LOCAL_ONLY'), true)
  assert.equal(rendered.includes('已授权（Agent 经 secret_request 获得）'), true)
  assert.equal(rendered.includes('该行支持的动作'), true)
  assert.equal(rendered.includes('可用动作'), false)
  assert.equal(rendered.includes(SECRET), false)

  // Neither row belongs to another session's list.
  const elsewhere = await manageList(harness, 'session-elsewhere')
  assert.deepEqual(elsewhere.entries, [])
  unload(harness)
})

test('a variable the store also holds is still one row, and the ask direction keeps its own name', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // The ask direction put a live grant in this session...
  const granted = call(harness, session, requestArgs('persistent'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'persistent', value: SECRET }))
  await granted
  // ...and the seam's own commit left the value-free marker in the store. The
  // fake seam reports commits rather than writing them, so it is seeded here;
  // `harness.commits[0]` is that marker, asserted by the test above.
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })

  const list = await manageList(harness, session.id)
  assert.equal(list.entries?.length, 1, 'one variable is one row: the store half is not a second row')
  assert.equal(list.entries?.[0]?.state, 'authorized')
  assert.equal(list.entries?.[0]?.origin, 'request')
  assert.equal(list.entries?.[0]?.source, 'both', 'both halves are reported, and the direction is still named')
  assert.equal(list.entries?.[0]?.scope, 'persistent')
  assert.deepEqual(list.entries?.[0]?.can, { unbind: true, delete: true, scope: true, value: true })
  unload(harness)
})

test('a delegated child is told which of the listed actions it cannot run', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A store record, so the child's own listing has a row whose `can` is true.
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })
  const child = sessionWithCall('call-child', 'session-child')
  harness.sessions.set(child.id, child)
  harness.delegated.add(child.id)

  const args = { action: 'list', reason: 'what can I use' }
  const listed = (await manage(harness, child, args)) as {
    decision: string
    notice?: string
    entries: { variable: string; can: Record<string, boolean> }[]
  }
  assert.equal(listed.decision, 'listed')
  assert.deepEqual(listed.entries.map((entry) => entry.variable), [ENV_VAR])
  assert.equal(typeof listed.notice, 'string', 'the child is told the listed actions are out of its reach')
  assert.equal((listed.notice ?? '').includes('DELEGATED_CALLER'), true)

  const rendered = renderManage(harness, args, listed)
  assert.equal(rendered.includes('该行支持的动作'), true)
  assert.equal(rendered.includes('可用动作'), false)
  assert.equal(rendered.includes('DELEGATED_CALLER'), true)
  assert.equal(rendered.includes('主会话'), true)

  // Positive control: the live root's own listing carries no such caveat, so the
  // test cannot pass by rendering the notice unconditionally.
  const root = (await manage(harness, session, args)) as { notice?: string }
  assert.equal(root.notice, undefined)
  assert.equal(renderManage(harness, args, root).includes('DELEGATED_CALLER'), false)
  unload(harness)
})

test('the actions an ask-direction row offers really work on it', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  applyPlugin(harness)
  // A persistent grant from the ask direction: it is injected for this session
  // and the store holds its marker, so the row offers all four actions.
  const granted = call(harness, session, requestArgs('persistent'))
  await answerNext(harness, (id) => ({ id, decision: 'approved', scope: 'persistent', value: SECRET }))
  await granted
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })
  const contributor = harness.contributors[0]
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), { [ENV_VAR]: SECRET })

  const before = await manageList(harness, session.id)
  assert.equal(before.entries?.[0]?.can.unbind, true, 'the row says unbind is possible for it')

  // The unbind the row offered, through the route the info box uses.
  const released = await postManage(harness, { sessionId: session.id, action: 'unbind', variable: ENV_VAR })
  assert.equal(released.status, 200)
  assert.deepEqual(released.body.changed, { session: true, store: false })
  assert.deepEqual(harness.unsetCalls, [], 'the unbind tier never removes a stored value')
  assert.equal(harness.records.has('cordis-plugin-secret/openai'), true)
  assert.deepEqual(contributor?.resolve({ agent: { id: session.id } }), {}, 'the variable stops being injected')
  const history = await historyFor(harness, session.id)
  assert.equal(history.entries?.some((entry) => entry.event === 'unbound'), true)
  // The session row is gone; the store half is reported on its own, and honestly:
  // no direction (there is no session-side record any more) and no unbind.
  const after = await manageList(harness, session.id)
  assert.equal(after.entries?.length, 1)
  assert.equal(after.entries?.[0]?.variable, ENV_VAR)
  assert.equal(after.entries?.[0]?.state, 'stored')
  assert.equal(after.entries?.[0]?.source, 'store')
  assert.equal(after.entries?.[0]?.origin, undefined)
  assert.equal(after.entries?.[0]?.can.unbind, false)
  unload(harness)
})

// ---------------------------------------------------------------------------
// The registry's own contract: the 0.4.0 release blocker.
//
// In the field the whole plugin entry failed to activate with
//   connection: exact Fetch route "/api/secret.manage" is already registered
// because that path was registered twice, once for GET and once for POST, while
// the real registry keys its table by pathname alone and therefore ignores
// `methods` when it decides whether a path is taken
// (`@deepseek-ai/dsh-client-connection/lib/index.js:625-639`, throw at `:633`).
//
// Every harness in this file used to *record* registrations without enforcing
// that rule, so no amount of behaviour coverage could see the duplicate. The
// registry below enforces it, which is what makes the test able to fail on the
// broken shape.
// ---------------------------------------------------------------------------

test('the strict registry refuses a duplicate exact path, as the real one does', () => {
  const harness = buildContext(sessionWithCall('call-1'), { strictFetch: true })
  const registry = (harness.ctx as {
    connection: { fetch: { register: (route: RouteRegistration) => unknown } }
  }).connection.fetch
  const route: RouteRegistration = {
    path: '/api/secret.test',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(new Response('ok')),
  }
  registry.register(route)
  // Same exact path, different methods: still refused. This is the rule the
  // 0.4.0 duplicate slipped past every lenient fake registry.
  assert.throws(
    () => registry.register({ ...route, methods: ['POST'] }),
    /exact Fetch route "\/api\/secret\.test" is already registered/u,
  )
  // `assertFetchRoute` (`:758-762`) is replicated too, so the fake cannot pass
  // a shape the real registry would reject before it even looks at the table.
  assert.throws(
    () => registry.register({ ...route, path: '/api/secret.again', methods: ['GET', 'GET'] }),
    /repeats a method/u,
  )
  assert.throws(
    () => registry.register({ ...route, path: '/api/secret.empty', methods: [] }),
    /declares no methods/u,
  )
})

test('every exact Fetch path is registered once, and the manage path owns both methods', async () => {
  const session = sessionWithCall('call-1')
  // Strict: a second registration for one exact path throws inside `apply`,
  // exactly where the field threw.
  const harness = buildContext(session, { strictFetch: true })
  applyPlugin(harness)

  const paths = harness.routes.map((route) => route.path)
  assert.equal(new Set(paths).size, paths.length, 'no exact path may be registered twice')

  // The whole table, path × methods — the evidence this fix has to carry.
  assert.deepEqual(
    harness.routes.map((route) => `${route.path} ${[...route.methods].join('+')}`).sort(),
    [
      `${PENDING_PATH} GET`,
      `${ATTACHED_PATH} GET`,
      `${HISTORY_PATH} GET`,
      `${AVAILABLE_PATH} GET`,
      `${ATTACH_PATH} POST`,
      `${RELEASE_PATH} POST`,
      `${ANSWER_PATH} POST`,
      `${ADOPT_PATH} POST`,
      `${MANAGE_PATH} GET+POST`,
    ].sort(),
  )

  // One registration, dispatched by the request method: the read answers here…
  const manage = routeFor(harness, MANAGE_PATH, 'GET')
  assert.equal(manage.requestBody, 'buffered')
  const read = await manage.fetch({
    method: 'GET',
    url: `http://local${MANAGE_PATH}?sessionId=${session.id}`,
  } as never)
  assert.equal(read.status, 200)
  assert.deepEqual(((await read.json()) as { entries?: unknown[] }).entries, [])
  // …and the read keeps its own refusal when the query is incomplete.
  const noSession = await manage.fetch({ method: 'GET', url: `http://local${MANAGE_PATH}` } as never)
  assert.equal(noSession.status, 400)
  assert.equal(((await noSession.json()) as { error?: string }).error, 'manage.sessionId is required')

  // …and the *same* registration performs an action for POST, through the same
  // service the separate route used, with the same rules.
  harness.records.set('cordis-plugin-secret/openai', {
    version: 1,
    envVar: ENV_VAR,
    name: 'openai',
    scope: 'persistent',
    authorizedAt: 1,
  })
  const unconfirmed = await manage.fetch({
    method: 'POST',
    url: `http://local${MANAGE_PATH}`,
    json: async () => ({ sessionId: session.id, action: 'delete', variable: ENV_VAR }),
  } as never)
  assert.equal(unconfirmed.status, 400, 'the POST half keeps the confirmation rule')
  assert.deepEqual(harness.deleteCalls, [], 'and a refused POST writes nothing')
  const malformed = await manage.fetch({
    method: 'POST',
    url: `http://local${MANAGE_PATH}`,
    json: async () => {
      throw new Error('not json')
    },
  } as never)
  assert.equal(malformed.status, 400)
  assert.equal(((await malformed.json()) as { error?: string }).error, 'manage body must be JSON')
  // And the POST half really runs: the two-step delete completes through it.
  const confirmed = await manage.fetch({
    method: 'POST',
    url: `http://local${MANAGE_PATH}`,
    json: async () => ({ sessionId: session.id, action: 'delete', variable: ENV_VAR, confirm: true }),
  } as never)
  assert.equal(confirmed.status, 200)
  assert.deepEqual(harness.deleteCalls, ['cordis-plugin-secret/openai'])
  unload(harness)
})

// ---------------------------------------------------------------------------
// R1: a credential key the human left blank (round 7)
//
// Two promises are asserted here, and nothing else: a blank key never blocks
// (the local rule decides, and an absent model is fine), and a model suggestion
// is session-free and redacted.
// ---------------------------------------------------------------------------

/** Post one attach body and hand back the route's own answer. */
async function attachBody(
  harness: Harness,
  session: FakeSession,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await routeFor(harness, ATTACH_PATH, 'POST').fetch({
    method: 'POST',
    url: `http://local${ATTACH_PATH}`,
    json: async () => ({ sessionId: session.id, ...body }),
  } as never)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** A fake optional `llm` service whose one stream yields these text chunks. */
function fakeLlm(chunks: readonly string[], calls: Record<string, unknown>[]): unknown {
  return {
    stream(options: Record<string, unknown>) {
      calls.push(options)
      return (async function* () {
        for (const text of chunks) yield { type: 'text-delta', text }
      })()
    },
  }
}

test('R1: with no model in the profile the key is completed locally and the plugin still activates', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  // Positive control for the optional wiring: `setLlm` is never called here, so
  // this is a profile with no `llm` service at all.
  applyPlugin(harness)

  assert.equal(harness.tools.length, 2, 'the plugin must activate without any llm service')
  const answer = await attachBody(harness, session, { label: 'OpenAI API Key', scope: 'session', value: SECRET })
  assert.equal(answer.status, 200)
  assert.equal(answer.body['variable'], 'DSH_SECRET_OPENAI_KEY', 'the value’s public category names the key')
  assert.equal(JSON.stringify(answer.body).includes(SECRET), false, 'the answer never carries the value')
  unload(harness)
})

test('R1: the key is asked of the session’s own model, session-free and redacted', async () => {
  const session = sessionWithCall('call-1')
  session.header = { provider: 'deepseek', model: 'deepseek-chat' }
  const harness = buildContext(session)
  const calls: Record<string, unknown>[] = []
  harness.setLlm(fakeLlm(['github', '-token'], calls))
  applyPlugin(harness)

  const before = session.events.length
  const answer = await attachBody(harness, session, { label: 'GitHub token', scope: 'session', value: SECRET })
  assert.equal(answer.status, 200)
  assert.equal(answer.body['variable'], 'DSH_SECRET_GITHUB_TOKEN', 'the model’s answer became the key')

  assert.equal(calls.length, 1, 'exactly one suggestion per attach')
  const options = calls[0] as Record<string, unknown>
  assert.equal(options['provider'], 'deepseek', 'the session’s own route')
  assert.equal(options['model'], 'deepseek-chat')
  assert.equal(options['purpose'], 'session-title', 'the purpose that forces reasoning effort off')
  assert.equal('sessionId' in options, false, 'the call is session-free')
  assert.equal('tools' in options, false, 'no tool is offered')

  const sent = JSON.stringify(options)
  assert.equal(sent.includes(SECRET), false, 'the plaintext never reaches the model')
  assert.equal(sent.includes('DO-NOT-LEAK'), false)
  // Positive control: the same sweep does find the sentinel where it really is.
  assert.equal(JSON.stringify({ value: SECRET }).includes(SECRET), true)
  assert.equal(sent.includes('GitHub token'), true, 'the human title is what the model reads')
  assert.equal(sent.includes('category=openai-like'), true, 'so are the shape tokens')

  assert.equal(session.events.length, before, 'no session event was appended')
  assert.equal(session.appends, 0, 'nothing appended to the session')
  unload(harness)
})

test('R1: an unusable or empty model answer falls back to the local key', async () => {
  for (const chunks of [['!!!'], [], ['   ', '\n']] as const) {
    const session = sessionWithCall('call-1')
    session.header = { provider: 'deepseek', model: 'deepseek-chat' }
    const harness = buildContext(session)
    const calls: Record<string, unknown>[] = []
    harness.setLlm(fakeLlm(chunks, calls))
    applyPlugin(harness)
    const answer = await attachBody(harness, session, { label: 'OpenAI API Key', scope: 'session', value: SECRET })
    assert.equal(answer.status, 200)
    assert.equal(answer.body['variable'], 'DSH_SECRET_OPENAI_KEY', `fallback for ${JSON.stringify(chunks)}`)
    assert.equal(calls.length, 1, 'the model was still asked')
    unload(harness)
  }
})

test('R1: a session with no logged model route never reaches the model, and still attaches', async () => {
  const session = sessionWithCall('call-1')
  // No `header`, so `requestHeader()` answers undefined: the suggestion has no
  // provider/model to name and must decline instead of guessing one.
  const harness = buildContext(session)
  const calls: Record<string, unknown>[] = []
  harness.setLlm(fakeLlm(['github-token'], calls))
  applyPlugin(harness)

  const answer = await attachBody(harness, session, { label: 'OpenAI API Key', scope: 'session', value: SECRET })
  assert.equal(answer.status, 200)
  assert.equal(answer.body['variable'], 'DSH_SECRET_OPENAI_KEY', 'the local rule decides')
  assert.equal(calls.length, 0, 'a model with no route is not called')
  unload(harness)
})

test('R1: a model answer that collides with an existing key is refused, and the local key is de-duplicated', async () => {
  const session = sessionWithCall('call-1')
  const harness = buildContext(session)
  harness.records.set('cordis-plugin-secret/github-token', {
    version: 1,
    envVar: 'DSH_SECRET_GITHUB_TOKEN',
    name: 'github-token',
    scope: 'persistent',
    authorizedAt: 1,
  })
  const calls: Record<string, unknown>[] = []
  harness.setLlm(fakeLlm(['github-token'], calls))
  applyPlugin(harness)

  const answer = await attachBody(harness, session, {
    label: 'GitHub token',
    scope: 'session',
    value: fixtureToken('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'),
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body['variable'], 'DSH_SECRET_GITHUB_TOKEN_2', 'never onto an existing record key')
  assert.equal(harness.records.has('cordis-plugin-secret/github-token'), true, 'the existing record is untouched')
  assert.equal(harness.records.has('cordis-plugin-secret/github-token-2'), false, 'a session attach writes no record')
  unload(harness)
})
