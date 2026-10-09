/**
 * Client-half tests for the in-stream secret card.
 *
 * The browser artifact is a classic script (no imports/exports), so it is
 * loaded the way the module system loads it: install `__ModuleLoader__`, import
 * the file for its side effect, and take the registered factory. The factory's
 * `require('react')` is answered with a minimal stub renderer, which lets these
 * tests read the exact element tree the card produces without a browser.
 *
 * Everything here is value-free: the only secret in the file is a sentinel used
 * to prove the value never leaves the input the human typed it into.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { effectiveEnvVar } from '../src/naming.ts'

const CALL_ID = 'call-card-1'
const SESSION_ID = 'session-root'
const SECRET = 'sk-card-DO-NOT-LEAK'
const CARD_KEY = `${String('secret-request'.length)}:secret-request${CALL_ID}`

interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

interface LoadedModule {
  readonly factory: (require: (id: string) => unknown) => {
    readonly inject: readonly string[]
    apply(ctx: unknown): void
  }
}

/** Minimal React stub: a real re-render loop so click handlers can be driven. */
function createRenderer(): {
  readonly react: Record<string, unknown>
  render(component: (props: unknown) => unknown, props: unknown): Element
} {
  const values: unknown[] = []
  let index = 0
  let dirty = false
  const react = {
    createElement(type: unknown, props: unknown, ...children: unknown[]): Element {
      const merged = { ...((props ?? {}) as Record<string, unknown>), children: children.flat() }
      return { type, props: merged }
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const at = index
      index += 1
      if (at >= values.length) {
        values.push(typeof initial === 'function' ? (initial as () => unknown)() : initial)
      }
      return [
        values[at],
        (next: unknown) => {
          const resolved = typeof next === 'function' ? (next as (previous: unknown) => unknown)(values[at]) : next
          if (resolved !== values[at]) {
            values[at] = resolved
            dirty = true
          }
        },
      ]
    },
    useEffect(): void {
      // Effects start polling and would reach for `fetch`; these tests assert the
      // pure decision function and the rendered tree instead.
    },
  }
  return {
    react,
    render(component, props) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        index = 0
        dirty = false
        const tree = component(props) as Element
        if (!dirty) return tree
      }
      throw new Error('the card did not settle within 50 renders')
    },
  }
}

/** Every element in the tree, in document order. */
function elements(node: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const element = node as Element
  out.push(element)
  elements(element.props.children, out)
  return out
}

/** The visible text of one subtree. */
function visibleText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (typeof node !== 'object' || node === null) return ''
  return visibleText((node as Element).props.children)
}

/** Find the first element whose visible text is exactly `label`. */
function byLabel(root: unknown, label: string): Element | undefined {
  return elements(root).find((element) => visibleText(element.props.children) === label)
}

// ---- T0: load the artifact the way the module system does --------------------

const loaded: unknown[] = []
;(globalThis as Record<string, unknown>).__ModuleLoader__ = {
  load: (registration: unknown) => loaded.push(registration),
}

// Side-effect only: importing registers the factory above. The artifact is a
// classic script (no exports), so it is deliberately "not a module" to
// TypeScript; the expect-error doubles as a canary if that ever changes.
// @ts-expect-error -- runtime-only side-effect import of the classic script
await import('../src/client/entry.ts')

const module_ = (loaded[0] as LoadedModule | undefined)
assert.notEqual(module_, undefined, 'the client artifact never registered a factory')
assert.equal(typeof module_?.factory, 'function')

const renderer = createRenderer()
const plugin = (module_ as LoadedModule).factory(() => renderer.react)

const definitions: unknown[] = []
const registrations: { name: string; key?: string; priority?: number; component: unknown }[] = []

// Mount the artifact into a real cordis tree, the way the web entry point does:
// sibling providers for the services it declares, the artifact's own `inject`
// list as the fiber's gate. No optional service is provided here, so this also
// pins that a client without a locale face, a trigger registry and a session
// controller still comes up — a hand-rolled context object has no "read the
// un-injected service and throw" semantics, which is exactly how the entry broke.
const root = new Context()
root.plugin((ctx) => {
  ctx.provide('uiConversation', { events: { register: (definition: unknown) => definitions.push(definition) } })
})
root.plugin((ctx) => {
  ctx.provide('slots', {
    inject: (_owner: string, declare: () => unknown) => declare(),
    register: (options: Record<string, unknown>, component: unknown) => {
      registrations.push({ ...(options as { name: string }), component })
      return () => undefined
    },
  })
})
let applied = false
let startError: unknown
const startFiber = root.plugin({
  inject: [...plugin.inject],
  apply(ctx: unknown) {
    try {
      plugin.apply(ctx)
      applied = true
    } catch (error) {
      startError = error
    }
  },
})
await startFiber
// The providers start on their own microtasks, so wait for the outcome.
for (let attempt = 0; attempt < 25 && !applied && startError === undefined; attempt += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
assert.equal(startError, undefined, `the client artifact threw on startup: ${String(startError)}`)

const seam = (globalThis as Record<string, unknown>).__cordisSecretClient as Record<string, any>

// ---- T2: the node, and the grouping escape ----------------------------------

/** One recorded `tool/call` for this plugin's tool. */
function callEvent(args: unknown, seq = 7): Record<string, unknown> {
  return {
    type: 'tool/call',
    seq,
    data: {
      turn: 1,
      step: 1,
      callId: CALL_ID,
      name: 'secret_request',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

/** One recorded `tool/result` carrying the tool's value-free settlement payload. */
function resultEvent(meta: unknown, seq = 9, isError = false): Record<string, unknown> {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: CALL_ID },
        content: [{ type: 'text', text: '已获授权。' }],
        isError,
      },
      ...(meta === undefined ? {} : { meta }),
      ...(isError ? { error: { name: 'SecretFailure', code: 'TIMEOUT' } } : {}),
    },
  }
}

const REQUEST = {
  name: 'openai',
  label: 'OpenAI API Key',
  reason: '调用 OpenAI 兼容接口补全 /v1/chat/completions 测试',
  description: '只从环境变量读取',
  scope: 'session' as const,
}

/** Build the node one call+result pair produces, exactly as the engine would. */
function buildNode(
  call: Record<string, unknown>,
  result?: Record<string, unknown>,
): Record<string, any> {
  const definition = seam.secretRequestDefinition
  const startMatch = definition.match(call)
  assert.notEqual(startMatch, null, 'the call event did not match the card definition')
  assert.deepEqual(startMatch, { id: CALL_ID, role: 'start' })
  let state = definition.start({}, { event: call })
  if (result !== undefined) {
    const updateMatch = definition.match(result)
    assert.deepEqual(updateMatch, { id: CALL_ID, role: 'update' })
    state = definition.update({ state }, { event: result })
  }
  const node = definition.buildViewNode({ key: CARD_KEY, id: CALL_ID, state, start: { event: call } })
  assert.notEqual(node, null, 'the card node must exist at every stage')
  return node
}

test('the card node exists at tool/call and carries no Turn coordinate', () => {
  const node = buildNode(callEvent(REQUEST))
  assert.equal(node.kind, 'secret-request')
  assert.equal(node.target, 'chat')
  assert.equal(node.key, CARD_KEY)
  assert.equal(node.id, CALL_ID)
  assert.equal(node.visibility, 'visible')
  assert.equal(node.anchorSeq, 7)
  // The escape from the step-process group: a Chat node without a Turn/Step
  // coordinate is emitted as a root flow entry and is never a process member.
  assert.deepEqual(node.location, { kind: 'session' })
  assert.equal('turn' in node.location, false)
  assert.equal(node.data.settled, false)
  assert.equal(node.data.request.reason, REQUEST.reason)
  assert.equal(node.data.request.variable, 'DSH_SECRET_OPENAI')
})

test('the settled node reports the decision from the durable meta, not from prose', () => {
  const node = buildNode(
    callEvent(REQUEST),
    resultEvent({ v: 1, kind: 'secret-request', decision: 'approved', variable: 'DSH_SECRET_OPENAI', scope: 'session', source: 'entered' }),
  )
  assert.equal(node.data.settled, true)
  assert.equal(node.data.outcome.decision, 'approved')
  assert.equal(node.data.outcome.scope, 'session')
  assert.equal(node.data.failure, null)
  assert.deepEqual(node.location, { kind: 'session' })
})

test('a settled failure keeps its structured identity, and an unreadable call still yields a card', () => {
  const failed = buildNode(callEvent(REQUEST), resultEvent(undefined, 9, true))
  assert.equal(failed.data.settled, true)
  assert.equal(failed.data.outcome, null)
  assert.equal(failed.data.failure.code, 'TIMEOUT')

  // Fallback F1: unparseable arguments must never hide the request.
  const unreadable = buildNode(callEvent('{not json'))
  assert.equal(unreadable.data.request, null)
  assert.equal(unreadable.data.requestUnreadable, true)
  assert.equal(unreadable.data.settled, false)
  assert.deepEqual(unreadable.location, { kind: 'session' })

  // Missing state must not blank the surface either.
  const stateless = seam.secretRequestDefinition.buildViewNode({
    key: CARD_KEY,
    id: CALL_ID,
    state: undefined,
    start: { event: callEvent(REQUEST) },
  })
  assert.notEqual(stateless, null)
  assert.equal(stateless.data.callId, CALL_ID)
})

test('exactly one card node and one tool-row placeholder are registered', () => {
  // Updated in round 4: the client half registered TWO conversation
  // definitions — the request card and the side-car attach row (requirement 1 /
  // O2). Round 5 adds a third, the management card (`sr-manage`), and a second
  // tool-row placeholder for its tool. The assertion is not relaxed: every
  // definition is named, in registration order, and the request card's shape is
  // still pinned exactly.
  // Disclosed change: `definitions.length` 2 to 3, the two new named rows below,
  // and the keyed-node list. No prior expectation was removed or altered.
  assert.equal(definitions.length, 3, 'the client half must register the card, the side-car row and the management card')
  assert.equal((definitions[0] as { kind: string }).kind, 'secret-request')
  assert.equal((definitions[0] as { target: string }).target, 'chat')
  assert.equal((definitions[1] as { kind: string }).kind, 'sr-chip')
  assert.equal((definitions[1] as { target: string }).target, 'chat')
  assert.equal((definitions[2] as { kind: string }).kind, 'sr-manage')
  assert.equal((definitions[2] as { target: string }).target, 'chat')

  const byName = (name: string) => registrations.filter((entry) => entry.name === name)
  assert.deepEqual(
    byName('conversation.chat.node').map((entry) => entry.key).sort(),
    ['secret-request', 'sr-chip', 'sr-manage'],
    'one keyed chat node per kind, so none can replace another',
  )
  assert.deepEqual(
    byName('tool.call.toolview').map((entry) => entry.key).sort(),
    ['secret_manage', 'secret_request'],
    'one placeholder per tool, so the generic Tool row never shows for either',
  )
  assert.equal(byName('tool.call.toolview').length, 2)
  assert.equal(
    byName('tool.call.toolview').some((entry) => entry.key === 'secret_request'),
    true,
  )
  assert.equal(
    byName('tool.call.toolview').some((entry) => entry.key === 'secret_manage'),
    true,
  )
  // A keyed slot keeps one entry per key and a later registration replaces the
  // earlier one, so no priority games are needed (or wanted) here. Both
  // placeholders are checked, not just the first: the original assertion named
  // the single row that existed then, and this keeps the same claim about every
  // row that exists now.
  assert.deepEqual(
    byName('tool.call.toolview').map((entry) => entry.priority),
    [undefined, undefined],
  )
  assert.equal(byName('shell.overlay').length, 0)
  assert.equal(byName('conversation.composer').length, 0)
  assert.equal(byName('conversation.chat.commandview').length, 0)

  // The suppressed row renders nothing at all; the card owns visibility.
  assert.equal(seam.HiddenSecretToolRow(), null)
})

// ---- T4: the false-expiry rule ----------------------------------------------

const KEY = { callId: CALL_ID, sessionId: SESSION_ID }
const unreachable = { kind: 'unreachable' } as const
const okWith = (...entries: unknown[]) => ({ kind: 'ok', entries } as const)
const hostEntry = { id: 'req-1', callId: CALL_ID, sessionId: SESSION_ID }
const legacyEntry = { id: 'req-1' }

test('an unreachable or unreadable poll never expires the card', () => {
  for (const probe of [
    unreachable,
    null,
  ]) {
    const state = seam.nextPendingState(probe, { submitted: false }, KEY)
    assert.notEqual(state.status, 'lapsed', 'a failed poll must never read as "request ended"')
  }
  assert.equal(seam.nextPendingState(unreachable, { submitted: false }, KEY).status, 'unreachable')
  // An unreadable body is not an empty waiting list (see readEntries).
  assert.equal(seam.readEntries('<html>auth required</html>'), null)
  assert.equal(seam.readEntries({}), null)
  assert.equal(seam.readEntries({ requests: [] })?.length, 0)
})

test('only a successful poll listing no such call may lapse the card, and never after submitting', () => {
  assert.equal(seam.nextPendingState(okWith(), { submitted: false }, KEY).status, 'lapsed')
  assert.equal(seam.nextPendingState(okWith(), { submitted: true }, KEY).status, 'awaiting-result')
  assert.equal(seam.nextPendingState(unreachable, { submitted: true }, KEY).status, 'awaiting-result')
  // The listed call links (and keeps linking after submission).
  const linked = seam.nextPendingState(okWith(hostEntry), { submitted: false }, KEY)
  assert.equal(linked.status, 'linked')
  assert.equal(linked.entry.id, 'req-1')
  assert.equal(seam.nextPendingState(okWith(hostEntry), { submitted: true }, KEY).status, 'awaiting-result')
  // Another call's entry is not this card's request.
  assert.equal(
    seam.nextPendingState(okWith({ id: 'req-2', callId: 'other-call' }), { submitted: false }, KEY).status,
    'lapsed',
  )
})

test('a version-skewed host is claimed only when exactly one request waits', () => {
  assert.equal(seam.nextPendingState(okWith(legacyEntry), { submitted: false }, KEY).status, 'linked')
  assert.equal(
    seam.nextPendingState(okWith(legacyEntry, { id: 'req-2' }), { submitted: false }, KEY).status,
    'lapsed',
  )
  assert.equal(
    seam.nextPendingState(okWith(legacyEntry), { submitted: false }, { callId: '', sessionId: SESSION_ID }).status,
    'preparing',
  )
})

// ---- T3 / T5: the answering form, and where the value may live ---------------

const CARD_COMPONENT = registrations.find((entry) => entry.name === 'conversation.chat.node')
  ?.component as (props: unknown) => unknown

function cardProps(overrides: Record<string, unknown> = {}): unknown {
  return {
    node: {
      data: {
        callId: CALL_ID,
        request: {
          name: REQUEST.name,
          label: REQUEST.label,
          reason: REQUEST.reason,
          description: REQUEST.description,
          requestedScope: 'session',
          variable: 'DSH_SECRET_OPENAI',
          alreadyConfigured: false,
        },
        requestUnreadable: false,
        settled: false,
        outcome: null,
        failure: null,
      },
    },
    sessionId: SESSION_ID,
    ...overrides,
  }
}

test('the answering form exposes every control the contract requires', () => {
  const tree = renderer.render(CARD_COMPONENT, cardProps())
  const all = elements(tree)
  const text = visibleText(tree)

  assert.equal(text.includes(REQUEST.reason), true, 'the reason must be shown')
  assert.equal(text.includes(REQUEST.description), true, 'the description must be shown')
  assert.equal(text.includes('持久保存到凭据库'), true)
  assert.equal(text.includes('仅本次会话有效'), true)
  assert.equal(text.includes('Agent 请求的范围：'), true)

  const radios = all.filter((element) => element.type === 'input' && element.props.type === 'radio')
  assert.equal(radios.length, 2, 'one radio per scope')
  assert.equal(radios.filter((radio) => radio.props.checked === true).length, 1)

  const password = all.find((element) => element.type === 'input' && element.props.type === 'password')
  assert.notEqual(password, undefined, 'the value field starts masked')
  assert.notEqual(byLabel(tree, '显示'), undefined, 'a reveal toggle must exist')

  for (const label of ['同意', '拒绝', '忽略', '其他']) {
    assert.notEqual(byLabel(tree, label), undefined, `the ${label} action must exist`)
  }

  // "其他" opens a free-text instruction box, which must be submittable.
  const other = byLabel(tree, '其他') as Element
  const onClick = other.props.onClick as (() => void) | undefined
  assert.equal(typeof onClick, 'function')
  onClick?.()
  const opened = renderer.render(CARD_COMPONENT, cardProps())
  const textareas = elements(opened).filter((element) => element.type === 'textarea')
  assert.equal(textareas.length, 1, 'the free-text instruction box must appear')
  assert.notEqual(byLabel(opened, '提交指示'), undefined)
  assert.notEqual(byLabel(opened, '返回'), undefined)
})

test('the raw value never leaves the input the human typed it into', () => {
  const tree = renderer.render(CARD_COMPONENT, cardProps())
  const input = elements(tree).find((element) => element.type === 'input' && element.props.type === 'password')
  assert.notEqual(input, undefined)
  const onChange = input?.props.onChange as ((event: { target: { value: string } }) => void) | undefined
  onChange?.({ target: { value: SECRET } })

  const after = renderer.render(CARD_COMPONENT, cardProps())
  const all = elements(after)
  const typed = all.filter((element) => element.type === 'input' && element.props.type === 'password')
  // Positive control: the value really is in the field (otherwise this test proves nothing).
  assert.equal(String(typed[0]?.props.value), SECRET)
  // And nowhere else in the tree: every other element's own props (children
  // excluded, since they contain the input itself) must be value-free.
  const leaks = all.filter((element) => {
    if (element.type === 'input') return false
    const { children, ...own } = element.props
    void children
    return JSON.stringify(own).includes(SECRET)
  })
  assert.deepEqual(leaks, [], 'the value escaped the masked input')
  // A masked input never carries the value in a label, title or data attribute.
  assert.equal(String(typed[0]?.props['aria-label']).includes(SECRET), false)
  assert.equal(JSON.stringify({ ...typed[0]?.props, value: undefined }).includes(SECRET), false)
})

// ---- the field itself must not be captureable --------------------------------
/**
 * The suppression bag every field that can hold a secret must carry, byte for
 * byte as `src/client/entry.ts` declares it. A regression here is a security
 * regression: the user reported the key being autofilled and captured by a
 * password manager, and no single attribute closes that.
 */
const SECRET_FIELD_BAG: Record<string, unknown> = {
  autoComplete: 'new-password',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  'data-protonpass-ignore': 'true',
}

/**
 * Assert one secret-holding field is un-fillable, un-savable and starts
 * read-only, with the focus handler that releases it.
 */
function assertSecretField(field: Element | undefined, where: string): void {
  assert.notEqual(field, undefined, `${where}: no field rendered`)
  const props = (field as Element).props
  // Report every gap at once: a partial bag is exactly the regression this test
  // exists to catch, so the failure must name all of what is missing.
  const missing = Object.entries(SECRET_FIELD_BAG)
    .filter(([key, value]) => props[key] !== value)
    .map(([key, value]) => `${key}=${JSON.stringify(props[key] ?? null)} (want ${JSON.stringify(value)})`)
  assert.deepEqual(missing, [], `${where}: suppression attributes missing or wrong`)
  const named = Object.keys(props).filter((key) => key.toLowerCase() === 'name')
  assert.deepEqual(named, [], `${where}: a secret field must carry no name attribute`)
  assert.equal(props.readOnly, true, `${where}: must start read-only so autofill skips it on load`)
  const onFocus = props.onFocus as ((event: unknown) => void) | undefined
  assert.equal(typeof onFocus, 'function', `${where}: must release the read-only guard on focus`)
  const node = { readOnly: true }
  onFocus?.({ currentTarget: node })
  assert.equal(node.readOnly, false, `${where}: focus must release the read-only guard`)
}

test('the card’s secret field cannot be autofilled or captured by a password manager', () => {
  const tree = renderer.render(CARD_COMPONENT, cardProps())
  const fields = elements(tree).filter(
    (element) => element.type === 'input' && element.props.type === 'password',
  )
  assert.equal(fields.length, 1, 'the answering form owns exactly one secret field')
  assertSecretField(fields[0], 'request card value')

  // The free-text instruction box can hold no secret, so it takes the hygiene
  // subset (no spell service, no autocorrection) and not the manager bag. The
  // box lives behind the "other" action; an earlier test may already have opened
  // it, and this renderer keeps one component instance, so open it only if the
  // first render does not show it.
  if (elements(tree).every((element) => element.type !== 'textarea')) {
    const other = byLabel(tree, '其他') as Element
    ;(other.props.onClick as (() => void) | undefined)?.()
  }
  const opened = renderer.render(CARD_COMPONENT, cardProps())
  const textareas = elements(opened).filter((element) => element.type === 'textarea')
  assert.equal(textareas.length, 1, 'the instruction box is on screen')
  for (const [key, value] of Object.entries({
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
  })) {
    assert.equal(textareas[0]?.props[key], value, `instruction box: ${key} must be ${String(value)}`)
  }
  // The instruction is prose, never a secret: the sentinel never reaches it.
  assert.equal(JSON.stringify(textareas[0]?.props).includes(SECRET), false)
})

test('the test seam is frozen, stateless and free of secret material', () => {
  assert.equal(Object.isFrozen(seam), true)
  const keys = Object.keys(seam).sort()
  assert.deepEqual(keys, [
    'ANSWER_PATH',
    'CARD_KIND',
    'HiddenSecretToolRow',
    'PENDING_PATH',
    'TEXT',
    'TOOL_NAME',
    'deriveVariable',
    'findEntry',
    'mergeRequest',
    'nextPendingState',
    'parseCallRequest',
    'readEntries',
    'readFailure',
    'readOutcome',
    'secretRequestDefinition',
    'version',
  ])
  assert.equal(JSON.stringify(seam).includes(SECRET), false)
  assert.equal(seam.CARD_KIND, 'secret-request')
  assert.equal(seam.TOOL_NAME, 'secret_request')
  assert.deepEqual(plugin.inject, ['slots', 'uiConversation'])
})

// ---- T7: the display name cannot drift from the Host's derivation ------------

test('the card derives the same variable name the Host publishes', () => {
  const cases: { name: string; envVar?: string }[] = [
    { name: 'openai' },
    { name: 'openai-key' },
    { name: 'openai_key' },
    { name: 'a1-b2_c3' },
    { name: 'x', envVar: 'DSH_SECRET_CUSTOM' },
  ]
  for (const item of cases) {
    const host = effectiveEnvVar({
      name: item.name,
      label: 'l',
      reason: 'r',
      scope: 'session',
      ...(item.envVar === undefined ? {} : { envVar: item.envVar }),
    })
    const card = seam.deriveVariable(item.name, item.envVar)
    assert.equal(card, host, `card and host disagree for ${item.name}`)
  }
  assert.equal(seam.parseCallRequest(JSON.stringify(REQUEST)).variable, 'DSH_SECRET_OPENAI')
  assert.equal(seam.parseCallRequest(JSON.stringify(REQUEST)).alreadyConfigured, false)
})

// ---------------------------------------------------------------------------
// Round 7 / R2 — the request card's two fields own their own 粘贴 action.
//
// The card is the *request* direction's surface (`POST /api/secret.answer`), so
// its paste action writes the field and nothing else: R3's "register it as a
// secret" belongs to the attach capsule's value field, and must not happen here.
// ---------------------------------------------------------------------------

/** Run `body` with a scripted `navigator.clipboard`, then restore the real one. */
async function withCardClipboard(clipboard: unknown, body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard === undefined ? {} : { clipboard },
    configurable: true,
    writable: true,
  })
  try {
    await body()
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'navigator')
    } else {
      Object.defineProperty(globalThis, 'navigator', original)
    }
  }
}

/** The parent of one element, so a field's own row can be inspected. */
function parentOf(root: unknown, target: Element): Element | undefined {
  const walk = (node: unknown, parent: Element | undefined): Element | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child, parent)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (typeof node !== 'object' || node === null) return undefined
    const element = node as Element
    if (element === target) return parent
    return walk(element.props.children, element)
  }
  return walk(root, undefined)
}

/** The paste action of the row that holds `field`, or undefined. */
function pasteButtonFor(tree: unknown, field: Element | undefined): Element | undefined {
  if (field === undefined) return undefined
  const row = parentOf(tree, field)
  if (row === undefined) return undefined
  return elements(row).find((element) => element.props['data-secret-paste'] === 'true')
}

test('R2: the card’s value and instruction fields each own a 粘贴 action', async () => {
  assert.equal(seam.TEXT.paste, '粘贴', 'the copy is the word the user asked for')
  const tree = renderer.render(CARD_COMPONENT, cardProps())
  const valueField = elements(tree).find(
    (element) => element.type === 'input' && element.props.type === 'password',
  )
  const valueButton = pasteButtonFor(tree, valueField)
  assert.notEqual(valueButton, undefined, 'the value field owns a paste action')
  assert.equal(valueButton?.type, 'button')
  assert.equal(valueButton?.props.type, 'button', 'type=button so it can never submit the card')
  assert.equal(valueButton?.props['aria-label'], seam.TEXT.paste)
  assert.equal(valueButton?.props.disabled, valueField?.props.disabled, 'the action mirrors its field')
  let prevented = false
  ;(valueButton?.props.onMouseDown as ((event: unknown) => void) | undefined)?.({
    preventDefault: () => {
      prevented = true
    },
  })
  assert.equal(prevented, true, 'mousedown is prevented so the field keeps focus')

  // The instruction box carries its own action, disabled exactly like it is. An
  // earlier test in this file may already have opened the box, so open it only
  // when the render does not show it.
  if (elements(tree).every((element) => element.type !== 'textarea')) {
    const other = byLabel(tree, '其他') as Element
    ;(other.props.onClick as (() => void) | undefined)?.()
  }
  const opened = renderer.render(CARD_COMPONENT, cardProps())
  const textarea = elements(opened).find((element) => element.type === 'textarea')
  const textareaButton = pasteButtonFor(opened, textarea)
  assert.notEqual(textareaButton, undefined, 'the instruction box owns a paste action')
  assert.equal(textareaButton?.props.type, 'button')
  assert.equal(textareaButton?.props['aria-label'], seam.TEXT.paste)
  assert.equal(textareaButton?.props.disabled, textarea?.props.disabled)
  assert.equal(
    elements(opened).filter((element) => element.props['data-secret-paste'] === 'true').length,
    2,
    'exactly the two card fields have one',
  )

  // Pressing it writes the field through the same setter typing uses, and asks
  // the Host for nothing: this face never registers a secret by itself.
  const realFetch = (globalThis as Record<string, unknown>).fetch
  let requests = 0
  ;(globalThis as Record<string, unknown>).fetch = async () => {
    requests += 1
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  try {
    await withCardClipboard({ readText: async () => `  ${SECRET}  ` }, async () => {
      const live = renderer.render(CARD_COMPONENT, cardProps())
      const field = elements(live).find(
        (element) => element.type === 'input' && element.props.type === 'password',
      )
      const button = elements(live).find((element) => element.props['data-secret-paste'] === 'true')
      ;(button?.props.onClick as ((event: unknown) => void) | undefined)?.({ currentTarget: { parentElement: null } })
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      const after = renderer.render(CARD_COMPONENT, cardProps())
      const typed = elements(after).find(
        (element) => element.type === 'input' && element.props.type === 'password',
      )
      assert.equal(String(typed?.props.value), SECRET, 'the clipboard text lands in the field, trimmed')
    })
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = realFetch
  }
  assert.equal(requests, 0, 'no request: the card must not register a secret from a paste')
})
