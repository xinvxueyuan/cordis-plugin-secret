/**
 * Client-half tests for the reverse direction: the attach button, the capsule,
 * and the reference source that carries the variable name into the draft.
 *
 * The artifact is a classic script, so it is loaded exactly the way the module
 * system loads it: install `__ModuleLoader__`, import the file for its side
 * effect, take the factory, and answer `require('react')` with a stub renderer.
 * The sentinel below is the only secret in this file; it exists to prove the
 * value never leaves the masked input.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

const SECRET = 'sk-attach-client-DO-NOT-LEAK'
const ENV_VAR = 'DSH_SECRET_OPENAI'
const SESSION_ID = 'session-root'

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
      // Effects would reach for `fetch`; these tests drive the pure paths and
      // the rendered tree instead.
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
      throw new Error('the component did not settle within 50 renders')
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

// ---- load and mount the artifact the way the web entry point does -------------
//
// The artifact is a classic script, so it is loaded exactly the way the module
// system loads it: install `__ModuleLoader__`, import the file for its side
// effect, take the factory, and answer `require('react')` with a stub renderer.
// It is then *mounted into a real cordis tree* — sibling providers for the
// services a web client has, the factory's own `inject` list as the fiber's gate
// — because the un-injected read this suite exists to catch is a property of the
// cordis context proxy itself: a hand-rolled stub without that semantics could
// never have failed the way the browser did.
//
// The sentinel below is the only secret in this file; it exists to prove the
// value never leaves the masked input.

const loaded: unknown[] = []
;(globalThis as Record<string, unknown>).__ModuleLoader__ = {
  load: (registration: unknown) => loaded.push(registration),
}
// @ts-expect-error -- runtime-only side-effect import of the classic script
await import('../src/client/entry.ts')

const module_ = loaded[0] as LoadedModule | undefined
assert.notEqual(module_, undefined, 'the client artifact never registered a factory')

const renderer = createRenderer()
const plugin = (module_ as LoadedModule).factory(() => renderer.react)

const api = (globalThis as Record<string, unknown>).__cordisSecretAttach as Record<string, any>

interface Registration {
  name: string
  id?: string
  order?: number
  key?: string
  inject?: (sessionId?: unknown) => Record<string, unknown>
  component: (props: unknown) => unknown
}

/** The host's report of one bailable session scope. */
const bailCalls: { name: string; payload: unknown }[] = []
let bailAnswer: unknown = true
const scopeStub = {
  bail(_subject: unknown, name: string, payload: unknown): unknown {
    bailCalls.push({ name, payload })
    return bailAnswer
  },
}

/** The service stubs of one client tree. */
function servicesFor(registrations: Registration[], sources: unknown[]): Record<string, unknown> {
  return {
    slots: {
      inject: (_owner: string, declare: () => unknown) => declare(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ ...(options as unknown as Registration), component: component as Registration['component'] })
        return () => undefined
      },
    },
    uiConversation: { events: { register: () => undefined } },
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    inputTriggers: {
      registerSource: (source: unknown) => {
        sources.push(source)
        return () => undefined
      },
    },
    sessions: { scope: () => scopeStub },
  }
}

/** One client entry mounted into a cordis tree. */
interface Mounted {
  readonly registrations: Registration[]
  readonly sources: unknown[]
  /** True once the artifact's own `apply` returned; false when it threw. */
  applied: boolean
  /** What `apply` threw, when it did: cordis fails the whole entry on this. */
  error: unknown
}

/**
 * Mount one client half into a real cordis tree: sibling providers for the named
 * services, then the half's own `inject` list as the fiber's gate — exactly what
 * the web entry point does with the factory's `{ inject, apply }`. A service
 * that is not named is not in the tree at all, and a name the half reads without
 * declaring it throws inside the context proxy, which is the release blocker.
 */
async function mount(
  half: { readonly inject: readonly string[]; apply(ctx: unknown): void },
  serviceNames: readonly string[],
): Promise<Mounted> {
  const registrations: Registration[] = []
  const sources: unknown[] = []
  const services = servicesFor(registrations, sources)
  const root = new Context()
  for (const name of serviceNames) {
    root.plugin((ctx) => {
      ctx.provide(name, services[name])
    })
  }
  const mounted: Mounted = { registrations, sources, applied: false, error: undefined }
  const fiber = root.plugin({
    inject: [...half.inject],
    apply(ctx: unknown) {
      try {
        half.apply(ctx)
        mounted.applied = true
      } catch (error) {
        mounted.error = error
      }
    },
  })
  await fiber
  // The providers start on their own microtasks, so the entry activates a few
  // macrotasks later: wait for the outcome instead of guessing a delay.
  for (let attempt = 0; attempt < 25 && !mounted.applied && mounted.error === undefined; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  return mounted
}

// The optional services are exactly that: a client without them must still come
// up. This boot has none of the three, and runs first so it sees the module in
// the state a freshly loaded page has — nothing bound yet.
const bare = await mount(plugin, ['slots', 'uiConversation'])
const BARE_SPAN = { start: 0, end: 0, draftRev: 1 }
const bareInserted: string[] = []
let bareTier: unknown
let bareManualTier: unknown
let bareThrew: unknown
try {
  bareTier = api.insertChip(SESSION_ID, ENV_VAR, BARE_SPAN, {
    captureInsertion: () => BARE_SPAN,
    insertText: (marker: string) => {
      bareInserted.push(marker)
      return true
    },
  })
  bareManualTier = api.insertChip(SESSION_ID, ENV_VAR, BARE_SPAN, undefined)
} catch (error) {
  // Recorded rather than thrown, so the assertions below report the defect
  // alongside every other result instead of aborting the whole file.
  bareThrew = error
}

// The full client: every service the attach surface can use.
const full = await mount(plugin, ['slots', 'uiConversation', 'locale', 'inputTriggers', 'sessions'])
const registrations = full.registrations
const sources = full.sources

/** Reset the module-scope surface so one test cannot colour the next. */
function reset(): void {
  api.setAttachMode({ kind: 'idle' })
  for (const sessionId of [SESSION_ID, 'other-session']) api.sessionAttachments(sessionId).clear()
  bailAnswer = true
  bailCalls.length = 0
}

const TOGGLE = registrations.find((entry) => entry.name === 'conversation.input.left')?.component as (props: unknown) => unknown
const CAPSULE = registrations.find((entry) => entry.name === 'conversation.input.overlay')?.component as (props: unknown) => unknown

// ---- optional services -------------------------------------------------------

test('a client without the optional services degrades instead of failing the entry', () => {
  // The release blocker this guard exists for: an undeclared read of `locale`
  // made cordis throw inside this same `apply`, the fiber never activated, and
  // the page reported `Failed to load plugins`. It must now come up regardless.
  assert.equal(bare.applied, true, `apply threw without the optional services: ${String(bare.error)}`)
  assert.equal(bare.error, undefined)
  // The core surface is registered anyway: the request card, its tool row, the
  // button, the capsule and the side-car attach row need none of the optional
  // services.
  //
  // Updated this round: the two `conversation.chat.node` entries are the request
  // card and the new side-car row (requirement 1 / O2), one keyed registration
  // each. The right-column viewer (requirement 1 / O1) is deliberately NOT in
  // this list: it lives behind `ctx.inject(['sidebarRightTabs'])`, which this
  // service-less boot never satisfies.
  //
  // Round 5 grows this by exactly two rows: the management card
  // (`conversation.chat.node`, key `sr-manage`) and its own tool-row placeholder
  // (`tool.call.toolview`, key `secret_manage`). Neither existing row changed.
  // Disclosed change: the two expected lists below each gained one entry; no
  // prior expectation was removed or altered.
  assert.deepEqual(
    bare.registrations.map((entry) => entry.name).sort(),
    [
      'conversation.chat.node',
      'conversation.chat.node',
      'conversation.chat.node',
      'conversation.input.left',
      'conversation.input.overlay',
      'tool.call.toolview',
      'tool.call.toolview',
    ],
  )
  assert.deepEqual(
    bare.registrations
      .filter((entry) => entry.name === 'conversation.chat.node')
      .map((entry) => entry.key)
      .sort(),
    ['secret-request', api.CHIP_KIND, 'sr-manage'],
    'one registration per chat node kind: the request card, the side-car row, and the management card',
  )
  // The reference source is simply absent, exactly like the locale dictionary.
  assert.deepEqual(bare.sources, [])
  // The chip rung needs `sessions`; without it the ladder starts at the plain
  // marker and then at the manual instruction — never a throw.
  assert.equal(bareThrew, undefined, `insertChip threw without sessions: ${String(bareThrew)}`)
  assert.equal(bareTier, 'text')
  assert.deepEqual(bareInserted, [`@${ENV_VAR}`])
  assert.equal(bareManualTier, 'manual')
})

test('the mount harness still fails an entry that reads an undeclared service', async () => {
  // Positive control for the guard above: the same harness, with every service
  // present, must reject the exact read the shipped artifact used to perform.
  // Otherwise this suite could not tell the defect from a working build.
  const shippedRead = await mount(
    {
      inject: ['slots', 'uiConversation'],
      apply(ctx: unknown) {
        const attach = ctx as { locale?: { register(...args: unknown[]): unknown } }
        void attach.locale?.register
      },
    },
    ['slots', 'uiConversation', 'locale', 'inputTriggers', 'sessions'],
  )
  assert.equal(shippedRead.applied, false, 'an un-injected read must fail the entry')
  assert.match(
    String((shippedRead.error as Error | undefined)?.message),
    /cannot get property "locale" without inject/,
  )
})

// ---- the entry button -------------------------------------------------------

test('the entry button registers like the vision-mode toggle it is modelled on', () => {
  // The reference shape: a list-slot entry carrying id, order, locale and an
  // inject factory that resolves per session.
  const toggle = registrations.find((entry) => entry.name === 'conversation.input.left')
  assert.notEqual(toggle, undefined, 'the attach button is not registered')
  assert.equal(toggle?.id, 'secret-attach-toggle')
  assert.equal(typeof toggle?.order, 'number')
  assert.equal(typeof toggle?.inject, 'function')
  const face = toggle?.inject?.(SESSION_ID)
  assert.equal(typeof face?.open, 'function', 'the inject factory supplies the open action')
  assert.equal(typeof face?.close, 'function')
  // The capsule gets its own overlay entry, above the composer card.
  const capsule = registrations.find((entry) => entry.name === 'conversation.input.overlay')
  assert.equal(capsule?.id, 'secret-attach-capsule')
  assert.equal(typeof capsule?.order, 'number')
  // The card's own two registrations are untouched by this round.
  assert.equal(registrations.filter((entry) => entry.name === 'conversation.chat.node')[0]?.key, 'secret-request')
  assert.equal(registrations.filter((entry) => entry.name === 'tool.call.toolview')[0]?.key, 'secret_request')
  // The plugin's hard dependency list is unchanged: the reference source is
  // optional at load time, so no new service joins the gate.
  assert.deepEqual([...plugin.inject], ['slots', 'uiConversation'])
  assert.equal(sources.length, 1, 'exactly one reference source is registered')
})

test('the button is a real toggle: pressed state and accessible name follow the capsule', () => {
  reset()
  const tree = renderer.render(TOGGLE, { sessionId: SESSION_ID })
  const button = elements(tree).find((element) => element.props['data-secret-attach-toggle'] === 'true')
  assert.notEqual(button, undefined)
  assert.equal(button?.type, 'button')
  assert.equal(button?.props['aria-pressed'], false)
  assert.equal(button?.props['aria-label'], '附密钥')
  assert.equal(String(visibleText(tree)).includes('附密钥'), true)

  // Pressing it opens the capsule...
  const onClick = button?.props.onClick as (() => void) | undefined
  onClick?.()
  assert.equal(api.currentMode().kind, 'fill')

  // ...and the button now reads as pressed, with a different accessible name.
  const opened = renderer.render(TOGGLE, { sessionId: SESSION_ID })
  const pressed = elements(opened).find((element) => element.props['data-secret-attach-toggle'] === 'true')
  assert.equal(pressed?.props['aria-pressed'], true)
  assert.equal(pressed?.props['aria-label'], '收起附密钥')

  // Pressing it again closes the capsule.
  ;(pressed?.props.onClick as (() => void) | undefined)?.()
  assert.equal(api.currentMode().kind, 'idle')
  reset()
})

// ---- the capsule ------------------------------------------------------------

test('the capsule renders nothing while idle and a complete form while filling', () => {
  reset()
  assert.equal(renderer.render(CAPSULE, { sessionId: SESSION_ID }), null, 'an idle capsule renders no node at all')

  api.setAttachMode({ kind: 'fill' })
  const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID, inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }) } })
  const box = elements(tree).find((element) => element.props['data-secret-attach-capsule'] === 'fill')
  assert.notEqual(box, undefined)
  const all = elements(tree)
  const text = visibleText(tree)

  // Every control the contract needs, plus the scope choice and its current value.
  assert.equal(text.includes('凭据键'), true)
  assert.equal(text.includes('密钥内容'), true)
  assert.equal(text.includes('保存方式'), true)
  assert.equal(text.includes('当前选择：'), true)
  const password = all.find((element) => element.type === 'input' && element.props.type === 'password')
  assert.notEqual(password, undefined, 'the value field starts masked')
  assert.notEqual(byLabel(tree, '显示'), undefined)
  const radios = all.filter((element) => element.type === 'input' && element.props.type === 'radio')
  assert.equal(radios.length, 2, 'one radio per scope')
  const checked = radios.filter((radio) => radio.props.checked === true)
  assert.equal(checked.length, 1)
  assert.equal(checked[0]?.props.name, 'dsh-secret-attach-scope')
  // The default is the session-only scope, and it is what the notice names.
  assert.equal(text.includes('仅本次会话有效'), true)
  assert.notEqual(byLabel(tree, '插入到光标处'), undefined)
  assert.notEqual(byLabel(tree, '取消'), undefined)

  // Switching scope is visible immediately, and the persistent wording appears.
  const persistent = radios[1]
  ;(persistent?.props.onChange as (() => void) | undefined)?.()
  const switched = visibleText(renderer.render(CAPSULE, { sessionId: SESSION_ID }))
  assert.equal(switched.includes('持久保存到凭据库'), true)
  assert.equal(switched.includes('写入本机凭据库'), true)
  reset()
})

test('cancelling the form discards the value and leaves no trace anywhere', () => {
  reset()
  api.setAttachMode({ kind: 'fill' })
  const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  const input = elements(tree).find((element) => element.type === 'input' && element.props.type === 'password')
  ;(input?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({ target: { value: SECRET } })

  const typed = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  // Positive control: the value really is in the field.
  const field = elements(typed).find((element) => element.type === 'input' && element.props.type === 'password')
  assert.equal(String(field?.props.value), SECRET)
  // And nowhere else: every other element's own props are value-free, including
  // labels, titles and data attributes.
  const leaks = elements(typed).filter((element) => {
    if (element.type === 'input') return false
    const { children, ...own } = element.props
    void children
    return JSON.stringify(own).includes(SECRET)
  })
  assert.deepEqual(leaks, [], 'the value escaped the masked input')
  assert.equal(JSON.stringify({ ...field?.props, value: undefined }).includes(SECRET), false)

  // Cancelling drops the value and the capsule.
  ;(byLabel(typed, '取消')?.props.onClick as (() => void) | undefined)?.()
  assert.equal(api.currentMode().kind, 'idle')
  assert.equal(renderer.render(CAPSULE, { sessionId: SESSION_ID }), null)
  assert.deepEqual(api.sessionAttachments(SESSION_ID).size, 0, 'cancel registers nothing')
  reset()
})

test('the detail face shows the variable, scope and state, and offers discard only while staged', () => {
  reset()
  api.sessionAttachments(SESSION_ID).set(ENV_VAR, {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'session',
    state: 'staged',
    createdAt: 1700000000000,
  })
  api.setAttachMode({ kind: 'detail', variable: ENV_VAR })
  const staged = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  const text = visibleText(staged)
  assert.equal(text.includes(ENV_VAR), true, 'the capsule shows the variable name')
  assert.equal(text.includes('OpenAI API Key'), true)
  assert.equal(text.includes('仅本次会话有效'), true)
  assert.equal(text.includes('已登记，等待发送'), true)
  assert.notEqual(byLabel(staged, '丢弃'), undefined)

  // Closing returns to the original state, and the capsule disappears.
  ;(elements(staged).find((element) => element.props['data-action'] === 'close')?.props.onClick as (() => void) | undefined)?.()
  assert.equal(api.currentMode().kind, 'idle')

  // A bound entry is reported as bound and cannot be discarded here: it is
  // anchored to a message, so only taking the message back ends it.
  api.sessionAttachments(SESSION_ID).set(ENV_VAR, {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'persistent',
    state: 'bound',
    createdAt: 1700000000000,
  })
  api.setAttachMode({ kind: 'detail', variable: ENV_VAR })
  const bound = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  assert.equal(visibleText(bound).includes('已绑定到这条消息'), true)
  assert.equal(visibleText(bound).includes('持久保存到凭据库'), true)
  assert.equal(byLabel(bound, '丢弃'), undefined, 'a bound attachment is not discardable')

  // An entry the host knows about but this page does not says so honestly.
  api.setAttachMode({ kind: 'detail', variable: 'DSH_SECRET_UNKNOWN' })
  const unknown = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  assert.equal(visibleText(unknown).includes('状态未知（无法连接宿主）'), true)
  reset()
})

// ---- insertion ladder -------------------------------------------------------

test('insertion prefers the contract\u2019s own chip event and falls back to plain text', () => {
  reset()
  const span = { start: 4, end: 4, draftRev: 9 }
  const inserted: string[] = []
  const actions = {
    captureInsertion: () => span,
    insertText: (text: string) => {
      inserted.push(text)
      return true
    },
  }

  // L1: the frozen contract's reference-insertion event applied it.
  bailAnswer = true
  assert.equal(api.insertChip(SESSION_ID, ENV_VAR, span, actions), 'chip')
  assert.equal(bailCalls.length, 1)
  assert.equal(bailCalls[0]?.name, 'slash/input-insert-reference')
  const payload = bailCalls[0]?.payload as { reference: Record<string, unknown>; span: unknown }
  assert.equal(payload.span, span, 'the captured span rides the request unchanged')
  assert.deepEqual(payload.reference, {
    source: 'secret',
    ref: ENV_VAR,
    label: ENV_VAR,
    appearance: 'session',
    clipboardText: `@${ENV_VAR}`,
  })
  assert.equal(inserted.length, 0, 'a chip never also inserts the plain text')

  // L3: the editor refused the chip, so the marker goes in as plain text and the
  // source's lexicon turns it into a decorated reference.
  bailAnswer = false
  assert.equal(api.insertChip(SESSION_ID, ENV_VAR, span, actions), 'text')
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0], `@${ENV_VAR}`)

  // L4: with neither path available, the human is told instead of being lied to.
  assert.equal(api.insertChip(SESSION_ID, ENV_VAR, span, { insertText: () => false }), 'manual')
  assert.equal(api.insertChip(SESSION_ID, ENV_VAR, span, undefined), 'manual')

  // A stale span that the editor refuses still lands as text, because the fresh
  // capture is what the fallback uses.
  bailAnswer = false
  const fresh = { start: 20, end: 20, draftRev: 11 }
  const applied = api.insertChip(SESSION_ID, ENV_VAR, span, {
    captureInsertion: () => fresh,
    insertText: (text: string, used: unknown) => {
      inserted.push(`${text}@${JSON.stringify(used)}`)
      return true
    },
  })
  assert.equal(applied, 'text')
  assert.equal(inserted.at(-1), `@${ENV_VAR}@${JSON.stringify(fresh)}`)
  reset()
})

// ---- the reference source ---------------------------------------------------

test('the reference source serializes, decorates and routes clicks, and asks the host for menu rows', async () => {
  reset()
  const source = sources[0] as Record<string, any>
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'secret')
  assert.equal(source.showGroupTitle, false)
  // Changed this round (item 4): this assertion used to be
  // `assert.deepEqual(await source.candidates({ sessionId: SESSION_ID }, {}), [])`
  // with the comment "Nothing is ever offered in the `@` menu". The `@` menu is
  // now served from the host's own available list, so an empty menu is an answer
  // about that list — not a source that never asks. The three dedicated menu
  // tests below cover the two sources, the confirm step and the insertion.
  const menu = stubRoutes()
  try {
    assert.deepEqual(await source.candidates({ sessionId: SESSION_ID }, {}), [])
    assert.deepEqual(
      menu.calls.map((call) => call.url),
      [`${api.AVAILABLE_PATH}?sessionId=${SESSION_ID}`],
      'an empty menu is the host saying so, not the source staying silent',
    )
  } finally {
    restoreFetch()
  }
  assert.equal(source.matchSpace, undefined)
  assert.equal(source.matchEnter, undefined)
  assert.equal(typeof source.codec.clipboardText, 'function')

  // The codec is the model-facing form of one occurrence, and it is the marker
  // text the host later rewrites. It never carries a value.
  assert.equal(source.codec.clipboardText(ENV_VAR), `@${ENV_VAR}`)
  assert.equal(await source.codec.serialize(ENV_VAR, new AbortController().signal), `@${ENV_VAR}`)

  // The lexicon is what decorates the plain marker after a reload, when the
  // draft is text again and no chip node exists.
  assert.deepEqual(source.lexicon({ sessionId: SESSION_ID }), [])
  api.sessionAttachments(SESSION_ID).set(ENV_VAR, {
    variable: ENV_VAR,
    name: 'openai',
    label: 'openai',
    scope: 'session',
    state: 'staged',
    createdAt: 1,
  })
  assert.deepEqual(source.lexicon({ sessionId: SESSION_ID }), [ENV_VAR])
  assert.deepEqual(source.lexicon({ sessionId: 'other' }), [], 'the roll is per session')
  assert.deepEqual(source.lexicon(undefined), [])

  // A lexicon change must wake the controller, which is what re-scans the draft.
  let woken = 0
  const release = source.subscribeLexicon({ sessionId: SESSION_ID }, () => {
    woken += 1
  })
  assert.equal(typeof release, 'function')
  api.setAttachMode({ kind: 'fill' })
  assert.equal(woken, 1, 'a change notified the subscriber')
  release()

  // A click on either the chip or the decorated text opens the detail face.
  assert.equal(source.openReference({ sessionId: SESSION_ID }, { ref: ENV_VAR }), true)
  assert.deepEqual(api.currentMode(), { kind: 'detail', variable: ENV_VAR })
  assert.equal(source.openReference({ sessionId: SESSION_ID }, { ref: `@${ENV_VAR}` }), true, 'the text form keeps its trigger')
  assert.deepEqual(api.currentMode(), { kind: 'detail', variable: ENV_VAR })
  assert.equal(source.openReference({ sessionId: SESSION_ID }, {}), false)
  reset()
})

// ---- pure helpers -----------------------------------------------------------

test('the marker matcher agrees with the host\u2019s boundary discipline', () => {
  assert.deepEqual(api.parseMarkers(`请用 @${ENV_VAR} 跑测试`), [ENV_VAR])
  assert.deepEqual(api.parseMarkers(`@${ENV_VAR}`), [ENV_VAR])
  assert.deepEqual(api.parseMarkers(`x@${ENV_VAR}`), [], 'no boundary, no marker')
  assert.deepEqual(api.parseMarkers('@DSH_SECRET_'), [])
  assert.deepEqual(api.parseMarkers(`@${ENV_VAR} @${ENV_VAR}`), [ENV_VAR], 'deduplicated')
  assert.deepEqual(api.parseMarkers('普通文本'), [])
  assert.equal(api.markerOf(ENV_VAR), `@${ENV_VAR}`)
  // Same constructor as the host's: a global, case-sensitive, boundary-anchored
  // scan, so the token the editor decorates is the token the host rewrites.
  assert.equal(api.MARKER_RE.flags, 'gu')
})

test('the client reads host payloads defensively and never echoes host error text', () => {
  assert.deepEqual(api.readAttachResponse({ ok: true, variable: ENV_VAR, scope: 'session', replaced: false }), {
    variable: ENV_VAR,
    scope: 'session',
    replaced: false,
  })
  assert.equal(api.readAttachResponse({ ok: true, variable: ENV_VAR }), null, 'a missing scope is unreadable')
  assert.equal(api.readAttachResponse({ ok: false, variable: ENV_VAR, scope: 'session' }), null)
  assert.equal(api.readAttachResponse(null), null)
  assert.equal(api.readAttachResponse('nope'), null)

  const list = api.readAttachedList({
    ok: true,
    attachments: [
      { variable: ENV_VAR, name: 'openai', label: 'OpenAI', scope: 'session', state: 'staged', createdAt: 5 },
      { variable: 'DSH_SECRET_BOUND', name: 'b', label: 'B', scope: 'persistent', state: 'bound', createdAt: 6 },
      { variable: 'DSH_SECRET_BAD', scope: 'session', state: 'nonsense' },
      null,
    ],
  })
  assert.equal(list?.length, 2, 'unreadable entries are dropped, not guessed')
  // Updated this round: AttachedMeta gained the two facts only a live page can
  // know — the generation a withdrawal timer captured, and whether the marker
  // was ever seen in the draft. The host never sends them, so the pure reader
  // reports the neutral values and `refreshAttached` carries a page's own
  // values across a refresh.
  assert.deepEqual(list?.[0], {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI',
    scope: 'session',
    state: 'staged',
    createdAt: 5,
    generation: 0,
    seenPresent: false,
  })
  assert.equal(list?.[1]?.state, 'bound')
  assert.equal(api.readAttachedList({ ok: true }), null)
  assert.equal(api.readAttachedList(null), null)

  // One fixed sentence per refusal, and the host's own text is never surfaced.
  assert.equal(api.attachErrorFor(400), '这次附加的字段不合法，未登记。')
  assert.equal(api.attachErrorFor(409), '本会话登记的附加密钥已达上限，未登记。')
  assert.equal(api.attachErrorFor(500), '凭据库写入失败，未登记。')
  assert.equal(api.attachErrorFor(418), api.ATTACH_FAILURE_UNKNOWN)
  assert.equal(
    JSON.stringify([api.ATTACH_FAILURE, api.ATTACH_FAILURE_UNKNOWN, api.ATTACH_UNREACHABLE]).includes(SECRET),
    false,
  )
})

test('the attach seam is frozen and carries no secret material', () => {
  reset()
  assert.equal(Object.isFrozen(api), true)
  assert.equal(JSON.stringify(Object.keys(api).filter((key) => key !== 'sessionAttachments').map((key) => key)).includes(SECRET), false)
  assert.equal(api.ATTACH_SLOT, 'conversation.input.left')
  assert.equal(api.CAPSULE_SLOT, 'conversation.input.overlay')
  assert.equal(api.ATTACH_PATH, '/api/secret.attach')
  assert.equal(api.RELEASE_PATH, '/api/secret.release')
  assert.equal(api.ATTACHED_PATH, '/api/secret.attached')
  assert.equal(api.SECRET_SOURCE, 'secret')
  // The card's own seam is untouched by this round: same frozen key set.
  assert.deepEqual(Object.keys((globalThis as Record<string, unknown>).__cordisSecretClient as object).sort(), [
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
})

// ---- the history area (requirement 2) ---------------------------------------
//
// The history is the one thing in this plugin that remembers the past, so these
// tests are about honesty as much as about rendering: every recorded transition
// is shown (including the ones that are over), an unread or unreadable answer is
// never reported as an empty past, and no row has a field a value could ride in.

const REAL_FETCH = (globalThis as Record<string, unknown>).fetch

/** Replace `fetch` for one test, recording every URL it was asked for. */
function stubFetch(): { calls: string[]; answer: { ok: boolean; payload: unknown } } {
  const state = { calls: [] as string[], answer: { ok: true, payload: undefined as unknown } }
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    state.calls.push(String(url))
    return { ok: state.answer.ok, json: async () => state.answer.payload }
  }
  return state
}

function restoreFetch(): void {
  ;(globalThis as Record<string, unknown>).fetch = REAL_FETCH
}

/** One wire entry, value-free by construction, with the round's facts overridden. */
function historyEntry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    at: 1700000000000,
    event: 'staged',
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'session',
    source: 'attach',
    ...over,
  }
}

/** Click the one control carrying a `data-action`, failing loudly when absent. */
function clickAction(root: unknown, action: string): void {
  const control = elements(root).find((element) => element.props['data-action'] === action)
  assert.notEqual(control, undefined, `no control offers the ${action} action`)
  ;(control?.props.onClick as (() => void) | undefined)?.()
}

test('the history face lists every recorded transition with scope, state and time', async () => {
  const session = 'history-all-session'
  const stub = stubFetch()
  stub.answer.payload = {
    ok: true,
    entries: [
      historyEntry({ at: 1700000000000, event: 'staged' }),
      historyEntry({ at: 1700000100000, event: 'bound', anchorSeq: 12 }),
      historyEntry({ at: 1700000200000, event: 'discarded' }),
      historyEntry({ at: 1700000300000, event: 'withdrawn' }),
      historyEntry({ at: 1700000400000, event: 'revoked', anchorSeq: 12 }),
      historyEntry({ at: 1700000500000, event: 'expired' }),
      historyEntry({
        at: 1700000600000,
        event: 'authorized',
        variable: 'DSH_SECRET_ANTHROPIC',
        name: 'anthropic',
        label: 'Anthropic Key',
        scope: 'persistent',
        source: 'request',
      }),
    ],
  }
  try {
    // Nothing is claimed before the first answer arrives.
    assert.deepEqual(api.historyOf(session), [])
    assert.equal(api.historyRead(session), false)
    await api.refreshHistory(session)
    assert.deepEqual(stub.calls, [`/api/secret.history?sessionId=${session}`])
    assert.equal(api.historyRead(session), true)
    assert.equal(api.historyFailed(session), false)
    assert.equal(api.historyOf(session).length, 7)

    api.setAttachMode({ kind: 'history' })
    const tree = renderer.render(CAPSULE, { sessionId: session })
    assert.notEqual(
      elements(tree).find((element) => element.props['data-secret-attach-capsule'] === 'history'),
      undefined,
      'the info box has no history face',
    )
    const text = visibleText(tree)
    // Every transition, in the host's own order, each one with its own state.
    assert.deepEqual(
      elements(tree)
        .filter((element) => element.props['data-secret-history-row'] !== undefined)
        .map((element) => element.props['data-status']),
      ['staged', 'bound', 'discarded', 'withdrawn', 'revoked', 'expired', 'authorized'],
    )
    assert.equal(
      elements(tree).find((element) => element.props['data-secret-history-count'] !== undefined)?.props[
        'data-secret-history-count'
      ],
      '7',
    )
    assert.equal(text.includes('本会话的附加与授权记录'), true, 'the face names itself')
    for (const label of ['已登记', '已绑定到消息', '已丢弃', '已随草稿移除撤销', '已随消息回退失效', '已过期', '经授权生效']) {
      assert.equal(text.includes(label), true, `a row is missing its state label: ${label}`)
    }
    // The facts the contract asks for: variable, scope, time — plus the human
    // label, the direction it came from and the anchor when there is one.
    assert.equal(text.includes(ENV_VAR), true)
    assert.equal(text.includes('DSH_SECRET_ANTHROPIC'), true)
    assert.equal(text.includes('OpenAI API Key'), true)
    assert.equal(text.includes('Anthropic Key'), true)
    assert.equal(text.includes('仅本次会话有效'), true)
    assert.equal(text.includes('持久保存到凭据库'), true)
    assert.equal(text.includes('附加'), true)
    assert.equal(text.includes('索要'), true)
    assert.equal(text.includes('锚点 12'), true)
    assert.equal(text.includes(api.formatHistoryStamp(1700000000000)), true)
    assert.equal(text.includes('2023-11-14 22:13:20Z'), true)
    // Retention semantics are on the face itself, verbatim from the dictionary.
    assert.equal(text.includes(api.ATTACH_ZH.historyNotice), true)
    reset()
  } finally {
    restoreFetch()
  }
})

test('the history area opens on the whole session and can be narrowed to one variable', async () => {
  const session = 'history-filter-session'
  const stub = stubFetch()
  stub.answer.payload = {
    ok: true,
    entries: [
      historyEntry({ at: 1, event: 'staged' }),
      historyEntry({
        at: 2,
        event: 'authorized',
        variable: 'DSH_SECRET_ANTHROPIC',
        name: 'anthropic',
        label: 'Anthropic Key',
        scope: 'persistent',
        source: 'request',
      }),
    ],
  }
  try {
    await api.refreshHistory(session)

    // The way in: the link in the info box's own header, which shows everything.
    api.setAttachMode({ kind: 'fill' })
    clickAction(renderer.render(CAPSULE, { sessionId: session }), 'history')
    assert.deepEqual(api.currentMode(), { kind: 'history' })
    const all = renderer.render(CAPSULE, { sessionId: session })
    assert.equal(visibleText(all).includes(ENV_VAR), true)
    assert.equal(visibleText(all).includes('DSH_SECRET_ANTHROPIC'), true, 'the default list is the whole session')
    assert.equal(
      elements(all).find((element) => element.props['data-secret-history-count'] !== undefined)?.props[
        'data-secret-history-count'
      ],
      '2',
    )

    // Narrowing is explicit, from the detail face of one variable...
    api.setAttachMode({ kind: 'detail', variable: ENV_VAR })
    clickAction(renderer.render(CAPSULE, { sessionId: session }), 'history-variable')
    assert.deepEqual(api.currentMode(), { kind: 'history', variable: ENV_VAR })
    const one = renderer.render(CAPSULE, { sessionId: session })
    const oneText = visibleText(one)
    assert.equal(oneText.includes(ENV_VAR), true)
    assert.equal(oneText.includes('DSH_SECRET_ANTHROPIC'), false, 'the narrowed list is one variable only')
    assert.equal(oneText.includes('该变量的历史'), true)
    assert.equal(
      elements(one).find((element) => element.props['data-secret-history-count'] !== undefined)?.props[
        'data-secret-history-count'
      ],
      '1',
    )

    // ...and widening back is one click, which is what "show all" is for.
    clickAction(one, 'history-all')
    assert.deepEqual(api.currentMode(), { kind: 'history' })
    assert.equal(visibleText(renderer.render(CAPSULE, { sessionId: session })).includes('DSH_SECRET_ANTHROPIC'), true)
    reset()
  } finally {
    restoreFetch()
  }
})

test('the history area is never empty before the first answer, and reports an unreadable one', async () => {
  const session = 'history-unread-session'
  const stub = stubFetch()
  try {
    api.setAttachMode({ kind: 'history' })
    const fresh = visibleText(renderer.render(CAPSULE, { sessionId: session }))
    assert.equal(fresh.includes('正在读取本会话的记录…'), true)
    assert.equal(fresh.includes('本进程内暂无记录。'), false, 'an unread history must not read as an empty one')
    api.setAttachMode({ kind: 'idle' })

    stub.answer.ok = false
    await api.refreshHistory(session)
    assert.equal(api.historyFailed(session), true)
    api.setAttachMode({ kind: 'history' })
    const down = visibleText(renderer.render(CAPSULE, { sessionId: session }))
    assert.equal(down.includes('历史暂不可用'), true)
    assert.equal(down.includes('本进程内暂无记录。'), false)

    // A malformed answer is not evidence of an empty past either.
    stub.answer = { ok: true, payload: { ok: true, entries: 'nope' } }
    await api.refreshHistory(session)
    assert.equal(api.historyFailed(session), true)
    assert.deepEqual(api.historyOf(session), [])

    // A good answer clears it, and a narrowed list says something else than an
    // empty session would: no records *for this variable*, not "nothing happened".
    stub.answer = { ok: true, payload: { ok: true, entries: [historyEntry({ event: 'staged' })] } }
    await api.refreshHistory(session)
    assert.equal(api.historyFailed(session), false)
    api.setAttachMode({ kind: 'history', variable: 'DSH_SECRET_OTHER' })
    const narrowed = visibleText(renderer.render(CAPSULE, { sessionId: session }))
    assert.equal(narrowed.includes('该变量在本进程内没有记录。'), true)
    assert.equal(narrowed.includes('本进程内暂无记录。'), false)
    reset()
  } finally {
    restoreFetch()
  }
})

test('the history readers drop what they cannot understand and carry no value field', () => {
  const payload = {
    ok: true,
    entries: [
      historyEntry({ event: 'staged', value: SECRET }),
      historyEntry({ event: 'invented' }),
      historyEntry({ scope: 'forever' }),
      historyEntry({ source: 'guess' }),
      { at: 5, event: 'expired', variable: 'DSH_SECRET_X' },
      'nope',
      null,
    ],
  }
  const list = api.readHistoryList(payload)
  assert.equal(list?.length, 1, 'only the readable entry survives')
  assert.deepEqual(Object.keys(list?.[0]).sort(), ['at', 'event', 'label', 'name', 'scope', 'source', 'variable'])
  assert.equal(JSON.stringify(list).includes(SECRET), false, 'a stray value field is dropped, never carried')
  assert.equal(api.readHistoryList(null), null)
  assert.equal(api.readHistoryList({ ok: true }), null)
  assert.equal(api.readHistoryList({ ok: false, entries: [] }), null)

  // The accepted-event list and the label table are the same closed set, so no
  // accepted event can render as an unknown one.
  assert.deepEqual([...api.HISTORY_EVENTS].sort(), Object.keys(api.HISTORY_LABEL).sort())
  for (const event of api.HISTORY_EVENTS) {
    assert.equal(typeof api.historyEventKey(event), 'string', `no label for ${event}`)
  }
  assert.equal(api.historyEventKey('invented'), undefined)
  assert.equal(api.historyEventKey('constructor'), undefined, 'the table is read by own key only')

  // One fixed-width stamp, in UTC, so the same record reads the same everywhere.
  assert.equal(api.formatHistoryStamp(0), '1970-01-01 00:00:00Z')
  assert.equal(api.formatHistoryStamp(1700000000000), '2023-11-14 22:13:20Z')
  assert.equal(api.formatHistoryStamp(Number.NaN), '')
  assert.equal(api.formatHistoryStamp(undefined), '')

  // An unreadable instant is not invented: the row says the time is unknown
  // instead of stamping the record with the epoch.
  const undated = api.readHistoryList({ ok: true, entries: [{ event: 'staged', variable: ENV_VAR, name: 'openai', label: 'OpenAI API Key', scope: 'session', source: 'attach' }] })
  assert.deepEqual(Object.keys(undated?.[0] ?? {}).sort(), ['event', 'label', 'name', 'scope', 'source', 'variable'])

  const t = (key: string) => api.ATTACH_ZH[key] ?? key
  assert.equal(
    api.historyRowMeta(
      {
        at: 1700000000000,
        event: 'bound',
        variable: ENV_VAR,
        name: 'openai',
        label: 'OpenAI API Key',
        scope: 'session',
        source: 'attach',
        anchorSeq: 12,
        replaced: true,
      },
      t,
    ),
    'OpenAI API Key · 仅本次会话有效 · 附加 · 2023-11-14 22:13:20Z · 锚点 12 · 取代了同变量的上一条',
  )
  assert.equal(
    api.historyRowMeta(
      { event: 'expired', variable: ENV_VAR, name: 'openai', label: 'OpenAI API Key', scope: 'persistent', source: 'request' },
      t,
    ),
    'OpenAI API Key · 持久保存到凭据库 · 索要 · 时间未知',
  )
})

// ---- requirement 3: the draft observer (removal withdraws, sending does not) --
//
// The composer publishes its draft as text, so "the chip left the editor" is
// observed as "the marker is no longer in `state.draft`". These tests drive the
// observer entry the mounted capsule's own effect hands its two seats to
// (`observeComposer`, `src/client/entry.ts:2240`), and they stub `fetch`, because
// a withdrawal is a real POST. What is asserted below is the record's fate and
// the request that ends it — never that some function merely exists.

/** One call a routing fetch stub recorded. */
interface RoutedCall {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

/**
 * Replace `fetch` with a router, so each read-only answer and each write can be
 * told apart: a withdrawal test needs the release POST and the attached GET, and
 * the `@` menu needs the available GET and the adopt POST.
 */
function stubRoutes(): {
  readonly calls: RoutedCall[]
  readonly release: { ok: boolean; payload: unknown }
  readonly attached: { ok: boolean; payload: unknown }
  readonly available: { ok: boolean; payload: unknown }
  readonly adopt: { ok: boolean; payload: unknown }
} {
  const state = {
    calls: [] as RoutedCall[],
    release: { ok: true, payload: { ok: true, released: true, state: 'staged' } },
    attached: { ok: true, payload: { ok: true, attachments: [] as unknown[] } },
    available: { ok: true, payload: { ok: true, entries: [] as unknown[] } },
    adopt: { ok: true, payload: { ok: true, variable: ENV_VAR, scope: 'persistent', replaced: false } },
  }
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: unknown) => {
    const call = init as { method?: unknown; body?: unknown } | undefined
    const raw = call?.body
    const address = String(url)
    state.calls.push({
      url: address,
      method: typeof call?.method === 'string' ? call.method : 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    })
    const answer = address.startsWith(api.RELEASE_PATH)
      ? state.release
      : address.startsWith(api.ADOPT_PATH)
        ? state.adopt
        : address.startsWith(api.AVAILABLE_PATH)
          ? state.available
          : state.attached
    return { ok: answer.ok, status: answer.ok ? 200 : 500, json: async () => answer.payload }
  }
  return state
}

/** Let one click's own promise chain (fetch, its body, the insert) finish. */
async function flushOneTurn(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** Wait past one debounce window, so an armed withdrawal has really fired. */
async function afterDebounce(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, api.WITHDRAW_DEBOUNCE_MS + 120)
  })
}

/** One staged record, as the submit path leaves it: a value exists, a marker may not. */
function stageRecord(session: string, generation: number): void {
  api.sessionAttachments(session).set(ENV_VAR, {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'session',
    state: 'staged',
    createdAt: 1700000000000,
    generation,
    seenPresent: false,
  })
}

test('a staged record is withdrawn once its marker leaves the draft, and re-inserting it never brings the value back', async () => {
  const session = 'withdraw-session'
  reset()
  const stub = stubRoutes()
  try {
    stageRecord(session, 1)
    // The chip is in the editor: the draft carries its marker, so the observer
    // learns the marker really was present here — the fact that makes a later
    // absence mean something at all.
    api.observeComposer(session, { draft: `请用 @${ENV_VAR} 跑测试`, phase: 'plain', pendingSubmissions: [] })
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.seenPresent, true, 'a present marker is remembered')
    assert.equal(
      api.decideWithdraw({ state: 'staged', seenPresent: true, markerPresent: true, submissionCarries: false, phase: 'plain' }),
      'cancel',
      'a marker that is still in the draft withdraws nothing',
    )

    // The human removes the chip: the marker is gone from `state.draft`, the
    // editor is plain, and nothing is on its way out.
    api.observeComposer(session, { draft: '请用 跑测试', phase: 'plain', pendingSubmissions: [] })
    await afterDebounce()

    assert.equal(stub.calls.length, 1, 'the removal armed exactly one withdrawal')
    assert.equal(stub.calls[0]?.url, api.RELEASE_PATH)
    assert.equal(stub.calls[0]?.method, 'POST')
    assert.deepEqual(stub.calls[0]?.body, { sessionId: session, variable: ENV_VAR, reason: 'withdrawn' })
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'withdrawn', 'the record is no longer staged')
    assert.equal(api.attachmentCount(session), 0, 'a withdrawn record does not count as attached')
    assert.equal(JSON.stringify(stub.calls).includes(SECRET), false, 'the withdrawal names the variable, never a value')

    // Re-inserting the same marker does not revive it: the value is gone, and
    // attaching this variable again means entering the value again (U4).
    api.observeComposer(session, { draft: `请用 @${ENV_VAR} 跑测试`, phase: 'plain', pendingSubmissions: [] })
    await afterDebounce()
    assert.equal(stub.calls.length, 1, 'a withdrawn record is not withdrawn twice')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'withdrawn', 'the value does not come back')

    // And the host's own list, read back, no longer reports it: the release
    // really ended the record (the host side of that answer is proved by
    // `test/attach.test.ts`, "release drops a staged attach").
    stub.attached.payload = { ok: true, attachments: [] }
    await api.refreshAttached(session)
    assert.equal(api.sessionAttachments(session).has(ENV_VAR), false, 'the host no longer reports a staged record')

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    restoreFetch()
  }
})

test('a send is never read as a removal: the optimistic draft clear keeps the value', async () => {
  const session = 'send-session'
  reset()
  const stub = stubRoutes()
  try {
    stageRecord(session, 1)
    api.observeComposer(session, { draft: `请用 @${ENV_VAR} 跑测试`, phase: 'plain', pendingSubmissions: [] })

    // The composer commits optimistically: the draft is cleared first, and the
    // pending submission echo carries the very text that has the marker in it.
    api.observeComposer(session, {
      draft: '',
      phase: 'plain',
      pendingSubmissions: [{ text: `请用 @${ENV_VAR} 跑测试` }],
    })
    assert.equal(api.observedState().pendingText.includes(`@${ENV_VAR}`), true)
    await afterDebounce()
    assert.deepEqual(stub.calls, [], 'a send must not be read as a removal')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'staged', 'the value survives the send')

    // A busy phase is not a removal either, even with the marker absent from the
    // draft and no echo left: `submitting` is one of the editor's own transient
    // states, and the guard is exactly that the phase is not `plain`.
    api.observeComposer(session, { draft: '', phase: 'submitting', pendingSubmissions: [] })
    await afterDebounce()
    assert.deepEqual(stub.calls, [], 'a busy editor phase keeps the value')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'staged')

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    restoreFetch()
  }
})

test('re-inserting inside the window cancels the withdrawal, and a replaced record is never the old timer\u2019s victim', async () => {
  const session = 'reinsert-session'
  reset()
  const stub = stubRoutes()
  try {
    stageRecord(session, 1)
    api.observeComposer(session, { draft: `请用 @${ENV_VAR}`, phase: 'plain', pendingSubmissions: [] })

    // Removed, then put back before the window closes: nothing was lost.
    api.observeComposer(session, { draft: '请用 ', phase: 'plain', pendingSubmissions: [] })
    api.observeComposer(session, { draft: `请用 @${ENV_VAR}`, phase: 'plain', pendingSubmissions: [] })
    await afterDebounce()
    assert.deepEqual(stub.calls, [], 'a re-insert inside the window means nothing happened')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'staged')

    // Removed again, and this time the variable is attached over: a new record
    // takes the slot (generation 2) while the timer is still armed for the record
    // it captured (generation 1). That timer must not take the new record down.
    api.observeComposer(session, { draft: '请用 ', phase: 'plain', pendingSubmissions: [] })
    stageRecord(session, 2)
    await afterDebounce()
    assert.deepEqual(stub.calls, [], 'a timer armed for a replaced record withdraws nothing')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'staged')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.generation, 2, 'the replacement is still the live record')

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    restoreFetch()
  }
})

test('a bound record is never withdrawn by the draft observer', async () => {
  const session = 'bound-session'
  reset()
  const stub = stubRoutes()
  try {
    api.sessionAttachments(session).set(ENV_VAR, {
      variable: ENV_VAR,
      name: 'openai',
      label: 'OpenAI API Key',
      scope: 'persistent',
      state: 'bound',
      createdAt: 1700000000000,
      generation: 1,
      seenPresent: true,
    })
    // The marker left the draft, but the record is anchored to a message now:
    // only taking that message back can end it, never the draft observer.
    api.observeComposer(session, { draft: '请用 ', phase: 'plain', pendingSubmissions: [] })
    assert.equal(
      api.decideWithdraw({ state: 'bound', seenPresent: true, markerPresent: false, submissionCarries: false, phase: 'plain' }),
      'keep',
    )
    await afterDebounce()
    assert.deepEqual(stub.calls, [], 'a bound record is not the draft observer\u2019s to end')
    assert.equal(api.sessionAttachments(session).get(ENV_VAR)?.state, 'bound')
    assert.equal(api.attachmentCount(session), 1)

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    restoreFetch()
  }
})

// ---- item 4: the `@` menu ---------------------------------------------------
//
// The menu is the host's own available list, rendered with its source in
// `section` and its scope in `description`, and a store-side row only ever
// *asks* before it registers (U5). These tests drive the source the way the
// trigger pipeline does (`candidates`, then `onPick`) and the confirm face the
// way a human does (the two buttons), with `fetch` stubbed: what is asserted is
// which request happened, when, and what the draft and the session then hold.

const STORE_VAR = 'DSH_SECRET_ANTHROPIC'

/** One available-list row, as the host reports it. */
function availableEntry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI API Key',
    scope: 'session',
    state: 'staged',
    source: 'session',
    ...over,
  }
}

test('the `@` menu lists the session\u2019s own secrets and the store\u2019s, each with its source and scope', async () => {
  const session = 'menu-session'
  reset()
  const stub = stubRoutes()
  try {
    stub.available.payload = {
      ok: true,
      entries: [
        availableEntry({}),
        availableEntry({
          variable: 'DSH_SECRET_BOUND',
          name: 'bound-key',
          label: 'Bound Key',
          scope: 'persistent',
          state: 'bound',
        }),
        availableEntry({
          variable: STORE_VAR,
          name: 'anthropic',
          label: STORE_VAR,
          scope: 'persistent',
          state: 'stored',
          source: 'store',
        }),
        // Unreadable rows are dropped, never guessed at.
        availableEntry({ variable: 'DSH_SECRET_BROKEN', name: undefined, label: undefined }),
        availableEntry({ variable: 'DSH_SECRET_ODD', source: 'elsewhere' }),
      ],
    }
    const source = sources[0] as Record<string, any>
    const rows = await source.candidates({ sessionId: session }, { query: '' })
    assert.deepEqual(stub.calls.map((call) => call.url), [`${api.AVAILABLE_PATH}?sessionId=${session}`])
    assert.equal(rows.length, 3, 'only the readable rows survive')
    // Both kinds, each saying where it comes from (section) and what it is
    // (description) — and the scope is spelled by the same literal table the
    // capsule and the history area use, so the three faces cannot drift apart.
    assert.deepEqual(
      rows.map((row: Record<string, any>) => [row.label, row.name, row.section, row.description]),
      [
        ['OpenAI API Key', 'openai', api.ATTACH_ZH.sectionSession, api.ATTACH_ZH.descSessionStaged],
        ['Bound Key', 'bound-key', api.ATTACH_ZH.sectionSession, api.ATTACH_ZH.descSessionBoundPersistent],
        [STORE_VAR, 'anthropic', api.ATTACH_ZH.sectionStore, api.ATTACH_ZH.descStore],
      ],
    )
    assert.equal(rows[0]?.description.includes('仅本次会话有效'), true, 'a session row says its scope')
    assert.equal(rows[0]?.description.includes('持久保存到凭据库'), false)
    assert.equal(rows[1]?.description.includes('持久保存到凭据库'), true, 'a durable session row says so')
    assert.equal(rows[2]?.description.includes('持久保存到凭据库'), true, 'a store row says its scope')
    assert.equal(rows[2]?.description.includes('尚未用于本会话'), true, 'a store row says it is not in this session yet')
    // The payload is this source's own encoding, and only that.
    assert.deepEqual(api.readCandidateValue(rows[0]?.value), { v: ENV_VAR, origin: 'session' })
    assert.deepEqual(api.readCandidateValue(rows[2]?.value), { v: STORE_VAR, origin: 'store' })
    assert.equal(api.readCandidateValue('{"v":"DSH_SECRET_X"}'), null, 'a payload this half did not write is refused')
    assert.equal(api.readCandidateValue('not json'), null)
    assert.equal(rows.every((row: Record<string, any>) => JSON.stringify(row).includes(SECRET)), false)

    // The typed query narrows both kinds by variable, credential key or label.
    assert.deepEqual((await source.candidates({ sessionId: session }, { query: 'anth' })).map((row: any) => row.name), ['anthropic'])
    assert.deepEqual((await source.candidates({ sessionId: session }, { query: 'bound key' })).map((row: any) => row.name), ['bound-key'])
    assert.deepEqual(await source.candidates({ sessionId: session }, { query: 'zzz' }), [])
    // A menu that has moved on gets nothing, and an aborted fetch asks nothing.
    const asked = stub.calls.length
    assert.deepEqual(await source.candidates({ sessionId: session }, { signal: { aborted: true } }), [])
    assert.equal(stub.calls.length, asked, 'an aborted read never reaches the host')
    assert.deepEqual(await source.candidates({ sessionId: '' }, {}), [])
    assert.deepEqual(await source.candidates(undefined, {}), [])
    assert.equal(stub.calls.length, asked, 'a sessionless menu asks nothing')

    // A host that cannot answer does not erase the menu: the rows the page
    // already read stay (a hiccup is not evidence that nothing is available),
    // and the next good answer replaces them.
    stub.available.ok = false
    assert.equal((await source.candidates({ sessionId: session }, {})).length, 3)
    stub.available.ok = true
    stub.available.payload = { ok: true, entries: [availableEntry({ name: 'replaced' })] }
    assert.deepEqual((await source.candidates({ sessionId: session }, {})).map((row: any) => row.name), ['replaced'])

    reset()
  } finally {
    restoreFetch()
  }
})

test('a store-side pick asks first: nothing is registered until the human confirms, and the confirm inserts the shared marker', async () => {
  const session = 'confirm-session'
  reset()
  const stub = stubRoutes()
  try {
    api.clearPendingPick()
    stub.available.payload = {
      ok: true,
      entries: [availableEntry({ variable: STORE_VAR, name: 'anthropic', label: STORE_VAR, scope: 'persistent', state: 'stored', source: 'store' })],
    }
    const source = sources[0] as Record<string, any>
    const rows = await source.candidates({ sessionId: session }, {})
    assert.equal(rows.length, 1)
    stub.calls.length = 0

    // The pick: the menu closes, the question opens, and nothing is written.
    assert.equal(
      source.onPick({ candidate: rows[0], session: { sessionId: session }, action: 'pick', span: { start: 3, end: 3, draftRev: 7 } }),
      'handled',
      'the pick is answered without inserting anything',
    )
    assert.equal(stub.calls.length, 0, 'a store-side pick registers nothing by itself')
    assert.deepEqual(api.currentMode(), { kind: 'confirm', variable: STORE_VAR, name: 'anthropic' })
    assert.equal(api.sessionAttachments(session).has(STORE_VAR), false, 'nothing is registered before the human answers')
    // The pick remembers the span it must insert into — the menu's own, not a guess.
    assert.deepEqual(api.pendingPickOf(), { sessionId: session, variable: STORE_VAR, name: 'anthropic', span: { start: 3, end: 3, draftRev: 7 } })

    // The question shows the variable, where it comes from and its scope.
    const asked = renderer.render(CAPSULE, { sessionId: session })
    assert.notEqual(
      elements(asked).find((element) => element.props['data-secret-attach-capsule'] === 'confirm'),
      undefined,
      'the store-side pick has no confirmation face',
    )
    const askedText = visibleText(asked)
    assert.equal(askedText.includes(STORE_VAR), true, 'the question names the variable')
    assert.equal(askedText.includes(api.ATTACH_ZH.sectionStore), true, 'the question names the source')
    assert.equal(askedText.includes(api.ATTACH_ZH.persistent), true, 'the question names the scope')
    assert.equal(askedText.includes(api.ATTACH_ZH.confirmAction), true)
    assert.equal(askedText.includes(api.ATTACH_ZH.confirmCancel), true)
    assert.equal(askedText.includes(SECRET), false, 'the question never carries a value')

    // Cancel registers nothing at all: the pick's whole effect was the question.
    clickAction(asked, 'confirm-cancel')
    assert.equal(stub.calls.length, 0)
    assert.equal(api.sessionAttachments(session).has(STORE_VAR), false)
    assert.equal(api.pendingPickOf(), null, 'a cancelled confirm leaves nothing armed')
    assert.deepEqual(api.currentMode(), { kind: 'idle' })

    // Confirming registers through the host's own adopt route, then inserts.
    const actions = {
      captureInsertion: () => ({ start: 3, end: 3, draftRev: 9 }),
      insertText: () => true,
    }
    bailCalls.length = 0
    stub.adopt.payload = { ok: true, variable: STORE_VAR, scope: 'persistent', replaced: false }
    source.onPick({ candidate: rows[0], session: { sessionId: session }, action: 'pick', span: { start: 3, end: 3, draftRev: 7 } })
    clickAction(renderer.render(CAPSULE, { sessionId: session, inputActions: actions }), 'confirm-adopt')
    await flushOneTurn()

    assert.deepEqual(
      stub.calls.map((call) => [call.url, call.method, call.body]),
      [[api.ADOPT_PATH, 'POST', { sessionId: session, variable: STORE_VAR }]],
      'the confirmation is what asks the host to register, and it sends no value',
    )
    const meta = api.sessionAttachments(session).get(STORE_VAR)
    assert.equal(meta?.state, 'staged', 'the confirmed record is registered for this session')
    assert.equal(meta?.scope, 'persistent')
    assert.equal(meta?.name, 'anthropic')
    assert.equal(meta?.seenPresent, false, 'the marker has not been reported in the draft yet')
    assert.equal(api.pendingPickOf(), null, 'the confirm is spent after it is taken')
    assert.deepEqual(api.currentMode(), { kind: 'detail', variable: STORE_VAR })
    // The reference that landed is the frozen contract's own shape, carrying the
    // marker the codec owns — the same thing the fill form's insertion produces —
    // and it went into the span the menu's own hit named.
    assert.deepEqual(bailCalls.at(-1), {
      name: 'slash/input-insert-reference',
      payload: {
        reference: { source: 'secret', ref: STORE_VAR, label: STORE_VAR, appearance: 'session', clipboardText: `@${STORE_VAR}` },
        span: { start: 3, end: 3, draftRev: 7 },
      },
    })
    assert.equal(
      (bailCalls.at(-1)?.payload as { reference: { clipboardText: string } }).reference.clipboardText,
      await source.codec.serialize(STORE_VAR, new AbortController().signal),
      'the menu path and the codec agree on the marker',
    )
    assert.equal(JSON.stringify(stub.calls).includes(SECRET), false)

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    api.clearPendingPick()
    restoreFetch()
  }
})

test('a session-side pick inserts at once, and a pick that is not this source\u2019s is left alone', async () => {
  const session = 'menu-pick-session'
  reset()
  const stub = stubRoutes()
  try {
    api.clearPendingPick()
    const source = sources[0] as Record<string, any>
    // A session-side row: its record already exists, so no question is asked.
    const outcome = source.onPick({
      candidate: { name: 'openai', value: JSON.stringify({ v: ENV_VAR, origin: 'session' }) },
      session: { sessionId: session },
      action: 'pick',
      span: { start: 1, end: 1, draftRev: 4 },
    })
    assert.deepEqual(outcome, {
      insert: { source: 'secret', ref: ENV_VAR, label: ENV_VAR, appearance: 'session', clipboardText: `@${ENV_VAR}` },
    })
    assert.equal(outcome.insert.clipboardText, source.codec.clipboardText(ENV_VAR), 'the menu uses the codec\u2019s own marker')
    assert.deepEqual(api.currentMode(), { kind: 'idle' }, 'a session-side pick opens no question')
    assert.equal(stub.calls.length, 0, 'a session-side pick writes nothing')
    assert.equal(api.pendingPickOf(), null)

    // Another source's row, a drill, and the same row with no pick action: never
    // this source's insert.
    assert.equal(source.onPick({ candidate: { name: 'x', value: 'not json' }, session: { sessionId: session }, action: 'pick' }), undefined)
    assert.equal(
      source.onPick({ candidate: { name: 'x', value: JSON.stringify({ v: ENV_VAR, origin: 'session' }) }, session: { sessionId: session }, action: 'drill' }),
      undefined,
      'a drill opens a sub-menu instead of choosing',
    )
    assert.equal(
      source.onPick({ candidate: { name: 'x', value: JSON.stringify({ v: ENV_VAR, origin: 'elsewhere' }) }, session: { sessionId: session } }),
      undefined,
    )
    assert.deepEqual(api.currentMode(), { kind: 'idle' })

    // A store-side row with no session to register into inserts nothing either:
    // an unanswered question would leave a marker with nothing behind it.
    assert.equal(
      source.onPick({
        candidate: { name: 'anthropic', value: JSON.stringify({ v: STORE_VAR, origin: 'store' }) },
        session: {},
        action: 'pick',
      }),
      'handled',
    )
    assert.equal(api.pendingPickOf(), null)
    assert.deepEqual(api.currentMode(), { kind: 'idle' })
    assert.deepEqual(stub.calls, [])

    reset()
  } finally {
    api.clearPendingPick()
    restoreFetch()
  }
})

test('a refused registration inserts nothing and says so, and the failure sentences are the plugin\u2019s own', async () => {
  const session = 'confirm-refused-session'
  reset()
  const stub = stubRoutes()
  try {
    api.clearPendingPick()
    stub.available.payload = {
      ok: true,
      entries: [availableEntry({ variable: STORE_VAR, name: 'anthropic', label: STORE_VAR, scope: 'persistent', state: 'stored', source: 'store' })],
    }
    const source = sources[0] as Record<string, any>
    const rows = await source.candidates({ sessionId: session }, {})
    stub.calls.length = 0
    bailCalls.length = 0

    // The host refuses: nothing is registered, nothing is inserted, and the
    // question stays up with a fixed sentence (never the host's own error text).
    const HOST_CANARY = 'adopt: credential backend said sk-host-text-DO-NOT-SHOW'
    stub.adopt.ok = false
    stub.adopt.payload = { ok: false, error: HOST_CANARY }
    source.onPick({ candidate: rows[0], session: { sessionId: session }, action: 'pick', span: { start: 1, end: 1, draftRev: 2 } })
    const asked = renderer.render(CAPSULE, { sessionId: session, inputActions: { captureInsertion: () => ({ start: 1, end: 1, draftRev: 2 }), insertText: () => true } })
    clickAction(asked, 'confirm-adopt')
    await flushOneTurn()
    assert.equal(api.sessionAttachments(session).has(STORE_VAR), false)
    assert.deepEqual(bailCalls, [], 'a refused registration inserts nothing')
    assert.equal(api.currentMode().kind, 'confirm', 'the question stays up after a refusal')
    const refused = visibleText(renderer.render(CAPSULE, { sessionId: session }))
    assert.equal(refused.includes(api.ATTACH_ZH.adopt500), true)
    assert.equal(refused.includes(HOST_CANARY), false, 'the host\u2019s own error text is never surfaced')

    // The fixed sentences are this plugin's own, by the host's own status.
    assert.equal(api.adoptErrorFor(404), api.ATTACH_ZH.adopt404)
    assert.equal(api.adoptErrorFor(409), api.ATTACH_ZH.adopt409)
    assert.equal(api.adoptErrorFor(500), api.ATTACH_ZH.adopt500)
    assert.equal(api.adoptErrorFor(418), api.ATTACH_ZH.confirmFailed)
    for (const text of [api.ATTACH_ZH.adopt404, api.ATTACH_ZH.adopt409, api.ATTACH_ZH.adopt500, api.ATTACH_ZH.confirmFailed]) {
      assert.equal(text.includes(SECRET), false)
    }

    api.sessionAttachments(session).clear()
    reset()
  } finally {
    api.clearPendingPick()
    restoreFetch()
  }
})

// ---- the management surface (round 5) ---------------------------------------
//
// Three things have to be true of the info box's management face, and these
// tests are about exactly those: the list shows both halves with the Host's own
// `can` facts, the two deletion tiers are two different buttons with two
// different confirmations, and the only field a value can travel in is a masked
// input a human typed into.

const MANAGE = (globalThis as Record<string, unknown>).__cordisSecretManage as Record<string, any>

/** One management row as the wire carries it, value-free by construction. */
function manageRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI',
    scope: 'persistent',
    state: 'staged',
    source: 'both',
    can: { unbind: true, delete: true, scope: true, value: true },
    ...over,
  }
}

/** Serve one management list to this page's read. */
async function withManageList(entries: readonly unknown[], run: () => Promise<void>): Promise<void> {
  const stub = stubFetch()
  try {
    stub.answer.payload = { ok: true, entries }
    await MANAGE.refreshManage(SESSION_ID)
    await run()
  } finally {
    restoreFetch()
  }
}

test('the management readers drop what they cannot understand, and never guess a can', () => {
  const row = manageRow()
  assert.deepEqual(MANAGE.readManageEntry(row), {
    variable: ENV_VAR,
    name: 'openai',
    label: 'OpenAI',
    scope: 'persistent',
    state: 'staged',
    source: 'both',
    can: { unbind: true, delete: true, scope: true, value: true },
  })
  // A missing or mangled `can` means "not proven", which is the safe direction
  // for an action that changes durable state.
  assert.deepEqual(MANAGE.readManageEntry({ ...row, can: undefined })?.can, {
    unbind: false,
    delete: false,
    scope: false,
    value: false,
  })
  assert.deepEqual(MANAGE.readManageEntry({ ...row, can: { unbind: 'yes' } })?.can, {
    unbind: false,
    delete: false,
    scope: false,
    value: false,
  })
  // Unknown shapes are dropped, never rendered as a half-read row.
  assert.equal(MANAGE.readManageEntry({ ...row, state: 'bound-and-then-some' }), null)
  assert.equal(MANAGE.readManageEntry({ ...row, source: 'elsewhere' }), null)
  assert.equal(MANAGE.readManageEntry({ ...row, variable: undefined }), null)
  assert.equal(MANAGE.readManageList({ ok: true, entries: [row, 7, null] })?.length, 1)
  assert.equal(MANAGE.readManageList({ entries: [row] }), null)
  assert.equal(MANAGE.readManageList(null), null)
  // The wire row and the reader carry no value field at all.
  assert.equal(JSON.stringify(MANAGE.readManageEntry(row)).includes(SECRET), false)
})

test('the management face lists both halves and offers only what the Host proved', async () => {
  reset()
  api.setAttachMode({ kind: 'manage' })
  await withManageList(
    [
      manageRow(),
      manageRow({
        variable: 'DSH_SECRET_OTHER',
        name: 'other',
        label: 'DSH_SECRET_OTHER',
        scope: 'persistent',
        state: 'stored',
        source: 'store',
        can: { unbind: false, delete: true, scope: false, value: true },
      }),
    ],
    async () => {
      const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID })
      const text = visibleText(tree)
      assert.equal(text.includes(api.ATTACH_ZH.manageSectionSession), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageSectionStore), true)
      assert.equal(text.includes(ENV_VAR), true)
      assert.equal(text.includes('DSH_SECRET_OTHER'), true)
      // The two deletion tiers are two differently-worded buttons.
      assert.equal(text.includes(api.ATTACH_ZH.manageActUnbind), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageActDelete), true)
      assert.notEqual(api.ATTACH_ZH.manageActUnbind, api.ATTACH_ZH.manageActDelete)
      assert.equal(text.includes(api.ATTACH_ZH.manageActScopeDown), true)
      const rows = elements(tree).filter((element) => element.props['data-secret-manage-row'] !== undefined)
      assert.equal(rows.length, 2)
      // A store-only row offers no unbind and no re-scope — the Host said so.
      const storeRow = rows.find((element) => element.props['data-secret-manage-row'] === 'store')
      const storeActions = elements(storeRow)
        .map((element) => element.props['data-action'])
        .filter((action: unknown): action is string => typeof action === 'string')
      assert.deepEqual(storeActions.sort(), ['manage-delete', 'manage-value'])
      // No value can reach this tree: the face renders names and metadata only.
      assert.equal(text.includes(SECRET), false)
    },
  )
  reset()
})

test('cancelling the value form leaves the human’s value nowhere', () => {
  reset()
  api.setAttachMode({ kind: 'edit', variable: ENV_VAR, target: 'store' })
  const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  const inputs = elements(tree).filter((element) => element.type === 'input')
  const field = inputs.find((element) => element.props.id === 'dsh-secret-manage-value')
  assert.notEqual(field, undefined, 'the value form owns a masked input')
  assert.equal(field?.props.type, 'password')
  ;(field?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
    target: { value: SECRET },
  })
  const filled = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  // Positive control: the value really is in this control's own value (P1), so
  // the scan below is proving a leak rather than an empty tree.
  const refilled = elements(filled).find((element) => element.props.id === 'dsh-secret-manage-value')
  assert.equal(refilled?.props.value, SECRET, 'the masked control holds what the human typed')
  const elsewhere = elements(filled)
    .flatMap((element) =>
      Object.entries(element.props)
        .filter(([key]) => key !== 'value' && key !== 'onChange' && key !== 'children')
        .map(([, held]) => JSON.stringify(held) ?? ''),
    )
    .join('|')
  assert.equal(elsewhere.includes(SECRET), false, 'the typed value never lands in an attribute')
  assert.equal(visibleText(filled).includes(SECRET), false, 'nor in any rendered text')
  clickAction(filled, 'manage-value-cancel')
  assert.equal(api.currentMode().kind, 'manage')
  const back = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  assert.equal(JSON.stringify(back).includes(SECRET), false, 'cancelling keeps nothing behind')
  reset()
})

test('the danger face asks two different questions for the two deletion tiers', () => {
  reset()
  api.setAttachMode({ kind: 'danger', variable: ENV_VAR, act: 'unbind' })
  const unbind = visibleText(renderer.render(CAPSULE, { sessionId: SESSION_ID }))
  assert.equal(unbind.includes(api.ATTACH_ZH.dangerUnbindTitle), true)
  assert.equal(unbind.includes('不可恢复'), false, 'unbinding is not irreversible, and must not claim to be')
  assert.equal(unbind.includes(api.ATTACH_ZH.dangerConfirmUnbind), true)

  api.setAttachMode({ kind: 'danger', variable: ENV_VAR, act: 'delete' })
  const remove = visibleText(renderer.render(CAPSULE, { sessionId: SESSION_ID }))
  assert.equal(remove.includes(api.ATTACH_ZH.dangerDeleteTitle), true)
  assert.equal(remove.includes('不可恢复'), true)
  assert.equal(remove.includes(api.ATTACH_ZH.dangerConfirmDelete), true)
  // The two confirmations are different words for different acts.
  assert.notEqual(api.ATTACH_ZH.dangerConfirmUnbind, api.ATTACH_ZH.dangerConfirmDelete)
  reset()
})

test('the scope change keeps the two directions apart, and only one of them is destructive', async () => {
  reset()
  api.setAttachMode({ kind: 'manage' })
  const sent: Record<string, unknown>[] = []
  const realFetch = (globalThis as Record<string, unknown>).fetch
  ;(globalThis as Record<string, unknown>).fetch = async (_url: unknown, init?: { body?: unknown }) => {
    if (init?.body !== undefined) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        action: 'scope',
        variable: ENV_VAR,
        scope: 'session',
        changed: { session: true, store: false },
      }),
    }
  }
  try {
    await MANAGE.refreshManage(SESSION_ID)
    const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID })
    clickAction(tree, 'manage-scope-session')
    await flushOneTurn()
    assert.equal(sent.length, 1)
    // The non-destructive direction carries no confirmation and no delete.
    assert.deepEqual(sent[0], { sessionId: SESSION_ID, action: 'scope', variable: ENV_VAR, to: 'session' })
    assert.equal('confirm' in (sent[0] ?? {}), false, 'the non-destructive direction needs no confirmation')
    assert.equal(JSON.stringify(sent[0]).includes(SECRET), false)
    // And the sentence the human reads afterwards must state this direction's
    // own fact: the store record is kept. The two directions have two different
    // sentences, and only the deletion one may claim a deletion.
    assert.equal(api.ATTACH_ZH.reportScopeDown.includes('保留'), true)
    assert.equal(api.ATTACH_ZH.reportScopeDown.includes('已删除'), false)
    assert.notEqual(api.ATTACH_ZH.reportScopeDown, api.ATTACH_ZH.reportDelete)
    assert.equal(api.ATTACH_ZH.reportDelete.includes('已从凭据库删除'), true)
  } finally {
    ;(globalThis as Record<string, unknown>).fetch = realFetch
    reset()
  }
})

test('the management seam is a third frozen object, and the two older ones are untouched', () => {
  assert.equal(Object.isFrozen(MANAGE), true)
  assert.deepEqual(Object.keys(MANAGE).sort(), [
    'HiddenSecretManageToolRow',
    'MANAGE_CARD_KIND',
    'MANAGE_FAILURE',
    'MANAGE_FAILURE_UNKNOWN',
    'MANAGE_META_KIND',
    'MANAGE_PATH',
    'MANAGE_TOOL_NAME',
    'MANAGE_UNREACHABLE',
    'SecretManageCard',
    'asManageCardData',
    'describeManage',
    'manageActionTitle',
    'manageErrorFor',
    'manageFailed',
    'manageOf',
    'manageRead',
    'parseManageCallRequest',
    'postManage',
    'readManageEntry',
    'readManageList',
    'readManageOutcome',
    'readManagePending',
    'refreshManage',
    'secretManageDefinition',
    'version',
  ])
  // The card's own seam is frozen from the rounds before it: same keys.
  assert.deepEqual(
    Object.keys((globalThis as Record<string, unknown>).__cordisSecretClient as object).sort(),
    [
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
    ],
  )
  // New history events are mirrored in both tables, and the unknown-event rule
  // still holds: a label lookup for an event nobody renders is not a crash.
  assert.deepEqual([...api.HISTORY_EVENTS].sort(), Object.keys(api.HISTORY_LABEL).sort())
  for (const event of ['updated', 'scope-changed', 'unbound', 'deleted']) {
    assert.equal(api.HISTORY_EVENTS.includes(event), true)
    assert.notEqual(api.historyEventKey(event), undefined)
  }
  assert.equal(api.historyEventKey('invented-by-nobody'), undefined)
  // And the management card's own tool can never claim the request card's call.
  const requestCall = { type: 'tool/call', data: { name: 'secret_request', callId: 'c1' } }
  const manageCall = { type: 'tool/call', data: { name: 'secret_manage', callId: 'c2' } }
  assert.equal(MANAGE.secretManageDefinition.match(requestCall), null)
  assert.deepEqual(MANAGE.secretManageDefinition.match(manageCall), { id: 'c2', role: 'start' })
  const CARD_SEAM = (globalThis as Record<string, unknown>).__cordisSecretClient as Record<string, any>
  assert.equal(CARD_SEAM.secretRequestDefinition.match(manageCall), null)
})

// ---------------------------------------------------------------------------
// Round 5, second pass (the user's ruling ①): the management list's
// "usable in this session" section covers both directions, and a reader can
// always tell which one a row came from.
//
// These two tests live at the end of the file on purpose: `reset()` does not
// clear the management list this module caches per session, and the two clicks
// above read that cache when their own list read is stubbed. Adding a list here
// would silently repaint their fixture.
// ---------------------------------------------------------------------------

test('the management readers name the session-side direction, and never guess one', () => {
  // A row from a Host that predates `origin` stays readable: the field is
  // information, not an action, so its absence offers nothing.
  const older = MANAGE.readManageEntry(manageRow())
  assert.equal(older?.origin, undefined)
  assert.equal(MANAGE.describeManage(older).includes(api.ATTACH_ZH.manageOriginAttach), false)

  const attached = MANAGE.readManageEntry(manageRow({ origin: 'attach' }))
  assert.equal(attached?.origin, 'attach')
  const asked = MANAGE.readManageEntry(
    manageRow({ variable: 'DSH_SECRET_ASKED', state: 'authorized', origin: 'request' }),
  )
  assert.equal(asked?.state, 'authorized')
  assert.equal(asked?.origin, 'request')
  // A mangled direction is dropped, never invented.
  assert.equal(MANAGE.readManageEntry(manageRow({ origin: 'elsewhere' }))?.origin, undefined)

  // The provenance line puts the direction first, so the two classes never read
  // the same — and a store-only row reports no session-side direction at all.
  const attachedLine = MANAGE.describeManage(attached)
  const askedLine = MANAGE.describeManage(asked)
  assert.equal(attachedLine.includes(api.ATTACH_ZH.manageOriginAttach), true)
  assert.equal(askedLine.includes(api.ATTACH_ZH.manageOriginRequest), true)
  assert.equal(askedLine.includes(api.ATTACH_ZH.manageStateAuthorized), true)
  assert.notEqual(attachedLine, askedLine)
  const storeLine = MANAGE.describeManage(MANAGE.readManageEntry(manageRow({ state: 'stored', source: 'store' })))
  assert.equal(storeLine.includes(api.ATTACH_ZH.manageOriginAttach), false)
  assert.equal(storeLine.includes(api.ATTACH_ZH.manageOriginRequest), false)
})

test('the management face shows both session-side directions and labels each one', async () => {
  reset()
  api.setAttachMode({ kind: 'manage' })
  await withManageList(
    [
      manageRow({
        variable: 'DSH_SECRET_LOCAL_ONLY',
        label: 'Local Only',
        state: 'staged',
        source: 'session',
        origin: 'attach',
      }),
      manageRow({
        variable: 'DSH_SECRET_ASKED',
        label: 'Asked',
        state: 'authorized',
        source: 'session',
        origin: 'request',
      }),
    ],
    async () => {
      const tree = renderer.render(CAPSULE, { sessionId: SESSION_ID })
      const text = visibleText(tree)
      assert.equal(text.includes(api.ATTACH_ZH.manageSectionSession), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageSectionStore), false, 'both rows are session-side')
      const rows = elements(tree).filter((element) => element.props['data-secret-manage-row'] !== undefined)
      assert.deepEqual(
        rows.map((element) => element.props['data-secret-manage-origin']),
        ['attach', 'request'],
        'each row carries the direction it came from',
      )
      assert.equal(text.includes(api.ATTACH_ZH.manageOriginAttach), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageOriginRequest), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageStateAuthorized), true)
      assert.equal(text.includes(api.ATTACH_ZH.manageStateStaged), true)
      assert.equal(text.includes(SECRET), false)
    },
  )
  reset()
})

// ---------------------------------------------------------------------------
// The user's security report: keys typed into this plugin were being autofilled
// and captured by the browser and by password managers. Every field that can
// hold a secret must therefore be un-fillable and un-savable — a property of the
// rendered props, which is exactly what these two tests pin. (Whether a given
// browser or extension still offers something can only be seen in a real
// browser; that part is listed as needing a human, never claimed here.)
// ---------------------------------------------------------------------------

/** The bag every field that can hold a secret must carry (`src/client/entry.ts`). */
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

/** Assert the suppression bag, and that no `name` gives a manager a handle. */
function assertSuppressed(field: Element | undefined, where: string): void {
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
}

/** The bag plus the read-only-until-focus guard, with the release exercised. */
function assertSecretField(field: Element | undefined, where: string): void {
  assertSuppressed(field, where)
  const props = (field as Element).props
  assert.equal(props.readOnly, true, `${where}: must start read-only so autofill skips it on load`)
  const onFocus = props.onFocus as ((event: unknown) => void) | undefined
  assert.equal(typeof onFocus, 'function', `${where}: must release the read-only guard on focus`)
  const node = { readOnly: true }
  onFocus?.({ currentTarget: node })
  assert.equal(node.readOnly, false, `${where}: focus must release the read-only guard`)
}

test('every capsule and card field that can hold a secret is un-fillable and un-savable', () => {
  reset()
  // The capsule's fill face: the credential key, the label, and the value.
  api.setAttachMode({ kind: 'fill' })
  const fill = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  const fillFields = elements(fill).filter(
    (element) => element.type === 'input' && (element.props.type === 'text' || element.props.type === 'password'),
  )
  assert.equal(fillFields.length, 3, 'the fill face owns key, label and value fields')
  for (const field of fillFields) assertSuppressed(field, `fill ${String(field.props.id)}`)
  // Only the value field is a secret, and it is the one that starts masked and
  // carries the read-only guard; the key and label are identifiers.
  const fillValue = fillFields.find((field) => field.props.id === 'dsh-secret-attach-value')
  assert.equal(fillValue?.props.type, 'password', 'the secret field starts masked')
  assertSecretField(fillValue, 'fill value')
  for (const field of fillFields.filter((candidate) => candidate.props.id !== 'dsh-secret-attach-value')) {
    assert.equal(field.props.readOnly, undefined, `${String(field.props.id)} is an identifier, not a secret`)
  }

  // The capsule's change-value face.
  reset()
  api.setAttachMode({ kind: 'edit', variable: ENV_VAR, target: 'session' })
  const edit = renderer.render(CAPSULE, { sessionId: SESSION_ID })
  const editFields = elements(edit).filter(
    (element) => element.type === 'input' && (element.props.type === 'text' || element.props.type === 'password'),
  )
  assert.equal(editFields.length, 1)
  assert.equal(editFields[0]?.props.type, 'password', 'the change-value field starts masked')
  assertSecretField(editFields[0], 'manage edit value')

  // The management card: the field the human types a new secret into, and the
  // value-free masked copy it displays for a scope upgrade.
  const manageCard = MANAGE.SecretManageCard as (props: unknown) => unknown
  const typedCard = manageCard({
    node: {
      data: {
        callId: 'call-manage-1',
        request: { action: 'value', target: 'session' },
        requestUnreadable: false,
        settled: false,
        outcome: null,
        failure: null,
      },
    },
    sessionId: SESSION_ID,
  })
  const typedFields = elements(typedCard).filter(
    (element) => element.type === 'input' && (element.props.type === 'text' || element.props.type === 'password'),
  )
  assert.equal(typedFields.length, 1, 'one field to type the new secret into')
  assertSecretField(typedFields[0], 'manage card value')

  const scopeCard = manageCard({
    node: {
      data: {
        callId: 'call-manage-2',
        request: { action: 'scope', to: 'persistent' },
        requestUnreadable: false,
        settled: false,
        outcome: null,
        failure: null,
      },
    },
    sessionId: SESSION_ID,
  })
  const scopeFields = elements(scopeCard).filter(
    (element) => element.type === 'input' && element.props.type === 'password',
  )
  assert.equal(scopeFields.length, 1, 'the scope upgrade shows one masked display field')
  assertSuppressed(scopeFields[0], 'manage card scope display')
  assert.equal(scopeFields[0]?.props.value, '', 'the display field holds no value')
  assert.equal(scopeFields[0]?.props.disabled, true, 'and it is not editable')
  reset()
})
