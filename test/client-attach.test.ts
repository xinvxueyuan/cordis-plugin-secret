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
  // The core surface is registered anyway: the card, its tool row, the button
  // and the capsule need none of the three services.
  assert.deepEqual(
    bare.registrations.map((entry) => entry.name).sort(),
    ['conversation.chat.node', 'conversation.input.left', 'conversation.input.overlay', 'tool.call.toolview'],
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

test('the reference source serializes, decorates and routes clicks without offering candidates', async () => {
  reset()
  const source = sources[0] as Record<string, any>
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'secret')
  assert.equal(source.showGroupTitle, false)
  // Nothing is ever offered in the `@` menu, and no space/enter hook is
  // implemented, so typing `@` keeps its file/session meaning.
  assert.deepEqual(await source.candidates({ sessionId: SESSION_ID }, {}), [])
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
  assert.deepEqual(list?.[0], { variable: ENV_VAR, name: 'openai', label: 'OpenAI', scope: 'session', state: 'staged', createdAt: 5 })
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
