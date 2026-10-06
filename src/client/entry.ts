/**
 * Browser half of @xinvxueyuan/cordis-plugin-secret.
 *
 * This file is deliberately a *script*: the client module system loads a
 * package's browser artifact as a classic `<script>`, and the artifact's only
 * side effect is registering a factory with `window.__ModuleLoader__.load`. It
 * therefore has no imports and no exports — React comes from the browser module
 * table through the factory's `require`, and no Harness Client package is
 * imported as a module.
 *
 * This half owns exactly one visible interaction surface per `secret_request`
 * call: its own conversation card, rendered in the agent's output stream as a
 * first-class flow entry. It never covers the viewport, never takes over the
 * whole screen, and never occupies the composer. The card's node is
 * materialized the moment the `tool/call` event appears and settles from the
 * durable `tool/result` record, so a reloaded page rebuilds the same card.
 *
 * The card deliberately carries no Turn/Step coordinate. A Chat node without
 * one is emitted as a root flow entry, so it can never be folded into a
 * step-process group ("已调用工具") and stays visible in every work-details
 * mode (简洁 / 标准 / 详细 / 完全展开).
 *
 * The interaction is the only place a secret value is ever typed. It travels in
 * the body of one authenticated POST to this plugin's own `/api` route and
 * nowhere else: never a query string, never a URL, never the session log, never
 * a rendered attribute.
 *
 * The reverse direction's optional collaborators — a locale face, the
 * input-trigger registry, the session controller — are never hard dependencies:
 * they are reached through cordis's optional seat (`ctx.inject([...], cb)`), so
 * a web client that lacks one degrades instead of failing the whole entry.
 */

/** Just enough React surface for this one component. */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void]
  useEffect(effect: () => (() => void) | undefined | void, deps?: readonly unknown[]): void
}

interface ModuleLoaderTarget {
  load(registration: {
    readonly id: string
    readonly factory: (require: (id: string) => unknown) => unknown
  }): void
}

/** Client context surface this plugin uses. */
interface ClientContextLike {
  readonly slots: {
    inject(owner: string, declare: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  readonly uiConversation: {
    readonly events: { register(definition: unknown): unknown }
  }
  /**
   * Cordis's own optional-dependency seat.
   *
   * The callback runs with a context that has exactly `names` in scope, once
   * every one of them is available; a name that never appears simply never runs
   * it. This is the only way this half may touch a service the environment may
   * not have: reading an undeclared service off `ctx` throws inside the context
   * proxy (`cannot get property "<name>" without inject`) and fails the whole
   * client entry, while a missing optional service must only degrade.
   */
  inject(names: readonly string[], callback: (scoped: OptionalServicesLike) => void): unknown
}

type Scope = 'session' | 'persistent'
type Decision = 'approved' | 'rejected' | 'ignored' | 'other'

/** Request material the card renders. Never carries a secret value. */
interface CardRequest {
  readonly name: string
  readonly label: string
  readonly reason: string
  readonly description?: string
  readonly requestedScope: Scope
  /** Display name; derived from the call until the Host's view supersedes it. */
  readonly variable: string
  readonly alreadyConfigured: boolean
}

/** The settled decision as the tool persisted it on `tool/result.meta`. */
interface CardOutcome {
  readonly decision: Decision
  readonly variable?: string
  readonly scope?: Scope
  readonly source?: 'store' | 'entered'
  readonly notice?: string
  readonly reason?: string
  readonly text?: string
}

/** Durable failure identity of a settled tool result. */
interface CardFailure {
  readonly name: string
  readonly code: string
  readonly reason?: string
}

/**
 * One card's durable state: a pure function of the session events. Interaction
 * state (draft, submission, host view) lives in the component, never here.
 */
interface CardData {
  readonly callId: string
  readonly request: CardRequest | null
  /** True when the recorded call arguments could not be read (fallback F1). */
  readonly requestUnreadable: boolean
  readonly settled: boolean
  readonly outcome: CardOutcome | null
  readonly failure: CardFailure | null
}

/** One waiting interaction as the Host's `/api/secret.pending` reports it. */
interface PendingEntry {
  readonly id: string
  readonly callId?: string
  readonly sessionId?: string
  readonly name?: string
  readonly label?: string
  readonly reason?: string
  readonly description?: string
  readonly requestedScope?: Scope
  readonly variable?: string
  readonly alreadyConfigured?: boolean
  readonly createdAt?: number
}

/** What one poll learned. `unreachable` is never evidence that a request ended. */
type PendingProbe =
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'ok'; readonly entries: readonly PendingEntry[] }

/** Where this card's request stands, decided only from the probe above. */
type CardHostStatus = 'preparing' | 'linked' | 'lapsed' | 'awaiting-result' | 'unreachable'

interface PendingState {
  readonly status: CardHostStatus
  readonly entry: PendingEntry | null
}

const PACKAGE_ID = '@xinvxueyuan/cordis-plugin-secret'
const CARD_KIND = 'secret-request'
const TOOL_NAME = 'secret_request'
const PENDING_PATH = '/api/secret.pending'
const ANSWER_PATH = '/api/secret.answer'
/** Healthy poll cadence. */
const POLL_MS = 1200
/** Backoff ceiling after an unreachable poll. */
const POLL_MAX_MS = 8000

/**
 * The card is anchored to its `tool/call` event but deliberately carries no
 * Turn/Step coordinate (see the module header).
 */
const SESSION_LOCATION = Object.freeze({ kind: 'session' as const })

/** Every visible string of the card (this profile's UI language is Chinese). */
const TEXT = {
  glyph: '🔑',
  metaPreparing: '准备中…',
  metaRunning: '等待你的决定',
  metaConnecting: '连接宿主失败，重试中…',
  metaLapsed: '请求已结束',
  metaSubmitted: '已提交，等待 Agent 继续…',
  pillExpand: '展开',
  pillCollapse: '收起',
  reasonLabel: '用途',
  scopeLabel: '保存方式',
  persistent: '持久保存到凭据库',
  persistentHint: '写入本机凭据库，之后所有会话都可复用。',
  session: '仅本次会话有效',
  sessionHint: '只保存在本次会话内存中，会话结束即失效。',
  noticeLabel: '当前选择：',
  requestedBy: 'Agent 请求的范围：',
  overridden: '你已把范围改为：',
  valueLabel: '密钥内容',
  valuePlaceholder: '粘贴密钥…',
  configured: '该凭据已在凭据库中，本次无需重新输入，只需决定是否授权本次使用。',
  show: '显示',
  hide: '隐藏',
  approve: '同意',
  reject: '拒绝',
  ignore: '忽略',
  other: '其他',
  back: '返回',
  otherLabel: '你希望 Agent 怎么做？',
  otherPlaceholder: '用自由文本告诉 Agent 你的指示…',
  submitOther: '提交指示',
  busy: '提交中…',
  rejectHint: '拒绝：Agent 会停止，不会重试。',
  ignoreHint: '忽略：本次不授权，Agent 可稍后再问。',
  statusPreparing: '正在登记本次授权请求…（连接宿主后即可提交）',
  statusUnreachable: '暂时无法连接宿主，正在重试…表单已就绪，连接恢复后即可提交。',
  statusLapsed: '宿主已不再等待本次请求（可能已超时，或已在别处处理）。卡片会保留到这次调用结束。',
  statusSubmitted: '已提交，等待 Agent 继续…',
  statusConflict: '这份请求已由别处处理，此处不再重复提交。',
  footerLead: '密钥明文不会交给模型：代理只会拿到变量名',
  footerTail: '。',
  unreadable: '这次调用的参数无法解析；宿主登记后会自动补全表单。',
  readonlyNote: '调用已结束 · 仅供查看',
  unknownOutcome: '已结束（未记录结算细节）',
  outcomeApproved: '已授权',
  outcomeRejected: '已拒绝',
  outcomeIgnored: '已忽略',
  outcomeOther: '其他指示',
  outcomeError: '出错',
  scopeShort: { persistent: '持久保存', session: '仅本次会话' },
  metaSeparator: ' · ',
  failure: {
    TIMEOUT: '等待人工确认超时，本次未获授权。',
    AUTHORIZATION_FAILED: '凭据授权流程失败，本次未获授权。',
    AUTHORIZATION_CANCELLED: '授权尝试在人工答复前被取消。',
    ABORTED: '这次请求在人工答复前被取消。',
    DELEGATED_CALLER: '只有会话根代理能请求人工授权；本次调用不会被回答。',
    CALLER_NOT_LIVE: '调用者不是活跃的会话根代理；本次请求不会被回答。',
    NO_SESSION: '找不到可锚定的活跃会话；本次请求被拒绝。',
    NO_ANCHOR: '无法在会话日志中定位这次调用；本次请求被拒绝。',
    BAD_REQUEST: '请求参数不合法；本次请求被拒绝。',
    TOO_MANY_PENDING: '同时等待人工确认的请求已达上限。',
    STORE_EMPTY: '凭据库中已没有对应值，请重新授权。',
    NO_VALUE: '未获得任何值，本次授权已放弃。',
  } as Record<string, string>,
} as const

/** Class-name prefix. Distinct from every shipped prefix (`kPAopq_`, `dsh-`, …). */
const PREFIX = 'srd'

/** Class names, built from PREFIX so the stylesheet and the tree never drift apart. */
const C = {
  root: `${PREFIX}_root`,
  head: `${PREFIX}_head`,
  title: `${PREFIX}_title`,
  meta: `${PREFIX}_meta`,
  pill: `${PREFIX}_pill`,
  glyph: `${PREFIX}_glyph`,
  metaMuted: `${PREFIX}_metaMuted`,
  body: `${PREFIX}_body`,
  field: `${PREFIX}_field`,
  fieldLabel: `${PREFIX}_fieldLabel`,
  reason: `${PREFIX}_reason`,
  desc: `${PREFIX}_desc`,
  scope: `${PREFIX}_scope`,
  option: `${PREFIX}_option`,
  radio: `${PREFIX}_radio`,
  optionBody: `${PREFIX}_optionBody`,
  optionTitle: `${PREFIX}_optionTitle`,
  optionHint: `${PREFIX}_optionHint`,
  notice: `${PREFIX}_notice`,
  inputRow: `${PREFIX}_inputRow`,
  input: `${PREFIX}_input`,
  toggle: `${PREFIX}_toggle`,
  textarea: `${PREFIX}_textarea`,
  actions: `${PREFIX}_actions`,
  btn: `${PREFIX}_btn`,
  foot: `${PREFIX}_foot`,
  code: `${PREFIX}_code`,
  mock: `${PREFIX}_mock`,
  hint: `${PREFIX}_hint`,
}

/**
 * Card chrome, taken value for value from the accepted demo's stylesheet: theme
 * tokens only (light and dark both read correctly), a bordered card in normal
 * document flow — no `position: fixed`, no viewport-sized box, no backdrop, no
 * pointer-event hijack anywhere.
 */
const CARD_CSS = `
.${C.root}{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;flex-direction:column;gap:8px;width:100%;min-width:0;padding:10px 12px;display:flex}
.${C.head}{align-items:center;gap:8px;min-width:0;display:flex}
.${C.title}{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:0 auto;font-size:13px;font-weight:600;line-height:20px;overflow:hidden}
.${C.meta}{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;margin-left:auto;font-size:11px;line-height:16px}
.${C.pill}{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border-radius:999px;flex:none;padding:2px 8px;font-size:10.5px;font-weight:600;line-height:16px;transition:border-color .12s,color .12s}
.${C.pill}:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.${C.pill}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${C.glyph}{flex:none;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1}
.${C.metaMuted}{color:var(--dsw-alias-label-caption)}
.${C.body}{display:flex;flex-direction:column;gap:8px;min-width:0}
.${C.field}{display:flex;flex-direction:column;gap:6px;min-width:0}
.${C.fieldLabel}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}
.${C.reason}{margin:0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.${C.desc}{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;overflow-wrap:anywhere}
.${C.scope}{display:flex;flex-direction:column;gap:6px}
.${C.option}{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);transition:background-color .12s,border-color .12s,box-shadow .12s}
.${C.option}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${C.option}[data-on]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-state-business-primary)}
.${C.option}[data-disabled]{cursor:default}
.${C.option}[data-disabled]:hover{background:0 0}
.${C.radio}{flex:none;margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
.${C.optionBody}{display:flex;flex-direction:column;min-width:0}
.${C.optionTitle}{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.${C.optionHint}{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${C.notice}{margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.${C.notice} b{color:var(--dsw-alias-label-primary);font-weight:500}
.${C.inputRow}{display:flex;align-items:center;gap:8px}
.${C.input}{flex:auto;min-width:0;height:32px;padding:0 10px;font:inherit;font-size:13px;outline:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.${C.input}::placeholder{color:var(--dsw-alias-label-caption)}
.${C.input}:focus{border-color:var(--dsw-alias-state-business-primary)}
.${C.toggle}{flex:none;height:32px;padding:0 12px;cursor:pointer;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.${C.toggle}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${C.textarea}{width:100%;min-height:64px;resize:vertical;padding:8px 10px;font:inherit;font-size:13px;outline:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.${C.textarea}::placeholder{color:var(--dsw-alias-label-caption)}
.${C.textarea}:focus{border-color:var(--dsw-alias-state-business-primary)}
.${C.actions}{display:flex;flex-wrap:wrap;gap:8px}
.${C.btn}{height:32px;padding:0 14px;cursor:pointer;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);transition:background-color .12s,border-color .12s}
.${C.btn}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${C.btn}[data-kind=approve]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.${C.btn}[data-kind=approve]:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}
.${C.btn}[data-kind=reject]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.${C.btn}:disabled,.${C.toggle}:disabled,.${C.input}:disabled,.${C.textarea}:disabled{cursor:default;opacity:.55}
.${C.btn}:focus-visible,.${C.toggle}:focus-visible,.${C.textarea}:focus-visible,.${C.option}:focus-within{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${C.foot}{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.${C.code}{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.${C.mock}{flex:none;color:var(--dsw-alias-label-caption)}
.${C.hint}{margin:0 0 0 auto;flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
`

/** Stable id of the injected stylesheet, so a reload replaces it instead of stacking. */
const CSS_TAG_ID = `${PACKAGE_ID}/secret-card.css`

/** Inject (or refresh) the card stylesheet once per page. */
function ensureCardStyle(): void {
  if (typeof document === 'undefined') return
  let tag = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.setAttribute('data-plugin', PACKAGE_ID)
    tag.setAttribute('data-plugin-css', CSS_TAG_ID)
    document.head.appendChild(tag)
  }
  tag.textContent = CARD_CSS
}

/** Read one non-empty string field, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Read one of the two scopes, or undefined. */
function scopeOf(value: unknown): Scope | undefined {
  return value === 'persistent' ? 'persistent' : value === 'session' ? 'session' : undefined
}

/**
 * Derive the display variable name from the request's own fields.
 *
 * Mirrors `effectiveEnvVar` in the Host half (`DSH_SECRET_` + upper snake of the
 * key, unless the call overrode it). The Host's view is authoritative and
 * supersedes this as soon as it is known; a test pins both implementations to
 * the same table so they cannot drift apart in silence.
 */
function deriveVariable(name: string, envVar: string | undefined): string {
  const override = text(envVar)
  if (override !== undefined) return override
  return `DSH_SECRET_${name.replace(/[-_]+/gu, '_').toUpperCase()}`
}

/**
 * Read the request material out of one recorded `tool/call`.
 * @returns the request, or null when the arguments are unreadable.
 */
function parseCallRequest(argsRaw: unknown): CardRequest | null {
  if (typeof argsRaw !== 'string' || argsRaw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const name = text(raw.name)
  const label = text(raw.label)
  const reason = text(raw.reason)
  const scope = scopeOf(raw.scope)
  if (name === undefined || label === undefined || reason === undefined || scope === undefined) return null
  const description = text(raw.description)
  return {
    name,
    label,
    reason,
    ...(description === undefined ? {} : { description }),
    requestedScope: scope,
    variable: deriveVariable(name, text(raw.envVar)),
    alreadyConfigured: false,
  }
}

/** Read the tool's value-free settlement payload out of one `tool/result`. */
function readOutcome(meta: unknown): CardOutcome | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const raw = meta as Record<string, unknown>
  if (raw.kind !== 'secret-request') return null
  const decision = raw.decision
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'ignored' && decision !== 'other') return null
  const variable = text(raw.variable)
  const scope = scopeOf(raw.scope)
  const source = raw.source === 'store' ? 'store' : raw.source === 'entered' ? 'entered' : undefined
  const notice = text(raw.notice)
  const reason = text(raw.reason)
  const instruction = text(raw.text)
  return {
    decision,
    ...(variable === undefined ? {} : { variable }),
    ...(scope === undefined ? {} : { scope }),
    ...(source === undefined ? {} : { source }),
    ...(notice === undefined ? {} : { notice }),
    ...(reason === undefined ? {} : { reason }),
    ...(instruction === undefined ? {} : { text: instruction }),
  }
}

/** Read the durable failure identity of one settled tool result. */
function readFailure(event: unknown): CardFailure | null {
  if (typeof event !== 'object' || event === null) return null
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const record = data as { message?: unknown; error?: unknown }
  const message = record.message
  if (typeof message !== 'object' || message === null || (message as { isError?: unknown }).isError !== true) return null
  const error = record.error
  if (typeof error !== 'object' || error === null) return { name: 'Error', code: 'ERROR' }
  return {
    name: text((error as { name?: unknown }).name) ?? 'Error',
    code: text((error as { code?: unknown }).code) ?? 'ERROR',
    ...(text((error as { reason?: unknown }).reason) === undefined
      ? {}
      : { reason: text((error as { reason?: unknown }).reason) as string }),
  }
}

/** Read the request material the Host reports for one waiting interaction. */
function readEntry(raw: unknown): PendingEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = text(record.id)
  if (id === undefined) return null
  const callId = text(record.callId)
  const sessionId = text(record.sessionId)
  const name = text(record.name)
  const label = text(record.label)
  const reason = text(record.reason)
  const description = text(record.description)
  const requestedScope = scopeOf(record.requestedScope)
  const variable = text(record.variable)
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : undefined
  return {
    id,
    ...(callId === undefined ? {} : { callId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(name === undefined ? {} : { name }),
    ...(label === undefined ? {} : { label }),
    ...(reason === undefined ? {} : { reason }),
    ...(description === undefined ? {} : { description }),
    ...(requestedScope === undefined ? {} : { requestedScope }),
    ...(variable === undefined ? {} : { variable }),
    ...(record.alreadyConfigured === true ? { alreadyConfigured: true } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

/**
 * Read one poll response body. A body the card cannot understand is *not*
 * evidence that any request ended, so it maps to `null` (→ unreachable).
 */
function readEntries(payload: unknown): readonly PendingEntry[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const requests = (payload as { requests?: unknown }).requests
  if (!Array.isArray(requests)) return null
  const entries: PendingEntry[] = []
  for (const candidate of requests) {
    const entry = readEntry(candidate)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/** Find this card's own waiting request: the call id is the primary identity. */
function findEntry(
  entries: readonly PendingEntry[],
  key: { readonly callId: string; readonly sessionId?: string | undefined },
): PendingEntry | null {
  if (key.callId === '') return null
  for (const entry of entries) {
    if (entry.callId !== key.callId) continue
    if (key.sessionId !== undefined && entry.sessionId !== undefined && entry.sessionId !== key.sessionId) continue
    return entry
  }
  return null
}

/**
 * Version-skew compatibility: a Host that predates the card reports no call id,
 * so when exactly one request is waiting it can only be the one being asked.
 * With more than one, claiming any of them would be a guess — refuse.
 */
function uniqueLegacyEntry(entries: readonly PendingEntry[]): PendingEntry | null {
  if (entries.length !== 1) return null
  const only = entries[0]
  if (only === undefined || only.callId !== undefined) return null
  return only
}

/**
 * Decide this card's host state from one poll probe.
 *
 * The false-expiry rule lives here: only a *successful* poll that does not list
 * this call may settle anything, and never after this card already submitted —
 * an unreachable or unreadable poll keeps the form alive and says so.
 */
function nextPendingState(
  probe: PendingProbe | null,
  local: { readonly submitted: boolean },
  key: { readonly callId: string; readonly sessionId?: string | undefined },
): PendingState {
  // Nothing learned yet: still registering, never "ended".
  if (probe === null) return { status: local.submitted ? 'awaiting-result' : 'preparing', entry: null }
  if (probe.kind === 'unreachable') {
    return { status: local.submitted ? 'awaiting-result' : 'unreachable', entry: null }
  }
  const entry = findEntry(probe.entries, key)
  if (entry !== null) return { status: local.submitted ? 'awaiting-result' : 'linked', entry }
  if (key.callId === '') return { status: 'preparing', entry: null }
  const legacy = uniqueLegacyEntry(probe.entries)
  if (legacy !== null) return { status: local.submitted ? 'awaiting-result' : 'linked', entry: legacy }
  return { status: local.submitted ? 'awaiting-result' : 'lapsed', entry: null }
}

/** Merge the durable request material with the Host's authoritative view. */
function mergeRequest(request: CardRequest | null, entry: PendingEntry | null): CardRequest | null {
  if (entry === null) return request
  const name = entry.name ?? request?.name ?? ''
  const label = entry.label ?? request?.label ?? name
  const reason = entry.reason ?? request?.reason ?? ''
  const description = entry.description ?? request?.description
  const requestedScope = entry.requestedScope ?? request?.requestedScope ?? 'session'
  const variable = entry.variable ?? request?.variable ?? ''
  return {
    name,
    label,
    reason,
    ...(description === undefined ? {} : { description }),
    requestedScope,
    variable,
    alreadyConfigured: entry.alreadyConfigured === true || request?.alreadyConfigured === true,
  }
}

/** One shared poller: only mounted, unsettled cards keep it alive. */
const poller: {
  probe: PendingProbe | null
  at: number
  listeners: Set<() => void>
  refs: number
  timer: unknown
  delay: number
  inflight: boolean
} = {
  probe: null,
  at: 0,
  listeners: new Set(),
  refs: 0,
  timer: 0,
  delay: POLL_MS,
  inflight: false,
}

interface StoreSnapshot {
  readonly probe: PendingProbe | null
  readonly at: number
}

function snapshot(): StoreSnapshot {
  return { probe: poller.probe, at: poller.at }
}

function notify(): void {
  for (const listener of [...poller.listeners]) listener()
}

function schedule(delay: number): void {
  if (poller.refs === 0) return
  poller.timer = setTimeout(() => {
    void poll()
  }, delay)
}

function publish(probe: PendingProbe, delay: number): void {
  poller.probe = probe
  poller.at = Date.now()
  poller.delay = delay
  notify()
}

async function poll(): Promise<void> {
  if (poller.refs === 0 || poller.inflight) return
  poller.inflight = true
  try {
    const response = await fetch(PENDING_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      publish({ kind: 'unreachable' }, Math.min(poller.delay * 2, POLL_MAX_MS))
      return
    }
    const entries = readEntries(await response.json())
    if (entries === null) {
      publish({ kind: 'unreachable' }, Math.min(poller.delay * 2, POLL_MAX_MS))
      return
    }
    publish({ kind: 'ok', entries }, POLL_MS)
  } catch {
    publish({ kind: 'unreachable' }, Math.min(poller.delay * 2, POLL_MAX_MS))
  } finally {
    poller.inflight = false
    schedule(poller.delay)
  }
}

function acquire(): () => void {
  poller.refs += 1
  if (poller.refs === 1) {
    poller.delay = POLL_MS
    void poll()
  }
  return () => {
    poller.refs = Math.max(0, poller.refs - 1)
    if (poller.refs === 0 && poller.timer !== 0) {
      clearTimeout(poller.timer as ReturnType<typeof setTimeout>)
      poller.timer = 0
    }
  }
}

/** Narrow a rendered node's payload back to this card's durable state. */
function asCardData(value: unknown): CardData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const callId = text(raw.callId)
  if (callId === undefined) return null
  return {
    callId,
    request: raw.request === null || raw.request === undefined ? null : (raw.request as CardRequest),
    requestUnreadable: raw.requestUnreadable === true,
    settled: raw.settled === true,
    outcome: raw.outcome === null || raw.outcome === undefined ? null : (raw.outcome as CardOutcome),
    failure: raw.failure === null || raw.failure === undefined ? null : (raw.failure as CardFailure),
  }
}

/**
 * One `secret_request` call folded into its own durable state.
 *
 * The node materializes at `tool/call` — before any result exists — so the
 * interactive form is visible while the human is being asked, and it settles on
 * the durable `tool/result` record. `buildViewNode` never returns null once a
 * call matched, and never throws: an unreadable call still yields a card.
 */
const secretRequestDefinition = {
  kind: CARD_KIND,
  target: 'chat',
  match(event: { readonly type?: unknown; readonly data?: unknown }): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown } | undefined
      if (data?.name !== TOOL_NAME || data.callId === undefined) return null
      return { id: String(data.callId), role: 'start' }
    }
    if (event.type === 'tool/result') {
      const data = event.data as { message?: { source?: { kind?: unknown; callId?: unknown } } } | undefined
      const source = data?.message?.source
      if (source?.kind !== 'tool' || source.callId === undefined) return null
      return { id: String(source.callId), role: 'update' }
    }
    return null
  },
  start(_context: unknown, match: { readonly event: { readonly data?: unknown } }): CardData {
    const data = match.event.data as { callId?: unknown; arguments?: unknown } | undefined
    const request = parseCallRequest(data?.arguments)
    return {
      callId: data?.callId === undefined ? '' : String(data.callId),
      request,
      requestUnreadable: request === null,
      settled: false,
      outcome: null,
      failure: null,
    }
  },
  update(context: { readonly state: CardData }, match: { readonly event: unknown }): CardData {
    const event = match.event as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'tool/result') return context.state
    const data = event.data as { meta?: unknown } | undefined
    const outcome = readOutcome(data?.meta)
    return {
      ...context.state,
      settled: true,
      outcome,
      failure: outcome === null ? readFailure(event) : null,
    }
  },
  buildViewNode(context: {
    readonly key: string
    readonly id: string
    readonly state: CardData | undefined
    readonly start: { readonly event: { readonly seq?: unknown } } | undefined
  }): Record<string, unknown> | null {
    if (context.start === undefined) return null
    const seq = context.start.event.seq
    const data = context.state ?? {
      // Never let missing state hide the request: a minimal card is still a
      // visible, answerable surface once the Host's view arrives (fallbacks F1/F2).
      callId: context.id,
      request: null,
      requestUnreadable: true,
      settled: false,
      outcome: null,
      failure: null,
    }
    return {
      key: context.key,
      kind: CARD_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: typeof seq === 'number' ? seq : 0,
      location: SESSION_LOCATION,
      visibility: 'visible',
      data,
    }
  },
}

/** Replaces the generic Tool row for this tool: the card is the only surface. */
function HiddenSecretToolRow(): unknown {
  return null
}

/** One card for one `secret_request` call, drawn in the conversation flow. */
function SecretRequestCard(props: {
  readonly node?: { readonly data?: unknown }
  readonly sessionId?: unknown
}): unknown {
  const h = React.createElement
  const data = asCardData(props.node === undefined ? null : props.node.data)
  const sessionId = text(props.sessionId)
  const callId = data === null ? '' : data.callId
  const settled = data !== null && data.settled

  const [snap, setSnap] = React.useState<StoreSnapshot>(snapshot())
  React.useEffect(() => {
    if (settled) return undefined
    const listen = () => setSnap(snapshot())
    poller.listeners.add(listen)
    const release = acquire()
    return () => {
      poller.listeners.delete(listen)
      release()
    }
  }, [settled])

  const [value, setValue] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [scopeChoice, setScopeChoice] = React.useState<Scope | null>(null)
  const [mode, setMode] = React.useState<'decide' | 'other'>('decide')
  const [otherText, setOtherText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [touched, setTouched] = React.useState(false)

  const resolved = nextPendingState(snap.probe, { submitted }, { callId, sessionId })
  const entry = resolved.entry
  const phase = settled ? 'settled' : submitted ? 'awaiting-result' : resolved.status
  const request = mergeRequest(data === null ? null : data.request, entry)
  const requestedScope: Scope = request === null ? 'session' : request.requestedScope
  const scope: Scope = scopeChoice ?? requestedScope
  const persistent = scope === 'persistent'
  const scopeTitle = persistent ? TEXT.persistent : TEXT.session
  const scopeHint = persistent ? TEXT.persistentHint : TEXT.sessionHint
  const requestedTitle = requestedScope === 'persistent' ? TEXT.persistent : TEXT.session
  const overridden = !settled && scopeChoice !== null && scopeChoice !== requestedScope
  const answerable = !settled && resolved.status === 'linked' && entry !== null && !busy
  const open = settled ? (touched ? expanded : false) : true
  const outcome = data === null ? null : data.outcome
  const failure = data === null ? null : data.failure

  /** The header's right-hand summary. */
  const metaText = (() => {
    if (!settled) {
      if (phase === 'awaiting-result') return TEXT.metaSubmitted
      if (phase === 'unreachable') return TEXT.metaConnecting
      if (phase === 'lapsed') return TEXT.metaLapsed
      if (phase === 'preparing') return TEXT.metaPreparing
      return TEXT.metaRunning
    }
    if (failure !== null) return `${TEXT.outcomeError}${TEXT.metaSeparator}${failure.code}`
    if (outcome === null) return TEXT.unknownOutcome
    if (outcome.decision === 'approved') {
      const parts: string[] = [TEXT.outcomeApproved]
      if (outcome.variable !== undefined) parts.push(outcome.variable)
      if (outcome.scope !== undefined) parts.push(TEXT.scopeShort[outcome.scope])
      return parts.join(TEXT.metaSeparator)
    }
    if (outcome.decision === 'rejected') return TEXT.outcomeRejected
    if (outcome.decision === 'ignored') return TEXT.outcomeIgnored
    return TEXT.outcomeOther
  })()

  const metaMuted = !settled && (phase === 'preparing' || phase === 'unreachable' || phase === 'lapsed')
  const failureText = failure === null ? null : (TEXT.failure[failure.code] ?? `授权未完成（${failure.code}）。`)

  async function submit(decision: Decision): Promise<void> {
    if (busy || settled || entry === null) return
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = { id: entry.id, decision }
    if (decision === 'approved') {
      body.scope = scope
      if (request === null || !request.alreadyConfigured) body.value = value
    }
    if (decision === 'other') body.text = otherText
    try {
      const response = await fetch(ANSWER_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => undefined)) as
        | { ok?: boolean; error?: string }
        | undefined
      if (payload?.ok === true) {
        setValue('')
        setOtherText('')
        setSubmitted(true)
        return
      }
      if (response.status === 409) {
        // The Host is no longer waiting for this interaction (a timeout, a
        // reload, or an answer from another window). That is the Host closing
        // the request — not a polling failure — so the card stays, says so, and
        // waits for the tool result to settle it.
        setValue('')
        setOtherText('')
        setSubmitted(true)
        setError(TEXT.statusConflict)
        return
      }
      setError(payload?.error ?? `提交失败（HTTP ${String(response.status)}）`)
    } catch (failure$1) {
      setError(failure$1 instanceof Error ? failure$1.message : '提交失败')
    } finally {
      setBusy(false)
      // The value is never logged, echoed or retained after submission.
    }
  }

  /** One scope choice, with the notice that explains what it means. */
  function scopeOption(next: Scope, title: string, hint: string): unknown {
    const on = scope === next
    return h(
      'label',
      { key: next, className: C.option, 'data-on': on ? '' : undefined, 'data-disabled': settled ? '' : undefined },
      h('input', {
        className: C.radio,
        type: 'radio',
        name: `dsh-secret-scope-${callId}`,
        checked: on,
        disabled: settled || !answerable,
        onChange: () => setScopeChoice(next),
      }),
      h(
        'span',
        { className: C.optionBody },
        h('span', { className: C.optionTitle }, title),
        h('span', { className: C.optionHint }, hint),
      ),
    )
  }

  function decisionButton(id: Decision, label: string, kind?: string): unknown {
    const disabled = settled || !answerable || (id === 'approved' && showValueField && value.length === 0)
    return h(
      'button',
      {
        key: id,
        type: 'button',
        className: C.btn,
        'data-kind': kind,
        disabled,
        title: id === 'rejected' ? TEXT.rejectHint : id === 'ignored' ? TEXT.ignoreHint : undefined,
        onClick: () => void submit(id),
      },
      label,
    )
  }

  const statusLine = (() => {
    if (settled) return null
    if (phase === 'preparing') return TEXT.statusPreparing
    if (phase === 'unreachable') return TEXT.statusUnreachable
    if (phase === 'lapsed') return TEXT.statusLapsed
    if (phase === 'awaiting-result') return TEXT.statusSubmitted
    return null
  })()

  const showValueField = !settled && request !== null && !request.alreadyConfigured
  const settledScope = outcome?.scope ?? requestedScope
  const bodyChildren: unknown[] = []

  bodyChildren.push(
    h(
      'div',
      { key: 'reason', className: C.field },
      h('span', { className: C.fieldLabel }, TEXT.reasonLabel),
      h('p', { className: C.reason }, request === null ? TEXT.unreadable : request.reason),
    ),
  )
  if (request !== null && request.description !== undefined) {
    bodyChildren.push(h('p', { key: 'description', className: C.desc }, request.description))
  }

  bodyChildren.push(
    h(
      'div',
      { key: 'scope', className: C.field },
      h('span', { className: C.fieldLabel }, TEXT.scopeLabel),
      settled
        ? h(
            'p',
            { className: C.notice },
            TEXT.noticeLabel,
            h('b', null, settledScope === 'persistent' ? TEXT.persistent : TEXT.session),
            ' — ',
            settledScope === 'persistent' ? TEXT.persistentHint : TEXT.sessionHint,
          )
        : h(
            'div',
            { className: C.scope, role: 'radiogroup', 'aria-label': TEXT.scopeLabel },
            scopeOption('persistent', TEXT.persistent, TEXT.persistentHint),
            scopeOption('session', TEXT.session, TEXT.sessionHint),
          ),
      settled
        ? null
        : h('p', { className: C.notice }, `${TEXT.requestedBy}${requestedTitle}`),
      overridden ? h('p', { className: C.notice }, h('b', null, `${TEXT.overridden}${scopeTitle}`)) : null,
      settled
        ? null
        : h('p', { className: C.notice }, TEXT.noticeLabel, h('b', null, scopeTitle), ' — ', scopeHint),
    ),
  )

  if (!settled && request !== null && request.alreadyConfigured) {
    bodyChildren.push(h('p', { key: 'configured', className: C.notice }, TEXT.configured))
  }
  if (showValueField) {
    const valueId = `dsh-secret-value-${callId}`
    bodyChildren.push(
      h(
        'div',
        { key: 'value', className: C.field },
        h('label', { className: C.fieldLabel, htmlFor: valueId }, TEXT.valueLabel),
        h(
          'div',
          { className: C.inputRow },
          h('input', {
            id: valueId,
            className: C.input,
            type: reveal ? 'text' : 'password',
            value,
            placeholder: TEXT.valuePlaceholder,
            autoComplete: 'off',
            spellCheck: false,
            disabled: !answerable,
            'aria-label': TEXT.valueLabel,
            onChange: (event: { target: { value: string } }) => setValue(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: C.toggle,
              'aria-pressed': reveal,
              disabled: !answerable,
              onClick: () => setReveal(!reveal),
            },
            reveal ? TEXT.hide : TEXT.show,
          ),
        ),
      ),
    )
  }

  if (!settled) {
    if (mode === 'other') {
      bodyChildren.push(
        h(
          'div',
          { key: 'other', className: C.field },
          h('label', { className: C.fieldLabel, htmlFor: `dsh-secret-other-${callId}` }, TEXT.otherLabel),
          h('textarea', {
            id: `dsh-secret-other-${callId}`,
            className: C.textarea,
            value: otherText,
            placeholder: TEXT.otherPlaceholder,
            disabled: !answerable,
            onChange: (event: { target: { value: string } }) => setOtherText(event.target.value),
          }),
          h(
            'div',
            { className: C.actions },
            h(
              'button',
              {
                type: 'button',
                className: C.btn,
                'data-kind': 'approve',
                disabled: !answerable || otherText.trim().length === 0,
                onClick: () => void submit('other'),
              },
              TEXT.submitOther,
            ),
            h(
              'button',
              { type: 'button', className: C.btn, disabled: busy, onClick: () => setMode('decide') },
              TEXT.back,
            ),
          ),
        ),
      )
    } else {
      bodyChildren.push(
        h(
          'div',
          { key: 'actions', className: C.actions },
          decisionButton('approved', TEXT.approve, 'approve'),
          decisionButton('rejected', TEXT.reject, 'reject'),
          decisionButton('ignored', TEXT.ignore),
          h(
            'button',
            {
              key: 'other',
              type: 'button',
              className: C.btn,
              disabled: settled || !answerable,
              onClick: () => setMode('other'),
            },
            TEXT.other,
          ),
        ),
      )
    }
  } else if (outcome?.decision === 'other' && outcome.text !== undefined) {
    bodyChildren.push(h('p', { key: 'instruction', className: C.desc }, outcome.text))
  } else if (outcome?.decision === 'rejected' && outcome.reason !== undefined) {
    bodyChildren.push(h('p', { key: 'reasonText', className: C.desc }, outcome.reason))
  }

  if (statusLine !== null) bodyChildren.push(h('p', { key: 'status', className: C.notice }, statusLine))
  if (failureText !== null) bodyChildren.push(h('p', { key: 'failure', className: C.notice }, failureText))
  if (outcome?.notice !== undefined) {
    bodyChildren.push(h('p', { key: 'outcomeNotice', className: C.notice }, outcome.notice))
  }
  if (error !== null) bodyChildren.push(h('p', { key: 'error', className: C.notice, role: 'alert' }, error))
  if (busy) bodyChildren.push(h('p', { key: 'busy', className: C.notice }, TEXT.busy))

  bodyChildren.push(
    h(
      'p',
      { key: 'foot', className: C.foot },
      h('span', null, `${TEXT.footerLead} `),
      h('code', { className: C.code }, request === null || request.variable === '' ? '—' : request.variable),
      h('span', null, TEXT.footerTail),
      settled ? h('span', { className: C.mock }, TEXT.readonlyNote) : null,
      settled ? null : h('span', { className: C.hint }, scope === 'persistent' ? TEXT.scopeShort.persistent : TEXT.scopeShort.session),
    ),
  )

  return h(
    'section',
    {
      className: C.root,
      'data-secret-card': 'true',
      'data-tool': TOOL_NAME,
      'data-call-id': callId,
      'data-phase': phase,
      'data-host-status': settled ? 'settled' : resolved.status,
    },
    h(
      'header',
      { className: C.head },
      h('span', { className: C.glyph, 'aria-hidden': true }, TEXT.glyph),
      h(
        'span',
        { className: C.title, title: request === null ? TOOL_NAME : request.label },
        request === null ? TOOL_NAME : request.label,
      ),
      h('span', { className: metaMuted ? `${C.meta} ${C.metaMuted}` : C.meta }, metaText),
      h(
        'button',
        {
          type: 'button',
          className: C.pill,
          'aria-expanded': open,
          'data-action': open ? 'collapse' : 'expand',
          title: open ? TEXT.pillCollapse : TEXT.pillExpand,
          onClick: () => {
            setTouched(true)
            setExpanded(!open)
          },
        },
        open ? TEXT.pillCollapse : TEXT.pillExpand,
      ),
    ),
    open ? h('div', { className: C.body }, bodyChildren) : null,
  )
}

// ---------------------------------------------------------------------------
// The reverse direction: a secret the human attaches to their own message.
//
// The value lives in exactly two places here: the capsule's masked input state,
// and the body of one POST to this plugin's own route. It is never rendered,
// never written to an attribute, never put in the draft, and never logged.
// ---------------------------------------------------------------------------

/** Where the entry button sits: immediately right of the composer's mode group. */
const ATTACH_SLOT = 'conversation.input.left'
/** Where the capsule floats: above the composer card, the `@` menu's own seat. */
const CAPSULE_SLOT = 'conversation.input.overlay'
/** Locale namespace of the attach surface, when the runtime has a locale face. */
const ATTACH_NS = 'secretAttach'
const ATTACH_PATH = '/api/secret.attach'
const RELEASE_PATH = '/api/secret.release'
const ATTACHED_PATH = '/api/secret.attached'
/** Read-only history of this session's attachments and authorizations. */
const HISTORY_PATH = '/api/secret.history'
/** Every secret this session may use, plus what the credential store holds. */
const AVAILABLE_PATH = '/api/secret.available'
/** Register one durably stored secret for this session (the `@` menu's pick). */
const ADOPT_PATH = '/api/secret.adopt'
/**
 * Chat node kind of the attached-secret row (requirement 1 / O2).
 *
 * The engine keys one node as `${kind.length}:${kind}${id}`
 * (`dsh-client-ui-conversation/lib/client.js:1122-1124`) and orders the nodes
 * that share an anchor by `anchor`, `rank`, `originalAnchor`, then
 * `key.localeCompare` (`dsh-client-ui-chat/lib/client.js:8279`). The row is a
 * `{kind:'session'}` node, so its `presentationPosition` is the neutral
 * `{anchor: anchorSeq, rank: 0}` (`:8234-8238`) — the same triple the human
 * bubble gets — and the key comparison is what decides the pair.
 *
 * The bubble's key is NOT `4:user…`: the key is built from the *definition*
 * kind, and the human message definition registers as `input-message` — 13
 * characters (`dsh-client-ui-chat/lib/client.js:9264`) — so the competitor is
 * `13:input-message<id>`. A row lands after the bubble exactly when its own
 * prefix compares greater than `13:` in this page's default collation:
 *
 * - `5:`…`9:` (kind length 5–9) starts with a digit above `1` ⇒ after. ✓
 * - `10:`…`19:` ties on the leading `1` and then compares its own second digit
 *   against `3`, so `14:`…`19:` sort after while `10:`…`13:` sort before ⇒ a
 *   two-digit kind is a coin toss on its own length.
 *
 * `sr-chip` is 7 characters long (`7:`), which is after both the real competitor
 * `13:input-message…` and the `4:user…` spelling the earlier design compared
 * against — so the row is after the bubble under either reading. The comparison
 * is pinned by a test that runs it, not by this comment.
 */
const CHIP_KIND = 'sr-chip'
/**
 * Right-column viewer registered by requirement 1 (O1).
 *
 * The id is the implementation identity; `sidebar.right.pane.tab` dispatches the
 * type in force by this id, and the registry keys the claim by it. The pattern
 * is deliberately longer than the installed `dsh-better-sidebar`'s same-band
 * `dsh-resource://file/**`: same band means the longer matched pattern wins.
 */
const DETAIL_TAB_ID = `${PACKAGE_ID}/secret-attach-detail`
const DETAIL_TAB_KIND = 'secret-attach-detail'
/** The chrome address one capsule click resolves to: a file address ending in the variable. */
const DETAIL_TAB_PATTERN = 'dsh-resource://file/**/DSH_SECRET_*'
/** How long a marker may be absent from the draft before its staged record is withdrawn. */
const WITHDRAW_DEBOUNCE_MS = 600
/** Reference source name this plugin registers. It is also the chip's DOM anchor. */
const SECRET_SOURCE = 'secret'
/** Credential-key shape, mirrored from the Host so the form refuses early. */
const ATTACH_KEY_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u
/**
 * Marker matcher, kept identical to the Host's (`MARKER_RE`): a variable name at
 * a line start or after whitespace. A test drives the same table through both.
 */
const MARKER_RE = /(^|\s)@(DSH_SECRET_[A-Z][A-Z0-9_]*)/gu

/** The dictionary of the attach surface. The zh table is also the fallback. */
const ATTACH_ZH: Record<string, string> = {
  toggle: '附密钥',
  toggleOpen: '收起附密钥',
  toggleHint: '把一枚密钥附加到这条消息：明文不进入对话，Agent 只会拿到变量名',
  fillTitle: '附加一枚密钥',
  detailTitle: '随这条消息附加的密钥',
  keyLabel: '凭据键',
  keyPlaceholder: 'openai',
  keyHint: '小写 kebab/snake，例如 openai、openai-key；决定变量名 DSH_SECRET_*',
  labelLabel: '标题',
  labelPlaceholder: 'OpenAI API Key（可选）',
  valueLabel: '密钥内容',
  valuePlaceholder: '粘贴密钥…',
  show: '显示',
  hide: '隐藏',
  scopeLabel: '保存方式',
  persistent: '持久保存到凭据库',
  persistentHint: '写入本机凭据库，之后所有会话都可复用。',
  session: '仅本次会话有效',
  sessionHint: '只保存在本次会话内存中，会话结束即失效。',
  current: '当前选择：',
  variableLabel: '变量名',
  stateLabel: '状态',
  stateStaged: '已登记，等待发送',
  stateBound: '已绑定到这条消息',
  statusUnknown: '状态未知（无法连接宿主）',
  stagedNote: '未发送前不会注入任何变量；发送后该变量在本会话的后续 shell 中可用。',
  boundNote: '已绑定到这条消息：回退该消息即失效。',
  insert: '插入到光标处',
  cancel: '取消',
  close: '关闭',
  discard: '丢弃',
  busy: '正在登记…',
  insertedChip: '已在光标处插入胶囊',
  insertedText: '宿主未提供真 chip，已插入可点击的引用文本',
  manualLead: '请在草稿中手动输入 ',
  footerLead: '明文不会交给模型：这条消息只会带上变量名',
  footerTail: '。',
  badKey: '凭据键必须是小写 kebab/snake，例如 openai。',
  noValue: '请先填入密钥内容。',
  historyLink: '历史记录',
  historyTitle: '本会话的附加与授权记录',
  historyEmpty: '本进程内暂无记录。',
  historyReading: '正在读取本会话的记录…',
  historyEmptyForVariable: '该变量在本进程内没有记录。',
  historyUnavailable: '历史暂不可用',
  historyNotice: '历史只在本进程内存中保留：刷新页面仍在，宿主重启或插件重载后清空，重放或分叉的会话不会重建它。',
  historyAll: '查看全部',
  historySection: '历史记录',
  historyForVariable: '该变量的历史',
  evStaged: '已登记',
  evBound: '已绑定到消息',
  evDiscarded: '已丢弃',
  evWithdrawn: '已随草稿移除撤销',
  evRevoked: '已随消息回退失效',
  evExpired: '已过期',
  evAuthorized: '经授权生效',
  evUnknown: '未知状态',
  histReplaced: '取代了同变量的上一条',
  historyNoTime: '时间未知',
  anchorLabel: '锚点',
  sourceAttach: '附加',
  sourceRequest: '索要',
  withdrawNote: '从草稿里删掉标记约半秒后，这条暂存记录会被撤销：变量立即不可用，且会话级的值无法找回。',
  withdrawUnavailable: '宿主未提供草稿观测能力，自动撤销不可用（可手动丢弃或等 TTL 过期）。',
  withdrawnNote: '该记录已随草稿里的标记移除而撤销；重新附加需要重新填值。',
  revokedNote: '该记录所锚定的消息已不在当前会话表面上（回退/重写或会话分叉），因此失效。',
  expiredNote: '这条暂存记录已到 TTL，未发送即被丢弃。',
  chipRowLabel: '本条消息附带的密钥',
  chipOpenHint: '查看该密钥的详情',
  detailTabTitle: '密钥详情',
  detailTabMissing: '这个地址不是本插件登记的变量名。',
  detailTabHint: '来自转录里原始胶囊的打开请求；详情与输入框上方的胶囊同源。',
  storeFallback: '本会话 · 状态未知',
  confirmTitle: '把凭据库里的这份持久凭据用于本会话？',
  confirmLead: '将登记 ',
  confirmTail: ' 到本会话（持久作用域），成功后插入引用标记；值由宿主自己从凭据库读取，不经过对话。',
  confirmAction: '登记并插入',
  confirmCancel: '取消',
  confirmFailed: '这次登记失败，未插入任何标记。',
  confirmUnreachable: '暂时无法连接宿主，未登记，也未插入标记。',
  adopt404: '凭据库里已经没有这个变量的持久记录，未登记。',
  adopt409: '本会话登记的附加密钥已达上限，未登记。',
  adopt500: '凭据库读取失败，未登记。',
  sectionSession: '本会话可用',
  sectionStore: '凭据库（持久）',
  sourceLabel: '来源',
  descSessionStaged: '本会话 · 仅本次会话有效 · 已登记，等待发送',
  descSessionBound: '本会话 · 仅本次会话有效 · 已绑定到消息',
  descSessionStagedPersistent: '本会话 · 持久保存到凭据库 · 已登记，等待发送',
  descSessionBoundPersistent: '本会话 · 持久保存到凭据库 · 已绑定到消息',
  descStore: '凭据库 · 持久保存到凭据库 · 尚未用于本会话',
}
const ATTACH_EN: Record<string, string> = {
  toggle: 'Attach secret',
  toggleOpen: 'Close attach panel',
  toggleHint: 'Attach a secret to this message: the value stays out of the conversation and the agent only receives the variable name',
  fillTitle: 'Attach a secret',
  detailTitle: 'Secret attached to this message',
  keyLabel: 'Credential key',
  keyPlaceholder: 'openai',
  keyHint: 'Lowercase kebab/snake, e.g. openai or openai-key; decides the DSH_SECRET_* variable name',
  labelLabel: 'Title',
  labelPlaceholder: 'OpenAI API Key (optional)',
  valueLabel: 'Secret value',
  valuePlaceholder: 'Paste the secret…',
  show: 'Show',
  hide: 'Hide',
  scopeLabel: 'Storage',
  persistent: 'Save to the credential store',
  persistentHint: 'Written to this machine’s credential store and reusable in later sessions.',
  session: 'This session only',
  sessionHint: 'Held in this session’s memory only; it expires when the session ends.',
  current: 'Selected: ',
  variableLabel: 'Variable',
  stateLabel: 'State',
  stateStaged: 'Registered, waiting to be sent',
  stateBound: 'Bound to this message',
  statusUnknown: 'State unknown (the host is unreachable)',
  stagedNote: 'Nothing is injected until you send it; afterwards the variable is available to this session’s shells.',
  boundNote: 'Bound to this message: rewinding the message revokes it.',
  insert: 'Insert at the caret',
  cancel: 'Cancel',
  close: 'Close',
  discard: 'Discard',
  busy: 'Registering…',
  insertedChip: 'Inserted the capsule at the caret',
  insertedText: 'The host offers no real chip, so a clickable reference token was inserted',
  manualLead: 'Type this into the draft yourself: ',
  footerLead: 'The value never reaches the model: this message carries the variable name only',
  footerTail: '.',
  badKey: 'The credential key must be lowercase kebab/snake, e.g. openai.',
  noValue: 'Enter the secret value first.',
  historyLink: 'History',
  historyTitle: 'Attachments and authorizations of this session',
  historyEmpty: 'Nothing recorded in this process yet.',
  historyReading: 'Reading this session’s records…',
  historyEmptyForVariable: 'This process has no record of that variable.',
  historyUnavailable: 'History is unavailable right now',
  historyNotice: 'The history lives in this process’s memory only: it survives a page reload, is emptied by a Host restart or plugin reload, and is never rebuilt for a replayed or forked session.',
  historyAll: 'Show all',
  historySection: 'History',
  historyForVariable: 'History of this variable',
  evStaged: 'Registered',
  evBound: 'Bound to a message',
  evDiscarded: 'Discarded',
  evWithdrawn: 'Withdrawn with the draft marker',
  evRevoked: 'Invalidated with its message',
  evExpired: 'Expired',
  evAuthorized: 'Authorized',
  evUnknown: 'Unknown state',
  histReplaced: 'replaced an earlier entry for the same variable',
  historyNoTime: 'time unknown',
  anchorLabel: 'Anchor',
  sourceAttach: 'attached',
  sourceRequest: 'asked',
  withdrawNote: 'About half a second after the marker leaves the draft, this staged record is withdrawn: the variable stops being usable and a session-scoped value cannot be recovered.',
  withdrawUnavailable: 'The host offers no draft observation here, so automatic withdrawal is unavailable (discard manually or wait for the TTL).',
  withdrawnNote: 'This record was withdrawn when its marker left the draft; attaching again means entering the value again.',
  revokedNote: 'The message this record was anchored to is no longer on the live session surface (rewind, rewrite or fork), so it is invalid.',
  expiredNote: 'This staged record reached its TTL and was dropped before it was ever sent.',
  chipRowLabel: 'Secrets attached to this message',
  chipOpenHint: 'Open the details of this secret',
  detailTabTitle: 'Secret details',
  detailTabMissing: 'This address is not a variable name this plugin registered.',
  detailTabHint: 'Opened from a capsule in the transcript; the details are the same ones the capsule above the composer shows.',
  storeFallback: 'This session · state unknown',
  confirmTitle: 'Use this durable credential for this session?',
  confirmLead: 'Register ',
  confirmTail: ' for this session (persistent scope) and insert the reference marker; the Host reads the value from the credential store itself, and it never crosses the conversation.',
  confirmAction: 'Register and insert',
  confirmCancel: 'Cancel',
  confirmFailed: 'Registration failed; nothing was inserted.',
  confirmUnreachable: 'The host is unreachable; nothing was registered and nothing was inserted.',
  adopt404: 'The credential store no longer holds a durable record for this variable; nothing was registered.',
  adopt409: 'This session has reached its attachment limit; nothing was registered.',
  adopt500: 'The credential store could not be read; nothing was registered.',
  sectionSession: 'Usable in this session',
  sectionStore: 'Credential store (durable)',
  sourceLabel: 'Source',
  descSessionStaged: 'This session · this session only · registered, waiting to be sent',
  descSessionBound: 'This session · this session only · bound to a message',
  descSessionStagedPersistent: 'This session · durable in the credential store · registered, waiting to be sent',
  descSessionBoundPersistent: 'This session · durable in the credential store · bound to a message',
  descStore: 'Credential store · durable in the credential store · not used in this session yet',
}

/**
 * One fixed sentence per refusal. The host's own error text is never echoed —
 * not because it is untrusted, but because a credential backend's text can quote
 * the value it was handed, and one rule with no exceptions is easier to keep.
 */
const ATTACH_FAILURE: Record<number, string> = {
  400: '这次附加的字段不合法，未登记。',
  404: '找不到该会话，未登记。',
  409: '本会话登记的附加密钥已达上限，未登记。',
  500: '凭据库写入失败，未登记。',
}
const ATTACH_FAILURE_UNKNOWN = '宿主拒绝了这次附加，未登记。'
const ATTACH_UNREACHABLE = '暂时无法连接宿主，未登记。'

/** Class-name prefix of the attach surface, distinct from the card's. */
const AP = 'sra'
const A = {
  btn: `${AP}_btn`,
  btnOn: `${AP}_btnOn`,
  badge: `${AP}_badge`,
  glyph: `${AP}_glyph`,
  box: `${AP}_box`,
  head: `${AP}_head`,
  title: `${AP}_title`,
  close: `${AP}_close`,
  body: `${AP}_body`,
  field: `${AP}_field`,
  label: `${AP}_label`,
  input: `${AP}_input`,
  inputRow: `${AP}_inputRow`,
  toggle: `${AP}_toggle`,
  scope: `${AP}_scope`,
  option: `${AP}_option`,
  radio: `${AP}_radio`,
  optionBody: `${AP}_optionBody`,
  optionTitle: `${AP}_optionTitle`,
  optionHint: `${AP}_optionHint`,
  notice: `${AP}_notice`,
  actions: `${AP}_actions`,
  action: `${AP}_action`,
  foot: `${AP}_foot`,
  code: `${AP}_code`,
  detail: `${AP}_detail`,
  row: `${AP}_row`,
  rowLabel: `${AP}_rowLabel`,
  rowValue: `${AP}_rowValue`,
  link: `${AP}_link`,
  chipRow: `${AP}_chipRow`,
  chipPill: `${AP}_chipPill`,
  histList: `${AP}_histList`,
  histItem: `${AP}_histItem`,
  histEvent: `${AP}_histEvent`,
  histMeta: `${AP}_histMeta`,
  sectionTitle: `${AP}_sectionTitle`,
  confirm: `${AP}_confirm`,
  tabBody: `${AP}_tabBody`,
}

const ATTACH_CSS = `
.${A.btn}{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border-radius:999px;align-items:center;gap:5px;height:28px;padding:0 10px;font-size:12px;line-height:16px;display:inline-flex}
.${A.btn}:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.${A.btn}[aria-pressed=true]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.${A.btn}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${A.glyph}{font-size:12px;line-height:1}
.${A.badge}{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);border-radius:999px;min-width:16px;padding:0 5px;font-size:10px;line-height:16px;text-align:center}
.${A.box}{box-sizing:border-box;box-shadow:var(--dsw-elevation-prominent);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,12px);flex-direction:column;gap:10px;padding:12px;display:flex;position:absolute;bottom:calc(100% + 4px);left:0;right:0;z-index:100}
.${A.head}{align-items:center;gap:8px;display:flex}
.${A.title}{color:var(--dsw-alias-label-primary);flex:auto;font-size:13px;font-weight:600;line-height:20px}
.${A.close}{background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:20px;padding:1px 8px}
.${A.close}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${A.body}{flex-direction:column;gap:8px;display:flex;min-width:0}
.${A.field}{flex-direction:column;gap:6px;display:flex;min-width:0}
.${A.label}{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.${A.inputRow}{align-items:center;gap:8px;display:flex}
.${A.input}{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);flex:auto;font:inherit;font-size:13px;height:32px;min-width:0;outline:none;padding:0 10px}
.${A.input}::placeholder{color:var(--dsw-alias-label-caption)}
.${A.input}:focus{border-color:var(--dsw-alias-state-business-primary)}
.${A.toggle}{background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;font:inherit;font-size:13px;height:32px;padding:0 12px}
.${A.toggle}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${A.scope}{flex-direction:column;gap:6px;display:flex}
.${A.option}{align-items:flex-start;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);cursor:pointer;gap:8px;padding:8px 10px;display:flex;transition:background-color .12s,border-color .12s}
.${A.option}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${A.option}[data-on]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-state-business-primary)}
.${A.radio}{accent-color:var(--dsw-alias-state-business-primary);flex:none;margin:3px 0 0}
.${A.optionBody}{flex-direction:column;display:flex;min-width:0}
.${A.optionTitle}{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.${A.optionHint}{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.${A.notice}{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;overflow-wrap:anywhere;padding:6px 10px}
.${A.notice}[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.${A.actions}{flex-wrap:wrap;gap:8px;display:flex}
.${A.action}{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;height:32px;padding:0 14px}
.${A.action}:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${A.action}[data-kind=primary]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.${A.action}:disabled,.${A.input}:disabled,.${A.toggle}:disabled{cursor:default;opacity:.55}
.${A.row}{align-items:baseline;gap:8px;display:flex;min-width:0}
.${A.rowLabel}{color:var(--dsw-alias-label-caption);flex:none;font-size:12px;line-height:18px;min-width:56px}
.${A.rowValue}{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;overflow-wrap:anywhere}
.${A.code}{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;padding:1px 6px}
.${A.detail}{flex-direction:column;gap:6px;display:flex}
.${A.foot}{border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;padding-top:10px}
.${A.link}{background:0 0;border:0;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:0;text-align:left}
.${A.link}:hover{text-decoration:underline}
.${A.chipRow}{align-items:center;flex-wrap:wrap;gap:6px;margin:2px 0 0 2px;display:flex}
.${A.chipPill}{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:18px;padding:1px 8px}
.${A.chipPill}:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.${A.chipPill}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.${A.histList}{flex-direction:column;gap:6px;display:flex;margin:0;padding:0;list-style:none;max-height:220px;overflow-y:auto}
.${A.histItem}{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);flex-direction:column;gap:2px;padding:6px 10px;display:flex}
.${A.histEvent}{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.${A.histMeta}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.${A.sectionTitle}{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;margin:0}
.${A.confirm}{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;overflow-wrap:anywhere}
.${A.tabBody}{flex-direction:column;gap:8px;padding:12px;display:flex;min-width:0}
`

const ATTACH_CSS_TAG_ID = `${PACKAGE_ID}/secret-attach.css`

/** Inject (or refresh) the attach surface's stylesheet once per page. */
function ensureAttachStyle(): void {
  if (typeof document === 'undefined') return
  let tag = document.querySelector(`style[data-plugin-css="${ATTACH_CSS_TAG_ID}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.setAttribute('data-plugin', PACKAGE_ID)
    tag.setAttribute('data-plugin-css', ATTACH_CSS_TAG_ID)
    document.head.appendChild(tag)
  }
  tag.textContent = ATTACH_CSS
}

/** The session scope's one bailing event seat, as this half uses it. */
interface SessionScopeLike {
  bail?(subject: unknown, name: string, payload: unknown): unknown
}
/**
 * The attach surface's services that a web client may or may not have.
 *
 * None of them is a hard dependency: no locale face, no trigger registry and no
 * session controller must still leave the card, the entry button and the text
 * fallback working. They are therefore reached only inside a `ctx.inject([...])`
 * callback, never read off the context directly (see `ClientContextLike`).
 */
interface OptionalServicesLike {
  readonly locale?: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown }
  readonly inputTriggers?: { registerSource?: (source: unknown) => unknown }
  readonly sessions?: { scope(id: string): SessionScopeLike | undefined }
  /**
   * The right column's tab-type registry, when this client has one.
   *
   * `register` returns the disposer that takes the type out again; the registry
   * itself owns that registration in *its* context, so this half keeps the
   * disposer and releases it with its own optional dependency.
   */
  readonly sidebarRightTabs?: { register(definition: unknown): () => void }
  /** The scoped context's effect seat, so a capture is released with its service. */
  effect?(execute: () => () => void): unknown
}
/** The `sessions` scope reader, bound only while that optional service exists. */
let sessionsScope: ((sessionId: string) => SessionScopeLike | undefined) | null = null

/** One token span captured from the composer editor. */
interface TokenSpanLike {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}
/** The public session input action face, as this half uses it. */
interface InputActionsLike {
  captureInsertion?(): TokenSpanLike
  insertText?(text: string, span: TokenSpanLike): boolean
}
/** The editor's reference insertion, as the frozen contract spells it. */
interface ReferenceInsertLike {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: string
  readonly clipboardText: string
}
/** Lifecycle of one attached secret, as this half tracks it. */
type AttachState = 'staged' | 'bound' | 'withdrawn'
/** Everything the capsule shows about one attached secret. Never a value. */
interface AttachedMeta {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: Scope
  readonly state: AttachState
  readonly createdAt: number
  /**
   * Bumped on every successful attach/adopt of this variable.
   *
   * A withdrawal timer captures the generation it was armed for; a change means
   * the record it was about is gone and a new one is in its place, so the timer
   * must never take the new record down with the old one.
   */
  readonly generation: number
  /**
   * Whether this variable's marker has ever been seen in the draft.
   *
   * The marker may leave the draft for a reason that is not removal (a reload
   * rebuilds the draft as text, a submission clears it), so "absent now" only
   * means anything once it has been present at least once.
   */
  readonly seenPresent: boolean
}
/** One entry of the session's attachment/authorization history. Never a value. */
interface HistoryEntry {
  /**
   * The instant the host recorded the transition, or absent when its payload did
   * not carry a readable one. Absent is rendered as "time unknown": inventing an
   * epoch for a malformed answer would be a fact nobody observed.
   */
  readonly at?: number
  readonly event: string
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: Scope
  readonly anchorSeq?: number
  readonly source: 'attach' | 'request'
  readonly replaced?: boolean
}
/**
 * The lifecycle transitions this half accepts from the host's history answer.
 *
 * Mirrors the Host's `SecretHistoryEvent` union in `src/types.ts`. This artifact
 * is a classic script with no imports, so the members are written out here, and
 * an event this list does not know is dropped rather than rendered as an
 * unknown label.
 */
const HISTORY_EVENTS: readonly string[] = [
  'staged',
  'bound',
  'discarded',
  'withdrawn',
  'revoked',
  'expired',
  'authorized',
]
/** One row the `@` menu may offer: this session's own, or one the store holds. */
interface AvailableEntry {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: Scope
  readonly state: 'staged' | 'bound' | 'stored'
  readonly source: 'session' | 'store'
}
/** One `@` menu row as this source hands it to the menu. */
interface CandidateLike {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly icon: string
  readonly section: string
  readonly value: string
}
/** The editor's draft machine, as the withdrawal observer reads it. */
interface InputStateLike {
  readonly draft?: unknown
  readonly phase?: unknown
}
/** One optimistic submission echo: the text that is about to be sent. */
interface PendingSubmissionLike {
  readonly text?: unknown
}
/** The session snapshot, as the withdrawal observer reads it. */
interface SessionSnapshotLike {
  readonly pendingSubmissions?: unknown
}
/** One standard selector-hook seat, as this half reads it. */
interface SeatHook {
  (selector: (state: never) => unknown): unknown
}
/**
 * A seat hook for a client that publishes none.
 *
 * It consumes exactly one hook, as the real seat does, so a registration that
 * somehow flipped between having the seat and not having it could never change
 * how many hooks this component calls. It selects nothing: the observer then
 * reports that it cannot watch the draft instead of guessing what left it.
 */
function useAbsentSeat(_selector: (state: never) => unknown): undefined {
  React.useState(0)
  return undefined
}
/** What one sidebar tab body can read about its own tab. */
interface TabInfoLike {
  readonly tab?: {
    readonly contentId?: unknown
    readonly navigation?: { readonly address?: unknown }
  }
}
/** Which face the capsule shows. `idle` renders nothing at all. */
type AttachMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'fill' }
  | { readonly kind: 'detail'; readonly variable: string }
  /**
   * The history face. Without a variable it lists the whole session's records,
   * which is the default the entry link opens; with one it lists that variable's
   * own records and offers "show all" to widen back.
   */
  | { readonly kind: 'history'; readonly variable?: string }
  | { readonly kind: 'confirm'; readonly variable: string; readonly name: string }

/** Attached secrets per session. Values are never stored here. */
const attachedBySession = new Map<string, Map<string, AttachedMeta>>()
/** The last history this page read per session, newest first. Never a value. */
const historyBySession = new Map<string, readonly HistoryEntry[]>()
/** Whether the last history read for a session failed (fixed wording, no retry storm). */
const historyUnavailable = new Set<string>()
/**
 * Armed withdrawal timers, keyed by session and variable.
 *
 * Only a timer that is still armed for the same generation may withdraw: the
 * check happens when it fires, against whatever the draft and the store say then.
 */
const withdrawTimers = new Map<string, { readonly generation: number; cancel: () => void }>()
/**
 * The latest values the withdrawal observer saw.
 *
 * A timer fires outside React, so it cannot re-read the hooks; it re-reads this
 * cache instead, which the observer refreshes on every render. The cache holds
 * the draft text, its phase, the pending submissions' text, and the session the
 * observer belongs to — never a secret value.
 */
const observed = { sessionId: '', draft: '', phase: 'plain', pendingText: '' }
const attachedListeners = new Set<() => void>()
let attachMode: AttachMode = { kind: 'idle' }
const modeListeners = new Set<() => void>()

/** The live mode, for components that subscribe instead of re-reading props. */
function currentMode(): AttachMode {
  return attachMode
}

/** Move the capsule between faces and wake every subscriber. */
function setAttachMode(next: AttachMode): void {
  attachMode = next
  for (const listener of [...modeListeners]) listener()
}

/** Subscribe to attachment changes. Returns the unsubscribe function. */
function subscribeAttached(listener: () => void): () => void {
  attachedListeners.add(listener)
  modeListeners.add(listener)
  return () => {
    attachedListeners.delete(listener)
    modeListeners.delete(listener)
  }
}

function publishAttached(): void {
  for (const listener of [...attachedListeners]) listener()
}

/** The attachment map of one session, created on demand. */
function sessionAttachments(sessionId: string): Map<string, AttachedMeta> {
  let map = attachedBySession.get(sessionId)
  if (map === undefined) {
    map = new Map()
    attachedBySession.set(sessionId, map)
  }
  return map
}

/** How many attachments this session holds (staged or bound; a withdrawn record is gone). */
function attachmentCount(sessionId: string): number {
  let count = 0
  for (const meta of attachedBySession.get(sessionId)?.values() ?? []) {
    if (meta.state !== 'withdrawn') count += 1
  }
  return count
}

/** The marker one attached secret travels as. Never a value. */
function markerOf(variable: string): string {
  return `@${variable}`
}

/** Every distinct attached-secret marker in one text, in first-seen order. */
function parseMarkers(text: string): readonly string[] {
  const found: string[] = []
  MARKER_RE.lastIndex = 0
  let match = MARKER_RE.exec(text)
  while (match !== null) {
    const variable = match[2]
    if (variable !== undefined && !found.includes(variable)) found.push(variable)
    match = MARKER_RE.exec(text)
  }
  return found
}

/** The text blocks of one message payload, in order. */
function messageTextBlocks(data: unknown): readonly string[] {
  if (typeof data !== 'object' || data === null) return []
  const record = data as { content?: unknown; message?: unknown }
  // Defensive about the wrapping, exactly as the Host half is: an event payload
  // that nested its message one level down must not hide a marker.
  const nested = record.message
  const blocks = Array.isArray(record.content)
    ? record.content
    : typeof nested === 'object' && nested !== null && Array.isArray((nested as { content?: unknown }).content)
      ? ((nested as { content: readonly unknown[] }).content)
      : []
  const texts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
  }
  return texts
}

/**
 * Every attached-secret marker one `user/message` payload carries.
 *
 * The same rule as the Host's `messageMarkers` (`src/attach.ts:315-324`): the
 * row exists because the message's own text carries the marker, never because a
 * session happened to have such a record.
 */
function messageMarkers(data: unknown): readonly string[] {
  const found: string[] = []
  for (const text of messageTextBlocks(data)) {
    for (const variable of parseMarkers(text)) {
      if (!found.includes(variable)) found.push(variable)
    }
  }
  return found
}

/** Read one attach response. A shape this half cannot understand is a refusal. */
function readAttachResponse(payload: unknown): { variable: string; scope: Scope; replaced: boolean } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.ok !== true) return null
  const variable = text(record.variable)
  const scope = scopeOf(record.scope)
  if (variable === undefined || scope === undefined) return null
  return { variable, scope, replaced: record.replaced === true }
}

/** Read the host's own attachment list. Anything unreadable answers null. */
function readAttachedList(payload: unknown): readonly AttachedMeta[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const list = (payload as { attachments?: unknown }).attachments
  if (!Array.isArray(list)) return null
  const out: AttachedMeta[] = []
  for (const candidate of list) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const variable = text(record.variable)
    const scope = scopeOf(record.scope)
    const state = record.state === 'bound' ? 'bound' : record.state === 'staged' ? 'staged' : undefined
    if (variable === undefined || scope === undefined || state === undefined) continue
    out.push({
      variable,
      name: text(record.name) ?? variable,
      label: text(record.label) ?? variable,
      scope,
      state,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      // The host says nothing about the two facts that exist only in this page
      // (the generation a withdrawal timer captured, and whether the marker was
      // ever present here). A reader is pure, so it reports the neutral values;
      // `refreshAttached` merges them with what this page already knew.
      generation: 0,
      seenPresent: false,
    })
  }
  return out
}

/** The fixed sentence one refused attach reports. */
function attachErrorFor(status: number): string {
  return ATTACH_FAILURE[status] ?? ATTACH_FAILURE_UNKNOWN
}

/** Read the host's attachment list for one session and publish it. */
async function refreshAttached(sessionId: string): Promise<void> {
  if (sessionId === '') return
  try {
    const response = await fetch(`${ATTACHED_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return
    const list = readAttachedList(await response.json())
    if (list === null) return
    const previous = attachedBySession.get(sessionId)
    const map = new Map<string, AttachedMeta>()
    for (const entry of list) {
      // The host is the authority for what is still attached; this page is the
      // authority for the two facts only it can know, so they are carried over
      // instead of being reset by a refresh.
      const known = previous?.get(entry.variable)
      map.set(
        entry.variable,
        known === undefined
          ? entry
          : { ...entry, generation: known.generation, seenPresent: known.seenPresent },
      )
    }
    attachedBySession.set(sessionId, map)
    publishAttached()
  } catch {
    // Unreachable is not evidence of anything: the capsule keeps what it knows.
  }
}

/**
 * Read the host's history for one session and publish it.
 *
 * A failed or unreadable read keeps the last answer instead of clearing it:
 * "unreachable" is not evidence that the history is empty, and a history area
 * that blanks itself on a hiccup would report a past that did not happen.
 */
async function refreshHistory(sessionId: string): Promise<void> {
  if (sessionId === '') return
  try {
    const response = await fetch(`${HISTORY_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      historyUnavailable.add(sessionId)
      publishAttached()
      return
    }
    const list = readHistoryList(await response.json())
    if (list === null) {
      historyUnavailable.add(sessionId)
      publishAttached()
      return
    }
    historyUnavailable.delete(sessionId)
    historyBySession.set(sessionId, list)
    publishAttached()
  } catch {
    historyUnavailable.add(sessionId)
    publishAttached()
  }
}

/** The history this page last read for one session (empty when it never did). */
function historyOf(sessionId: string): readonly HistoryEntry[] {
  return historyBySession.get(sessionId) ?? []
}

/** Whether the last history read for this session failed. */
function historyFailed(sessionId: string): boolean {
  return historyUnavailable.has(sessionId)
}

/**
 * Whether this page has ever completed a history read for one session.
 *
 * "Never read" and "read, and there is nothing" are different facts: an empty
 * pile of records must not be reported before the first answer arrives, or the
 * area would claim the session never attached anything while it is still asking.
 */
function historyRead(sessionId: string): boolean {
  return historyBySession.has(sessionId)
}

/**
 * The message key each lifecycle transition renders with.
 *
 * Mirrors `HISTORY_EVENTS`: an event missing here would render as unknown, so
 * the two lists are kept side by side and a test reads both.
 */
const HISTORY_LABEL: Record<string, string> = {
  staged: 'evStaged',
  bound: 'evBound',
  discarded: 'evDiscarded',
  withdrawn: 'evWithdrawn',
  revoked: 'evRevoked',
  expired: 'evExpired',
  authorized: 'evAuthorized',
}

/** The message key of one history event, or undefined for an unknown one. */
function historyEventKey(event: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(HISTORY_LABEL, event) ? HISTORY_LABEL[event] : undefined
}

/** One number as two digits, for the fixed-width stamp below. */
function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * One history timestamp as a fixed-width UTC instant.
 *
 * UTC and not the browser's local time on purpose: the same record must read the
 * same way in every client and in every test, and the trailing `Z` says which
 * clock it is instead of leaving it to be guessed. An input that is not a finite
 * number answers the empty string, which the row renders as "time unknown".
 */
function formatHistoryStamp(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return ''
  return `${String(time.getUTCFullYear()).padStart(4, '0')}-${twoDigits(time.getUTCMonth() + 1)}-${twoDigits(time.getUTCDate())} ${twoDigits(time.getUTCHours())}:${twoDigits(time.getUTCMinutes())}:${twoDigits(time.getUTCSeconds())}Z`
}

/**
 * The one-line facts under one history row: what it was, how it was scoped, where
 * it came from, when it happened, and the two extras a row may carry.
 *
 * Composed from the entry's own fields only — there is no value field to read,
 * and the separator is fixed so the line stays machine-readable in a test.
 */
function historyRowMeta(entry: HistoryEntry, t: (key: string) => string): string {
  const stamp = formatHistoryStamp(entry.at)
  const parts = [
    entry.label,
    t(entry.scope === 'persistent' ? 'persistent' : 'session'),
    entry.source === 'request' ? t('sourceRequest') : t('sourceAttach'),
    stamp === '' ? t('historyNoTime') : stamp,
  ]
  if (entry.anchorSeq !== undefined) parts.push(`${t('anchorLabel')} ${entry.anchorSeq}`)
  if (entry.replaced === true) parts.push(t('histReplaced'))
  return parts.join(' · ')
}

/**
 * Decide what one staged record's absence from the draft means.
 *
 * Three signals are needed, because none of them is sufficient alone:
 *
 * - `markerPresent`: the draft still carries the marker, so nothing happened.
 * - `submissionCarries`: a pending submission's text carries the marker. The
 *   composer clears the draft *before* it sends (an optimistic commit), so
 *   "the draft no longer has it" is the normal, healthy state during a send.
 * - `seenPresent`: the marker was seen in this page's draft at least once. An
 *   attach whose chip rung fell through to "type it yourself" has never been
 *   present, and withdrawing it would destroy a value the human just entered.
 *
 * `phase` guards the editor's own transient states (adjudication, a claim, the
 * submission lock); only a plain editor may arm a withdrawal.
 */
function decideWithdraw(input: {
  readonly state: AttachState
  readonly seenPresent: boolean
  readonly markerPresent: boolean
  readonly submissionCarries: boolean
  readonly phase: string
}): 'keep' | 'arm' | 'cancel' {
  if (input.state !== 'staged') return 'keep'
  if (input.markerPresent || input.submissionCarries) return 'cancel'
  if (!input.seenPresent) return 'keep'
  if (input.phase !== 'plain') return 'keep'
  return 'arm'
}

/** Whether one text carries one variable's marker (the same rule as the host's). */
function carriesMarker(text: string, variable: string): boolean {
  return parseMarkers(text).includes(variable)
}

/** One release answer, as the reader below accepts it. */
interface ReleaseAnswer {
  readonly released: boolean
  readonly state: 'staged' | 'bound' | 'none'
}

/** One release request's outcome: the HTTP facts plus the parsed answer, if any. */
interface ReleaseAttempt {
  readonly ok: boolean
  readonly status: number
  readonly answer: ReleaseAnswer | null
}

/** The text of every pending submission echo of one session, joined. Never a value. */
function pendingTextOf(pending: unknown): string {
  if (!Array.isArray(pending)) return ''
  const parts: string[] = []
  for (const item of pending) {
    const text = (item as PendingSubmissionLike | null)?.text
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** Read the host's release answer. A malformed payload answers null. */
function readReleaseResponse(payload: unknown): ReleaseAnswer | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.ok !== true || typeof record.released !== 'boolean') return null
  const state =
    record.state === 'staged' || record.state === 'bound' || record.state === 'none' ? record.state : undefined
  if (state === undefined) return null
  return { released: record.released, state }
}

/**
 * POST one release and read its answer.
 *
 * Shared by the two ways a staged record ends by hand — the capsule's own
 * discard and the draft observer's withdrawal — so the reason is the only thing
 * that differs between them. A refusal, an unreadable body and an unreachable
 * host all come back with `answer: null` and change nothing locally.
 */
async function postRelease(
  sessionId: string,
  variable: string,
  reason: 'discarded' | 'withdrawn',
): Promise<ReleaseAttempt> {
  try {
    const response = await fetch(RELEASE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, variable, reason }),
    })
    if (!response.ok) return { ok: false, status: response.status, answer: null }
    const payload: unknown = await response.json().catch(() => undefined)
    return { ok: true, status: response.status, answer: readReleaseResponse(payload) }
  } catch {
    return { ok: false, status: 0, answer: null }
  }
}

/**
 * Mirror one release answer onto this page's record of the session.
 *
 * The host is the authority, and `released:false` is not a failure: it is the
 * host saying what the record is now. `mark` separates the two ways a record
 * ends by hand — a draft withdrawal keeps the record visible as withdrawn, a
 * manual discard drops it — while a `bound` answer and a `none` answer mean the
 * same thing whichever way the request was made.
 *
 * A null answer mirrors nothing at all: better a record that outlives its marker
 * until the TTL than a page reporting a withdrawal the host never performed.
 */
function applyRelease(
  sessionId: string,
  variable: string,
  answer: ReleaseAnswer | null,
  mark: 'withdrawn' | 'remove',
): void {
  if (answer === null) return
  const map = attachedBySession.get(sessionId)
  const meta = map?.get(variable)
  if (map === undefined || meta === undefined) return
  if (answer.state === 'bound') {
    // Someone sent the message inside the window: the record is anchored now,
    // and only taking that message back can end it.
    map.set(variable, { ...meta, state: 'bound' })
  } else if (answer.released && mark === 'withdrawn') {
    map.set(variable, { ...meta, state: 'withdrawn' })
    noteWithdrawn(sessionId, variable, meta)
  } else {
    // Either the host really released a staged record (and the caller chose to
    // drop it) or it was already gone: in both cases this page keeps nothing.
    map.delete(variable)
  }
  publishAttached()
}

/**
 * Append one local history line for an instant-feedback withdrawal.
 *
 * The host records the same transition (that is where the durable history comes
 * from), so this only fills the gap between the timer firing and the next
 * history read. Nothing is invented: a session this page has never read history
 * for keeps its empty list and learns the transition from the host.
 */
function noteWithdrawn(sessionId: string, variable: string, meta: AttachedMeta): void {
  const list = historyBySession.get(sessionId)
  if (list === undefined) return
  historyBySession.set(sessionId, [
    {
      at: Date.now(),
      event: 'withdrawn',
      variable,
      name: meta.name,
      label: meta.label,
      scope: meta.scope,
      source: 'attach',
    },
    ...list,
  ])
}

/** The timer slot one session's variable owns. */
function withdrawKey(sessionId: string, variable: string): string {
  return `${sessionId}\u0000${variable}`
}

/** Drop one variable's armed withdrawal, if any. */
function cancelWithdraw(sessionId: string, variable: string): void {
  const key = withdrawKey(sessionId, variable)
  const armed = withdrawTimers.get(key)
  if (armed === undefined) return
  armed.cancel()
  withdrawTimers.delete(key)
}

/**
 * Arm one variable's withdrawal for the debounce window.
 *
 * A timer already armed for the same generation is left exactly as it is, so a
 * stream of draft changes cannot postpone the deadline for ever; a timer armed
 * for an older generation belongs to a record that has been replaced and is
 * cancelled before the new one is armed.
 */
function armWithdraw(sessionId: string, variable: string, generation: number): void {
  const armed = withdrawTimers.get(withdrawKey(sessionId, variable))
  if (armed !== undefined) {
    if (armed.generation === generation) return
    cancelWithdraw(sessionId, variable)
  }
  const key = withdrawKey(sessionId, variable)
  const timer = setTimeout(() => {
    withdrawTimers.delete(key)
    void withdrawRecord(sessionId, variable, generation)
  }, WITHDRAW_DEBOUNCE_MS)
  withdrawTimers.set(key, {
    generation,
    cancel: () => {
      clearTimeout(timer)
    },
  })
}

/** Arm or cancel every staged record of one session from the last observation. */
function reviewWithdrawals(sessionId: string): void {
  const map = attachedBySession.get(sessionId)
  if (map === undefined) return
  for (const [variable, meta] of [...map.entries()]) {
    const verdict = decideWithdraw({
      state: meta.state,
      seenPresent: meta.seenPresent,
      markerPresent: carriesMarker(observed.draft, variable),
      submissionCarries: carriesMarker(observed.pendingText, variable),
      phase: observed.phase,
    })
    if (verdict === 'arm') armWithdraw(sessionId, variable, meta.generation)
    else cancelWithdraw(sessionId, variable)
  }
}

/**
 * Publish one composer observation and re-decide every staged record of a session.
 *
 * This is the whole of requirement 3's timing rule. The component above only
 * reads the two seats the host publishes — the draft projection and the session
 * snapshot — and hands them here, which is why the send-versus-removal decision
 * can be tested without a browser.
 *
 * "The marker is in the draft" is also what makes a record withdrawable later:
 * a marker that never landed (the manual-insert rung) must keep its value.
 */
function observeComposer(
  sessionId: string,
  input: { readonly draft?: unknown; readonly phase?: unknown; readonly pendingSubmissions?: unknown },
): void {
  if (sessionId === '') return
  const draft = typeof input.draft === 'string' ? input.draft : ''
  observed.sessionId = sessionId
  observed.draft = draft
  observed.phase = typeof input.phase === 'string' ? input.phase : 'plain'
  observed.pendingText = pendingTextOf(input.pendingSubmissions)
  const map = attachedBySession.get(sessionId)
  if (map === undefined) return
  let learned = false
  for (const meta of [...map.values()]) {
    if (meta.state === 'staged' && !meta.seenPresent && carriesMarker(draft, meta.variable)) {
      map.set(meta.variable, { ...meta, seenPresent: true })
      learned = true
    }
  }
  reviewWithdrawals(sessionId)
  if (learned) publishAttached()
}

/**
 * One armed withdrawal firing: re-read everything and act only if it still holds.
 *
 * The re-read is what the debounce is for. By the time the timer fires, the
 * draft, the pending submissions and the record itself may all have moved — a
 * re-insert inside the window, a send that landed, a re-attach that bumped the
 * generation, another session's composer taking over the observation — and any
 * of those means this timer is about a past that is gone. In every such case the
 * record is left alone: a value that is still in use must never be dropped
 * because a timer was armed a moment earlier.
 */
async function withdrawRecord(sessionId: string, variable: string, generation: number): Promise<void> {
  if (observed.sessionId !== sessionId) return
  const meta = attachedBySession.get(sessionId)?.get(variable)
  if (meta === undefined || meta.generation !== generation) return
  const verdict = decideWithdraw({
    state: meta.state,
    seenPresent: meta.seenPresent,
    markerPresent: carriesMarker(observed.draft, variable),
    submissionCarries: carriesMarker(observed.pendingText, variable),
    phase: observed.phase,
  })
  if (verdict !== 'arm') return
  applyRelease(sessionId, variable, (await postRelease(sessionId, variable, 'withdrawn')).answer, 'withdrawn')
}

/** The observation the observer last published (diagnostics and tests). */
function observedState(): { readonly sessionId: string; readonly draft: string; readonly phase: string; readonly pendingText: string } {
  return { ...observed }
}

/** The exact address one transcript capsule click resolves to, as this half reads it. */
function pathOfAddress(address: string): string {
  const withoutScheme = address.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
  const slash = withoutScheme.indexOf('/')
  const path = slash === -1 ? '' : withoutScheme.slice(slash + 1)
  return path.split(/[?#]/u)[0] ?? path
}

/**
 * The variable one file address names, when it names ours.
 *
 * The transcript renders `@DSH_SECRET_X` as a *file* reference and opens it as
 * `dsh-resource://file/…/DSH_SECRET_X`, so the last path segment is the variable
 * and the `@` is already gone. Anything else answers undefined: a viewer that
 * claimed a real path would be lying about what it shows.
 */
function variableOfAddress(address: string): string | undefined {
  const path = decodeURIComponent(pathOfAddress(address))
  const last = path.split('/').filter((part) => part !== '').at(-1)
  if (last === undefined) return undefined
  return /^DSH_SECRET_[A-Z][A-Z0-9_]*$/u.test(last) ? last : undefined
}

/** Read one history entry. Anything unreadable is dropped, never guessed at. */
function readHistoryEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const variable = text(record.variable)
  const event = text(record.event)
  const scope = scopeOf(record.scope)
  const source = record.source === 'attach' ? 'attach' : record.source === 'request' ? 'request' : undefined
  const label = text(record.label)
  const name = text(record.name)
  if (variable === undefined || event === undefined || scope === undefined || source === undefined) return null
  if (label === undefined || name === undefined) return null
  if (!HISTORY_EVENTS.includes(event)) return null
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : undefined
  const anchorSeq = typeof record.anchorSeq === 'number' && Number.isFinite(record.anchorSeq) ? record.anchorSeq : undefined
  return {
    event,
    variable,
    name,
    label,
    scope,
    source,
    ...(at === undefined ? {} : { at }),
    ...(anchorSeq === undefined ? {} : { anchorSeq }),
    ...(record.replaced === true ? { replaced: true } : {}),
  }
}

/** Read the host's history answer. A malformed payload answers null. */
function readHistoryList(payload: unknown): readonly HistoryEntry[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.ok !== true || !Array.isArray(record.entries)) return null
  const out: HistoryEntry[] = []
  for (const raw of record.entries) {
    const entry = readHistoryEntry(raw)
    if (entry !== null) out.push(entry)
  }
  return out
}

/** Read one available row. Anything unreadable is dropped, never guessed at. */
function readAvailableEntry(raw: unknown): AvailableEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const variable = text(record.variable)
  const name = text(record.name)
  const label = text(record.label)
  const scope = scopeOf(record.scope)
  const state = record.state === 'staged' || record.state === 'bound' || record.state === 'stored'
    ? record.state
    : undefined
  const source = record.source === 'session' || record.source === 'store' ? record.source : undefined
  if (variable === undefined || name === undefined || label === undefined) return null
  if (scope === undefined || state === undefined || source === undefined) return null
  return { variable, name, label, scope, state, source }
}

/** Read the host's available-list answer. A malformed payload answers null. */
function readAvailableList(payload: unknown): readonly AvailableEntry[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.ok !== true || !Array.isArray(record.entries)) return null
  const out: AvailableEntry[] = []
  for (const raw of record.entries) {
    const entry = readAvailableEntry(raw)
    if (entry !== null) out.push(entry)
  }
  return out
}

/** How many rows the `@` menu may show at once. */
const MAX_CANDIDATES = 20

/**
 * Turn available rows into menu candidates.
 *
 * Source and scope are carried by `section` and `description` — the two fields
 * the menu actually renders — rather than by mangling the name. The main text is
 * the variable (what the human will see in their own message), the credential key
 * rides `name` (the menu shows it as the grey alias), and the real payload is the
 * JSON `value`, so display and meaning stay decoupled.
 */
function candidateRows(entries: readonly AvailableEntry[], query: string): readonly CandidateLike[] {
  const needle = query.trim().toLowerCase()
  const out: CandidateLike[] = []
  for (const entry of entries) {
    if (out.length >= MAX_CANDIDATES) break
    if (
      needle !== ''
      && !entry.variable.toLowerCase().includes(needle)
      && !entry.name.toLowerCase().includes(needle)
      && !entry.label.toLowerCase().includes(needle)
    ) {
      continue
    }
    out.push({
      name: entry.name,
      label: entry.label,
      description: describeAvailable(entry),
      icon: 'session',
      section: entry.source === 'store' ? ATTACH_ZH.sectionStore ?? '' : ATTACH_ZH.sectionSession ?? '',
      value: JSON.stringify({ v: entry.variable, origin: entry.source }),
    })
  }
  return out
}

/**
 * The one-line provenance of a menu row: where it comes from, and its scope.
 *
 * Built from the literal table so the same facts are spelled the same way in the
 * capsule, the history area and the menu.
 */
function describeAvailable(entry: AvailableEntry): string {
  if (entry.source === 'store') return ATTACH_ZH.descStore ?? ''
  const durable = entry.scope === 'persistent'
  if (entry.state === 'bound') {
    return (durable ? ATTACH_ZH.descSessionBoundPersistent : ATTACH_ZH.descSessionBound) ?? ''
  }
  return (durable ? ATTACH_ZH.descSessionStagedPersistent : ATTACH_ZH.descSessionStaged) ?? ''
}

/**
 * Read one candidate's pick payload.
 *
 * The menu treats `value` as opaque and hands it back verbatim, so this is the
 * only place the source's own encoding is decoded — and a payload this half did
 * not write is refused rather than interpreted.
 */
function readCandidateValue(value: unknown): { readonly v: string; readonly origin: 'session' | 'store' } | null {
  const raw = text(value)
  if (raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const variable = text(record.v)
    const origin = record.origin === 'session' ? 'session' : record.origin === 'store' ? 'store' : undefined
    if (variable === undefined || origin === undefined) return null
    return { v: variable, origin }
  } catch {
    return null
  }
}

/**
 * The last available list this page read, per session. Never a value.
 *
 * The `@` menu is the only reader, and it re-reads on every open and every query
 * change: an answer that cannot be read leaves the previous list in place, so a
 * hiccup narrows the menu to the names it already showed instead of claiming the
 * session and the store hold nothing.
 */
const availableBySession = new Map<string, readonly AvailableEntry[]>()
/** In-flight available reads, so one open menu cannot stack requests. */
const availableInFlight = new Map<string, Promise<readonly AvailableEntry[]>>()

/**
 * The confirm a store-side pick is waiting behind, if any.
 *
 * Armed by the pick (which must not register anything), consumed by the confirm
 * face's own action, and cleared on every way out of that face. It holds names
 * and one editor span — never a value: the Host resolves the value itself.
 */
let pendingPick: {
  readonly sessionId: string
  readonly variable: string
  readonly name: string
  readonly span: TokenSpanLike | null
} | null = null

/** Read the host's available list for one session (the whole input of the `@` menu). */
async function refreshAvailable(sessionId: string): Promise<readonly AvailableEntry[]> {
  if (sessionId === '') return []
  const inFlight = availableInFlight.get(sessionId)
  if (inFlight !== undefined) return inFlight
  const run = (async (): Promise<readonly AvailableEntry[]> => {
    try {
      const response = await fetch(`${AVAILABLE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return availableBySession.get(sessionId) ?? []
      const list = readAvailableList(await response.json())
      if (list === null) return availableBySession.get(sessionId) ?? []
      availableBySession.set(sessionId, list)
      return list
    } catch {
      return availableBySession.get(sessionId) ?? []
    } finally {
      availableInFlight.delete(sessionId)
    }
  })()
  availableInFlight.set(sessionId, run)
  return run
}

/** The last available list this page read for one session (empty when it never did). */
function availableOf(sessionId: string): readonly AvailableEntry[] {
  return availableBySession.get(sessionId) ?? []
}

/** Read one span the editor handed over, when it really handed one. */
function readSpan(raw: unknown): TokenSpanLike | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const start = record.start
  const end = record.end
  const draftRev = record.draftRev
  if (typeof start !== 'number' || typeof end !== 'number' || typeof draftRev !== 'number') return null
  return { start, end, draftRev }
}

/** Whether an editor signal this page was handed is already aborted. */
function signalAborted(signal: unknown): boolean {
  return typeof signal === 'object' && signal !== null && (signal as { readonly aborted?: unknown }).aborted === true
}

/** One `@` menu pick, as the trigger pipeline hands it to its source. */
interface PickInputLike {
  readonly candidate?: unknown
  readonly session?: unknown
  readonly action?: unknown
  readonly span?: unknown
}

/**
 * The `@` menu's pick: the one place a chosen row becomes an edit.
 *
 * A session-side row is inserted straight away — its record already exists, so
 * the marker cannot become a lie. A store-side row registers nothing here: the
 * pick only opens the capsule's confirm face (U5), and the adopt that follows the
 * human's confirmation is what both registers the record and inserts the marker.
 * Both branches end in `insertFor`, so the marker a menu pick leaves is exactly
 * the marker the fill form leaves: the same codec owns it either way.
 *
 * @returns the frozen contract's outcome, or undefined when the pick is not ours.
 */
function sourceOnPick(input: PickInputLike): undefined | 'handled' | { readonly insert: ReferenceInsertLike } {
  // A drill opens a sub-menu instead of choosing anything: never an insert.
  if (input.action !== undefined && input.action !== 'pick') return undefined
  const candidate = input.candidate
  const value =
    typeof candidate === 'object' && candidate !== null ? (candidate as { readonly value?: unknown }).value : undefined
  const pick = readCandidateValue(value)
  if (pick === null) return undefined
  if (pick.origin === 'session') return insertFor(pick.v)
  const sessionId = text((input.session as { readonly sessionId?: unknown } | undefined)?.sessionId)
  if (sessionId === undefined || sessionId === '') return 'handled'
  const name = text((candidate as { readonly name?: unknown }).name) ?? pick.v
  pendingPick = { sessionId, variable: pick.v, name, span: readSpan(input.span) }
  setAttachMode({ kind: 'confirm', variable: pick.v, name })
  return 'handled'
}

/**
 * The standing store-side confirm, as diagnostics and tests read it.
 *
 * Names and one editor span only — never a value.
 */
function pendingPickOf(): typeof pendingPick {
  return pendingPick === null ? null : { ...pendingPick }
}

/** Drop any standing store-side confirm without touching anything else. */
function clearPendingPick(): void {
  pendingPick = null
}

/** The fixed sentence one refused adopt reports, by the host's own status. */
function adoptErrorFor(status: number): string {
  if (status === 404) return ATTACH_ZH.adopt404 ?? ATTACH_FAILURE_UNKNOWN
  if (status === 409) return ATTACH_ZH.adopt409 ?? ATTACH_FAILURE_UNKNOWN
  if (status === 500) return ATTACH_ZH.adopt500 ?? ATTACH_FAILURE_UNKNOWN
  return ATTACH_ZH.confirmFailed ?? ATTACH_FAILURE_UNKNOWN
}

/** The `@` menu's reference payload for one variable: exactly what `insertChip` builds. */
function insertFor(variable: string): { readonly insert: ReferenceInsertLike } {
  return {
    insert: {
      source: SECRET_SOURCE,
      ref: variable,
      label: variable,
      appearance: 'session',
      clipboardText: markerOf(variable),
    },
  }
}

/**
 * Insert one attached-secret reference at the caret.
 *
 * L1 is the frozen contract's own scoped insertion event — the very event the
 * `@` menu's pick pipeline ends in, so this is the official path rather than a
 * private call. It replaces the captured span with one reference chip. When the
 * editor refuses (a stale revision, a locked phase), L3 inserts the plain marker
 * the source's lexicon already decorates as a clickable reference; L4 hands the
 * variable to the human instead of pretending the draft was edited.
 *
 * @returns which rung actually applied.
 */
function insertChip(sessionId: string, variable: string, span: TokenSpanLike | null, actions: InputActionsLike | undefined): 'chip' | 'text' | 'manual' {
  const reference: ReferenceInsertLike = {
    source: SECRET_SOURCE,
    ref: variable,
    label: variable,
    appearance: 'session',
    clipboardText: markerOf(variable),
  }
  if (span !== null && sessionsScope !== null) {
    const scope = sessionsScope(sessionId)
    if (scope?.bail !== undefined) {
      if (scope.bail(scope, 'slash/input-insert-reference', { reference, span }) === true) return 'chip'
    }
  }
  const fresh = actions?.captureInsertion?.() ?? span
  if (fresh !== null && actions?.insertText !== undefined) {
    if (actions.insertText(markerOf(variable), fresh) === true) return 'text'
  }
  return 'manual'
}

/** The translate seat, with the literal table as the fallback. */
function attachT(props: { readonly t?: unknown }): (key: string) => string {
  const t = props.t
  if (typeof t === 'function') return t as (key: string) => string
  return (key: string) => ATTACH_ZH[key] ?? key
}

/**
 * The composer's entry button: a toggle whose pressed state and label follow the
 * capsule, exactly as the vision-mode toggle's follow theirs.
 */
function SecretAttachToggle(props: {
  readonly sessionId?: unknown
  readonly open?: () => void
  readonly close?: () => void
  readonly t?: unknown
}): unknown {
  const h = React.createElement
  const t = attachT(props)
  const sessionId = text(props.sessionId) ?? ''
  const [snap, setSnap] = React.useState(0)
  React.useEffect(() => {
    const release = subscribeAttached(() => setSnap((previous: number) => previous + 1))
    // The host is the authority for what is still attached after a reload.
    void refreshAttached(sessionId)
    return release
  }, [sessionId])
  void snap
  const open = currentMode().kind !== 'idle'
  const count = attachmentCount(sessionId)
  return h(
    'button',
    {
      type: 'button',
      className: open ? `${A.btn} ${A.btnOn}` : A.btn,
      'data-secret-attach-toggle': 'true',
      'aria-pressed': open,
      'aria-label': open ? t('toggleOpen') : t('toggle'),
      title: t('toggleHint'),
      onMouseDown: (event: { preventDefault?: () => void }) => {
        event.preventDefault?.()
      },
      onClick: () => {
        if (open) {
          if (props.close !== undefined) props.close()
          else setAttachMode({ kind: 'idle' })
          return
        }
        if (props.open !== undefined) props.open()
        else setAttachMode({ kind: 'fill' })
      },
    },
    h('span', { className: A.glyph, 'aria-hidden': true }, '🔑'),
    h('span', null, t('toggle')),
    count > 0 ? h('span', { className: A.badge }, String(count)) : null,
  )
}

/**
 * The capsule: the value form while the human fills one in, and the read-only
 * detail view once the reference is in the draft.
 *
 * It floats above the composer card (the `@` menu's own seat), so it never
 * covers the line being typed. `idle` renders nothing.
 */
function SecretAttachCapsule(props: {
  readonly sessionId?: unknown
  readonly inputActions?: InputActionsLike
  readonly t?: unknown
  /** The standard kit's selector hook for the composer's published state. */
  readonly useInput?: unknown
  /** The standard kit's selector hook for this session's snapshot. */
  readonly useSession?: unknown
}): unknown {
  const h = React.createElement
  const t = attachT(props)
  const sessionId = text(props.sessionId) ?? ''
  const actions = props.inputActions
  const [snap, setSnap] = React.useState(0)
  const [key, setKey] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [value, setValue] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [scope, setScope] = React.useState<Scope>('session')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [tier, setTier] = React.useState<string | null>(null)
  React.useEffect(() => subscribeAttached(() => setSnap((previous: number) => previous + 1)), [])
  void snap

  // The two seats requirement 3 needs are standard-kit props of this very
  // registration — the same kit that carries `inputActions`. Without them the
  // plugin does not guess: it never withdraws, and the detail face says so (R2).
  const watching = typeof props.useInput === 'function' && typeof props.useSession === 'function'
  const useInputSeat = typeof props.useInput === 'function' ? (props.useInput as SeatHook) : useAbsentSeat
  const useSessionSeat = typeof props.useSession === 'function' ? (props.useSession as SeatHook) : useAbsentSeat
  const draftSeat = text(useInputSeat((state: InputStateLike) => state.draft)) ?? ''
  const phaseSeat = text(useInputSeat((state: InputStateLike) => state.phase)) ?? 'plain'
  const pendingSeat = useSessionSeat((state: SessionSnapshotLike) => state.pendingSubmissions)

  const mode = currentMode()
  const historyOpen = mode.kind === 'history'
  // Opening the history face is what asks the host for it. The dependency is the
  // boolean, not the mode object: the read publishes an attachment change, which
  // re-renders this component, and depending on that would loop the fetch.
  React.useEffect(() => {
    if (!historyOpen) return undefined
    void refreshHistory(sessionId)
    return undefined
  }, [sessionId, historyOpen])
  // Requirement 3: the observer. This entry is the one that stays mounted for the
  // whole session (an empty face still renders a component), which is exactly why
  // it is where the composer is watched.
  React.useEffect(() => {
    if (!watching) return undefined
    observeComposer(sessionId, { draft: draftSeat, phase: phaseSeat, pendingSubmissions: pendingSeat })
    return undefined
  }, [sessionId, watching, draftSeat, phaseSeat, pendingSeat])
  if (mode.kind === 'idle') return null

  async function submit(): Promise<void> {
    if (busy) return
    const name = key.trim()
    if (!ATTACH_KEY_RE.test(name)) {
      setError(t('badKey'))
      return
    }
    if (value.length === 0) {
      setError(t('noValue'))
      return
    }
    setBusy(true)
    setError(null)
    const span = actions?.captureInsertion?.() ?? null
    try {
      const response = await fetch(ATTACH_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          name,
          label: label.trim() === '' ? name : label.trim(),
          scope,
          value,
        }),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        setError(attachErrorFor(response.status))
        return
      }
      const accepted = readAttachResponse(payload)
      if (accepted === null) {
        setError(ATTACH_FAILURE_UNKNOWN)
        return
      }
      // The value leaves this component here, and this is the only place it is
      // ever read: it is not stored, echoed, or carried into the detail view.
      setValue('')
      const map = sessionAttachments(sessionId)
      const known = map.get(accepted.variable)
      map.set(accepted.variable, {
        variable: accepted.variable,
        name,
        label: label.trim() === '' ? name : label.trim(),
        scope: accepted.scope,
        state: 'staged',
        createdAt: Date.now(),
        // This record takes the variable's slot over from whatever was there:
        // the generation advances so a timer armed for the replaced record can
        // never withdraw this one, and "seen in the draft" starts false until
        // the observer reports the marker actually landed (a marker that never
        // lands must never cost the human the value they just typed).
        generation: known === undefined ? 0 : known.generation + 1,
        seenPresent: false,
      })
      publishAttached()
      const applied = insertChip(sessionId, accepted.variable, span, actions)
      setTier(applied)
      setAttachMode({ kind: 'detail', variable: accepted.variable })
    } catch {
      setError(ATTACH_UNREACHABLE)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Register one store-side pick for this session, then insert its marker.
   *
   * This is the only place a store-side pick registers anything: the pick itself
   * only opened this face, and cancelling leaves the session exactly as it was.
   * The host resolves the value from the store by itself, so nothing here reads,
   * holds or echoes one. Only a successful registration inserts — a refusal
   * leaves the draft untouched rather than leaving a marker with nothing behind
   * it.
   */
  async function confirmAdopt(variable: string, name: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(ADOPT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, variable }),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        setError(adoptErrorFor(response.status))
        return
      }
      const accepted = readAttachResponse(payload)
      if (accepted === null) {
        setError(t('confirmFailed'))
        return
      }
      const map = sessionAttachments(sessionId)
      const known = map.get(accepted.variable)
      map.set(accepted.variable, {
        variable: accepted.variable,
        name,
        // The store's own label for a durable record is its variable: that is
        // what the human will see in their message, and the Host invents no
        // title for it either.
        label: accepted.variable,
        scope: accepted.scope,
        state: 'staged',
        createdAt: Date.now(),
        // The same rule the fill path follows: a new record takes the slot over
        // from whatever was there, and "seen in the draft" starts false until
        // the observer reports the marker really landed.
        generation: known === undefined ? 0 : known.generation + 1,
        seenPresent: false,
      })
      publishAttached()
      const applied = insertChip(sessionId, accepted.variable, pendingPick?.span ?? null, actions)
      setTier(applied)
      pendingPick = null
      setAttachMode({ kind: 'detail', variable: accepted.variable })
    } catch {
      setError(t('confirmUnreachable'))
    } finally {
      setBusy(false)
    }
  }

  async function discard(variable: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const attempt = await postRelease(sessionId, variable, 'discarded')
      if (!attempt.ok) {
        setError(attempt.status === 0 ? ATTACH_UNREACHABLE : attachErrorFor(attempt.status))
        return
      }
      if (attempt.answer === null) {
        setError(ATTACH_FAILURE_UNKNOWN)
        return
      }
      // The host said which state it found; a record that turned out to be bound
      // is not discarded, and saying so is the only honest thing to show.
      applyRelease(sessionId, variable, attempt.answer, 'remove')
      setAttachMode({ kind: 'idle' })
    } finally {
      setBusy(false)
    }
  }

  // One header for every face of the box: the title names the face that is up,
  // the link is the way into the history list (and back out of a single
  // variable's own list), and the close button returns to the composer.
  const headTitle =
    mode.kind === 'fill'
      ? t('fillTitle')
      : mode.kind === 'confirm'
        ? t('confirmTitle')
        : mode.kind === 'history'
          ? mode.variable === undefined
            ? t('historyTitle')
            : t('historyForVariable')
          : t('detailTitle')
  const headLink =
    // The confirm face is a question, not a place: it offers its two answers and
    // nothing else, so it carries no history link (a store-side pick may not even
    // have a variable this session can show a history for).
    mode.kind === 'confirm'
      ? null
      : mode.kind === 'history'
      ? mode.variable === undefined
        ? null
        : h(
            'button',
            {
              type: 'button',
              className: A.link,
              'data-action': 'history-all',
              onClick: () => {
                setAttachMode({ kind: 'history' })
              },
            },
            t('historyAll'),
          )
      : h(
          'button',
          {
            type: 'button',
            className: A.link,
            'data-action': 'history',
            onClick: () => {
              setAttachMode({ kind: 'history' })
            },
          },
          t('historyLink'),
        )
  const head = h(
    'header',
    { className: A.head },
    h('span', { className: A.title }, headTitle),
    headLink,
    h(
      'button',
      {
        type: 'button',
        className: A.close,
        'data-action': 'close',
        onClick: () => {
          // Closing any face abandons a standing confirm: nothing may register
          // after the question is gone from the screen.
          pendingPick = null
          setAttachMode({ kind: 'idle' })
        },
      },
      t('close'),
    ),
  )

  if (mode.kind === 'fill') {
    const scopeOption = (next: Scope, title: string, hint: string): unknown =>
      h(
        'label',
        { key: next, className: A.option, 'data-on': scope === next ? '' : undefined },
        h('input', {
          className: A.radio,
          type: 'radio',
          name: 'dsh-secret-attach-scope',
          checked: scope === next,
          disabled: busy,
          onChange: () => setScope(next),
        }),
        h(
          'span',
          { className: A.optionBody },
          h('span', { className: A.optionTitle }, title),
          h('span', { className: A.optionHint }, hint),
        ),
      )
    return h(
      'div',
      { className: A.box, 'data-secret-attach-capsule': 'fill', role: 'group', 'aria-label': t('fillTitle') },
      head,
      h(
        'div',
        { className: A.body },
        h(
          'div',
          { className: A.field },
          h('label', { className: A.label, htmlFor: 'dsh-secret-attach-key' }, t('keyLabel')),
          h('input', {
            id: 'dsh-secret-attach-key',
            className: A.input,
            type: 'text',
            value: key,
            placeholder: t('keyPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setKey(event.target.value),
          }),
          h('span', { className: A.optionHint }, t('keyHint')),
        ),
        h(
          'div',
          { className: A.field },
          h('label', { className: A.label, htmlFor: 'dsh-secret-attach-label' }, t('labelLabel')),
          h('input', {
            id: 'dsh-secret-attach-label',
            className: A.input,
            type: 'text',
            value: label,
            placeholder: t('labelPlaceholder'),
            autoComplete: 'off',
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setLabel(event.target.value),
          }),
        ),
        h(
          'div',
          { className: A.field },
          h('label', { className: A.label, htmlFor: 'dsh-secret-attach-value' }, t('valueLabel')),
          h(
            'div',
            { className: A.inputRow },
            h('input', {
              id: 'dsh-secret-attach-value',
              className: A.input,
              type: reveal ? 'text' : 'password',
              value,
              placeholder: t('valuePlaceholder'),
              autoComplete: 'off',
              spellCheck: false,
              disabled: busy,
              'aria-label': t('valueLabel'),
              onChange: (event: { target: { value: string } }) => setValue(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: A.toggle,
                'aria-pressed': reveal,
                disabled: busy,
                onClick: () => setReveal(!reveal),
              },
              reveal ? t('hide') : t('show'),
            ),
          ),
        ),
        h(
          'div',
          { className: A.field },
          h('span', { className: A.label }, t('scopeLabel')),
          h(
            'div',
            { className: A.scope, role: 'radiogroup', 'aria-label': t('scopeLabel') },
            scopeOption('session', t('session'), t('sessionHint')),
            scopeOption('persistent', t('persistent'), t('persistentHint')),
          ),
          h(
            'p',
            { className: A.notice },
            t('current'),
            h('b', null, scope === 'persistent' ? t('persistent') : t('session')),
            ' — ',
            scope === 'persistent' ? t('persistentHint') : t('sessionHint'),
          ),
        ),
        h(
          'div',
          { className: A.actions },
          h(
            'button',
            {
              type: 'button',
              className: A.action,
              'data-kind': 'primary',
              disabled: busy,
              onClick: () => void submit(),
            },
            t('insert'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: A.action,
              disabled: busy,
              onClick: () => {
                // Cancelling must leave nothing behind: no request was made yet,
                // and the value exists only in this component's state.
                setValue('')
                setAttachMode({ kind: 'idle' })
              },
            },
            t('cancel'),
          ),
        ),
        busy ? h('p', { className: A.notice }, t('busy')) : null,
        error === null ? null : h('p', { className: A.notice, 'data-kind': 'error', role: 'alert' }, error),
        h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
      ),
    )
  }

  // The confirm face: the one question a store-side `@` pick asks before
  // anything is registered (U5). It shows what the human is about to use — the
  // variable, where it comes from and its scope — and its second answer, cancel,
  // registers nothing at all. No value is shown or asked for: the Host reads the
  // store itself once the answer is yes.
  if (mode.kind === 'confirm') {
    const target = mode
    return h(
      'div',
      {
        className: A.box,
        'data-secret-attach-capsule': 'confirm',
        role: 'group',
        'aria-label': t('confirmTitle'),
      },
      head,
      h(
        'div',
        { className: `${A.body} ${A.detail}` },
        h('p', { className: A.confirm }, `${t('confirmLead')}${target.variable}${t('confirmTail')}`),
        h(
          'div',
          { className: A.row },
          h('span', { className: A.rowLabel }, t('variableLabel')),
          h('code', { className: A.code }, target.variable),
        ),
        h(
          'div',
          { className: A.row },
          h('span', { className: A.rowLabel }, t('sourceLabel')),
          h('span', { className: A.rowValue, 'data-confirm-source': 'store' }, t('sectionStore')),
        ),
        h(
          'div',
          { className: A.row },
          h('span', { className: A.rowLabel }, t('scopeLabel')),
          h('span', { className: A.rowValue, 'data-confirm-scope': 'persistent' }, t('persistent')),
        ),
        h(
          'div',
          { className: A.actions },
          h(
            'button',
            {
              type: 'button',
              className: A.action,
              'data-action': 'confirm-adopt',
              disabled: busy,
              onClick: () => void confirmAdopt(target.variable, target.name),
            },
            t('confirmAction'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: A.link,
              'data-action': 'confirm-cancel',
              disabled: busy,
              onClick: () => {
                // Cancelling registers nothing: the pick's whole effect was this
                // question, so dropping it leaves the session as it was.
                pendingPick = null
                setAttachMode({ kind: 'idle' })
              },
            },
            t('confirmCancel'),
          ),
        ),
        busy ? h('p', { className: A.notice }, t('busy')) : null,
        error === null ? null : h('p', { className: A.notice, 'data-kind': 'error', role: 'alert' }, error),
        h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
      ),
    )
  }

  // The history face: every recorded transition of this session (or of one
  // variable), newest first, exactly as the host reported it. Nothing here is
  // filtered by liveness — a withdrawn or revoked record is part of the past and
  // is shown with its own state label — and nothing here is a value: the rows are
  // rebuilt field by field from a payload that has no field a value could ride in.
  if (mode.kind === 'history') {
    const filter = mode.variable
    const failed = historyFailed(sessionId)
    const rows =
      filter === undefined ? historyOf(sessionId) : historyOf(sessionId).filter((entry) => entry.variable === filter)
    const emptyText = filter === undefined ? t('historyEmpty') : t('historyEmptyForVariable')
    return h(
      'div',
      {
        className: A.box,
        'data-secret-attach-capsule': 'history',
        role: 'group',
        'aria-label': filter === undefined ? t('historyTitle') : t('historyForVariable'),
      },
      head,
      h(
        'div',
        { className: `${A.body} ${A.detail}` },
        // The retention rule belongs to the picture, not to a footnote: this list
        // is what the running process remembers, and a restarted host does not
        // rebuild it from the session log.
        h('p', { className: A.notice, 'data-secret-history-notice': 'retention' }, t('historyNotice')),
        h('p', { className: A.sectionTitle }, t('historySection')),
        failed
          ? h('p', { className: A.notice, 'data-kind': 'error', role: 'status' }, t('historyUnavailable'))
          : historyRead(sessionId)
            ? rows.length === 0
              ? h('p', { className: A.notice }, emptyText)
              : null
            : h('p', { className: A.notice, 'data-secret-history-reading': 'true' }, t('historyReading')),
        rows.length === 0
          ? null
          : h(
              'ul',
              { className: A.histList, 'data-secret-history-count': String(rows.length) },
              ...rows.map((entry: HistoryEntry) => {
                const eventKey = historyEventKey(entry.event)
                return h(
                  'li',
                  {
                    key: `${entry.at ?? ''}:${entry.event}:${entry.variable}`,
                    className: A.histItem,
                    'data-secret-history-row': entry.event,
                    'data-status': entry.event,
                  },
                  h(
                    'span',
                    { className: A.histEvent },
                    h('code', { className: A.code }, entry.variable),
                    ' ',
                    eventKey === undefined ? t('evUnknown') : t(eventKey),
                  ),
                  h('span', { className: A.histMeta }, historyRowMeta(entry, t)),
                )
              }),
            ),
        h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
      ),
    )
  }

  const meta = attachedBySession.get(sessionId)?.get(mode.variable)
  const scopeTitle = meta === undefined ? undefined : meta.scope === 'persistent' ? t('persistent') : t('session')
  const stateTitle =
    meta === undefined
      ? t('statusUnknown')
      : meta.state === 'bound'
        ? t('stateBound')
        : meta.state === 'withdrawn'
          ? t('evWithdrawn')
          : t('stateStaged')
  const stateNote =
    meta === undefined
      ? null
      : meta.state === 'bound'
        ? t('boundNote')
        : meta.state === 'withdrawn'
          ? t('withdrawnNote')
          : t('stagedNote')
  const tierNote = tier === 'chip' ? t('insertedChip') : tier === 'text' ? t('insertedText') : null
  return h(
    'div',
    { className: A.box, 'data-secret-attach-capsule': 'detail', role: 'group', 'aria-label': t('detailTitle') },
    head,
    h(
      'div',
      { className: `${A.body} ${A.detail}` },
      h(
        'div',
        { className: A.row },
        h('span', { className: A.rowLabel }, t('variableLabel')),
        h('code', { className: A.code }, mode.variable),
      ),
      meta === undefined
        ? null
        : h(
            'div',
            { className: A.row },
            h('span', { className: A.rowLabel }, t('labelLabel')),
            h('span', { className: A.rowValue }, meta.label),
          ),
      h(
        'div',
        { className: A.row },
        h('span', { className: A.rowLabel }, t('scopeLabel')),
        h('span', { className: A.rowValue }, scopeTitle ?? t('statusUnknown')),
      ),
      h(
        'div',
        { className: A.row },
        h('span', { className: A.rowLabel }, t('stateLabel')),
        h('span', { className: A.rowValue }, stateTitle),
      ),
      stateNote === null ? null : h('p', { className: A.notice }, stateNote),
      // Requirement 3's promise, and the honest alternative when this client
      // publishes no composer seats to watch.
      meta !== undefined && meta.state === 'staged'
        ? h('p', { className: A.notice }, watching ? t('withdrawNote') : t('withdrawUnavailable'))
        : null,
      tierNote === null ? null : h('p', { className: A.notice }, tierNote),
      tier === 'manual' ? h('p', { className: A.notice }, `${t('manualLead')}${markerOf(mode.variable)}`) : null,
      h(
        'div',
        { className: A.actions },
        meta !== undefined && meta.state === 'staged'
          ? h(
              'button',
              {
                type: 'button',
                className: A.action,
                disabled: busy,
                onClick: () => void discard(mode.variable),
              },
              t('discard'),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: A.link,
            'data-action': 'history-variable',
            onClick: () => {
              setAttachMode({ kind: 'history', variable: mode.variable })
            },
          },
          t('historyForVariable'),
        ),
      ),
      busy ? h('p', { className: A.notice }, t('busy')) : null,
      error === null ? null : h('p', { className: A.notice, 'data-kind': 'error', role: 'alert' }, error),
      h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
    ),
  )
}

/** What the side-car row remembers about the message it hangs under. Never a value. */
interface ChipRowData {
  readonly messageId: string
  readonly variables: readonly string[]
}

/**
 * The side-car row: one `chat` node per human message that carries a marker.
 *
 * This is the O2 entry point of requirement 1. It never touches the transcript's
 * own capsule, and it never renders a value: the row exists to make the marker
 * clickable again *outside* the chip the composer owns, and its click opens the
 * plugin's own detail face (the same one the capsule above the composer shows).
 *
 * `location` is `{kind:'session'}`, so the row is a root flow entry: it can
 * never be folded into a step-process group and stays visible in every
 * work-details mode, exactly like this plugin's request card.
 */
const secretAttachChipDefinition = {
  kind: CHIP_KIND,
  target: 'chat',
  match(event: { readonly type?: unknown; readonly data?: unknown }): { id: string; role: 'start' } | null {
    if (event.type !== 'user/message') return null
    const data = event.data as { id?: unknown; source?: { kind?: unknown } } | undefined
    // Only a message the human themselves sent: an agent- or context-produced
    // user/message is not an attach surface and must not sprout a row.
    if (data?.source?.kind !== 'user') return null
    if (data.id === undefined || data.id === null) return null
    if (messageMarkers(data).length === 0) return null
    return { id: String(data.id), role: 'start' }
  },
  start(_context: unknown, match: { readonly event: { readonly data?: unknown } }): ChipRowData {
    const data = match.event.data as { id?: unknown } | undefined
    return {
      messageId: data?.id === undefined || data.id === null ? '' : String(data.id),
      variables: messageMarkers(match.event.data),
    }
  },
  update(context: { readonly state: ChipRowData }): ChipRowData {
    return context.state
  },
  buildViewNode(context: {
    readonly key: string
    readonly id: string
    readonly state: ChipRowData | undefined
    readonly start: { readonly event: { readonly seq?: unknown } } | undefined
  }): Record<string, unknown> | null {
    if (context.start === undefined) return null
    const state = context.state
    // A marker-less message has no row at all: an empty row would be a claim
    // about a message that never attached anything.
    if (state === undefined || state.variables.length === 0) return null
    const seq = context.start.event.seq
    return {
      key: context.key,
      kind: CHIP_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: typeof seq === 'number' ? seq : 0,
      location: SESSION_LOCATION,
      visibility: 'visible',
      data: { messageId: state.messageId, variables: state.variables },
    }
  },
}

/** The variables one side-car row carries, read defensively off its own node. */
function chipRowVariables(node: { readonly data?: unknown } | undefined): readonly string[] {
  const data = node?.data as { variables?: unknown } | undefined
  if (!Array.isArray(data?.variables)) return []
  const out: string[] = []
  for (const value of data.variables) {
    if (typeof value !== 'string' || value.length === 0 || out.includes(value)) continue
    out.push(value)
  }
  return out
}

/**
 * One side-car row: a pill per variable, and nothing else.
 *
 * The pill shows the variable name and opens the detail face. A value can never
 * appear here — the row's data holds two strings per message, a message id and
 * variable names.
 */
function SecretAttachChipRow(props: {
  readonly node?: { readonly data?: unknown }
  readonly t?: unknown
}): unknown {
  const h = React.createElement
  const t = attachT(props)
  const variables = chipRowVariables(props.node)
  if (variables.length === 0) return null
  const data = props.node?.data as { messageId?: unknown } | undefined
  const messageId = text(data?.messageId) ?? ''
  return h(
    'div',
    {
      className: A.chipRow,
      'data-secret-attach-chip': messageId,
      role: 'group',
      'aria-label': t('chipRowLabel'),
    },
    ...variables.map((variable: string) =>
      h(
        'button',
        {
          key: variable,
          type: 'button',
          className: A.chipPill,
          'data-secret-variable': variable,
          'aria-label': `${t('chipOpenHint')} @${variable}`,
          title: markerOf(variable),
          onClick: () => {
            setAttachMode({ kind: 'detail', variable })
          },
        },
        variable,
      ),
    ),
  )
}

/** The session id one session-scoped file address names, when it names one. */
function sessionOfAddress(address: string): string | undefined {
  const parts = pathOfAddress(address).split('/').filter((part) => part !== '')
  if (parts.length < 2 || parts[0] !== 'session') return undefined
  const encoded = parts[1]
  if (encoded === undefined || encoded === '') return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/**
 * Whether one address is a variable name this plugin is prepared to show.
 *
 * This is the O1 side's admission test, and it is deliberately narrow: the
 * address must end in the exact `DSH_SECRET_*` shape this plugin mints, so a
 * real file that happens to live in a `DSH_SECRET_*` directory (or any other
 * address a longer glob lets through) is refused instead of being answered with
 * a page about a secret that does not exist.
 */
function canOpenDetailAddress(address: unknown): boolean {
  if (typeof address !== 'string' || address === '') return false
  try {
    return variableOfAddress(address) !== undefined
  } catch {
    // A malformed address (a bad percent-escape) is not our resource.
    return false
  }
}

/** The variable one right-column address names, or undefined when it is not ours. */
function detailVariableOf(address: unknown): string | undefined {
  if (typeof address !== 'string' || address === '') return undefined
  try {
    return variableOfAddress(address)
  } catch {
    return undefined
  }
}

/**
 * The right-column viewer this plugin registers for its own addresses (O1).
 *
 * A transcript `@DSH_SECRET_X` is rendered by the harness as a *file* reference
 * and opens `dsh-resource://file/session/<sessionId>/DSH_SECRET_X`, so the click
 * path is `openFile` → `sidebarRight.openResource` → the tab registry's
 * `claim(address)`. The registry ranks the types that recognize one address by
 * priority band, then by the length of the pattern that matched, then by
 * registration order (`dsh-client-ui-sidebar-right/lib/client.js:8782-8798`).
 *
 * `priority: 'extension'` puts this type in the same band as the installed
 * `dsh-better-sidebar`'s own file editor (same band, pattern
 * `dsh-resource://file/**`, 22 characters — `dsh-better-sidebar/lib/client.js:21369-21380`).
 * Same band means the longer matched pattern wins, so the pattern below is 35
 * characters long and its `**` covers the `session/<id>` segments the harness
 * inserts. That is a length race, not a contract: any later plugin declaring a
 * longer glob in the same band takes the open silently. The README says so.
 */
const secretAttachDetailDefinition = {
  id: DETAIL_TAB_ID,
  kind: DETAIL_TAB_KIND,
  patterns: [DETAIL_TAB_PATTERN],
  priority: 'extension',
  canOpen: canOpenDetailAddress,
  title: (address: unknown): string => detailVariableOf(address) ?? ATTACH_ZH['detailTabTitle'] ?? DETAIL_TAB_KIND,
}

/** What one right-column tab can read about itself (`sidebar.right.pane.tab`). */
interface TabPropsLike {
  readonly useTabInfo?: unknown
  readonly sessionId?: unknown
  readonly t?: unknown
}

/**
 * The right-column body: the same facts the capsule's detail face shows.
 *
 * It is value-free by construction — it reads the variable out of the address it
 * was opened for and looks the rest up in this page's attachment map, which
 * holds names and scopes. An address that is not ours, and a session that this
 * page never read, both render honest statements instead of guesses.
 */
function AttachDetailTab(props: TabPropsLike): unknown {
  const h = React.createElement
  const t = attachT(props)
  const info = typeof props.useTabInfo === 'function' ? (props.useTabInfo as () => TabInfoLike)() : undefined
  const address = text(info?.tab?.contentId)
  const variable = detailVariableOf(address)
  if (variable === undefined) {
    return h(
      'div',
      { className: A.tabBody, 'data-secret-attach-tab': 'unknown' },
      h('p', { className: A.notice }, t('detailTabMissing')),
    )
  }
  const sessionId = text(props.sessionId) ?? (address === undefined ? undefined : sessionOfAddress(address)) ?? ''
  const meta = attachedBySession.get(sessionId)?.get(variable)
  const scopeTitle = meta === undefined ? undefined : meta.scope === 'persistent' ? t('persistent') : t('session')
  const stateTitle = meta === undefined ? t('statusUnknown') : meta.state === 'bound' ? t('stateBound') : t('stateStaged')
  return h(
    'div',
    { className: A.tabBody, 'data-secret-attach-tab': variable, role: 'group', 'aria-label': t('detailTabTitle') },
    h('div', { className: A.row }, h('span', { className: A.rowLabel }, t('variableLabel')), h('code', { className: A.code }, variable)),
    meta === undefined ? null : h('div', { className: A.row }, h('span', { className: A.rowLabel }, t('labelLabel')), h('span', { className: A.rowValue }, meta.label)),
    h('div', { className: A.row }, h('span', { className: A.rowLabel }, t('scopeLabel')), h('span', { className: A.rowValue }, scopeTitle ?? t('statusUnknown'))),
    h('div', { className: A.row }, h('span', { className: A.rowLabel }, t('stateLabel')), h('span', { className: A.rowValue }, stateTitle)),
    h('p', { className: A.notice }, t('detailTabHint')),
  )
}

/**
 * The reference source this plugin registers.
 *
 * `codec` is not optional in practice: the composer routes every chip's model
 * serialization through the source that owns it, and a missing codec blocks the
 * send instead of silently downgrading. `lexicon` is what makes the plain marker
 * a decorated reference after a reload, when the draft is text again and no chip
 * node exists; `openReference` is how a click on either form reaches this
 * plugin.
 *
 * `candidates` lists what this session may use right now, then what the
 * credential store holds durably — the host's own answer to
 * `GET /api/secret.available`, rendered with its source in `section` and its
 * scope in `description`. `onPick` is where a row becomes an edit: a session row
 * inserts at once, a store row only opens the confirm face. No space/enter hook
 * is implemented, so the rest of the `@` affordance is untouched.
 */
const secretSource = {
  trigger: '@',
  name: SECRET_SOURCE,
  showGroupTitle: false,
  candidates: async (
    session: { readonly sessionId?: unknown } | undefined,
    options?: { readonly query?: unknown; readonly signal?: unknown },
  ): Promise<readonly CandidateLike[]> => {
    const sessionId = text(session?.sessionId)
    if (sessionId === undefined || sessionId === '') return []
    if (signalAborted(options?.signal)) return []
    const entries = await refreshAvailable(sessionId)
    if (signalAborted(options?.signal)) return []
    return candidateRows(entries, text(options?.query) ?? '')
  },
  onPick: sourceOnPick,
  lexicon: (session: { readonly sessionId?: unknown } | undefined): readonly string[] => {
    const sessionId = text(session?.sessionId)
    if (sessionId === undefined) return []
    // A withdrawn record is no longer available, so its marker must stop being
    // decorated as a live reference: the same rule the capsule's count follows.
    const variables: string[] = []
    for (const meta of attachedBySession.get(sessionId)?.values() ?? []) {
      if (meta.state !== 'withdrawn') variables.push(meta.variable)
    }
    return variables
  },
  subscribeLexicon: (_session: unknown, listener: () => void): (() => void) => subscribeAttached(listener),
  openReference: (_session: unknown, reference: { readonly ref?: unknown }): boolean => {
    const ref = text(reference?.ref)
    if (ref === undefined) return false
    const variable = ref.startsWith(MARKER_PREFIX) ? ref.slice(1) : ref
    setAttachMode({ kind: 'detail', variable })
    return true
  },
  codec: {
    clipboardText: (ref: string): string => markerOf(ref),
    serialize: (ref: string): Promise<string> => Promise.resolve(markerOf(ref)),
  },
}

/** The marker prefix, kept beside the marker helpers. */
const MARKER_PREFIX = '@'

/** The card's payload, declared against the Chat target's node map below. */
type SecretRequestCardData = CardData

/**
 * Declare this card's payload against the Chat target's merge-extensible node
 * map, so a reader of the Chat contract sees the shape this file renders.
 * Ambient on purpose: the artifact stays a classic script (no imports/exports).
 */
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'secret-request': SecretRequestCardData
  }
}

/** Bound at factory time from the browser module table. */
let React: ReactLike

/**
 * Read-only diagnostic and test seam: pure functions, the definition, and the
 * placeholder component only. Frozen, stateless, and value-free — it exists so
 * the client half's logic can be verified without a browser.
 */
const SEAM = Object.freeze({
  version: 1,
  CARD_KIND,
  TOOL_NAME,
  PENDING_PATH,
  ANSWER_PATH,
  TEXT,
  parseCallRequest,
  deriveVariable,
  readOutcome,
  readFailure,
  readEntries,
  findEntry,
  nextPendingState,
  mergeRequest,
  secretRequestDefinition,
  HiddenSecretToolRow,
})

;(globalThis as unknown as { __cordisSecretClient?: unknown }).__cordisSecretClient = SEAM

/**
 * The attach surface's own read-only seam.
 *
 * Kept separate from the card's seam on purpose: the card's seam is a frozen,
 * asserted contract from the previous round, and widening it would rewrite an
 * accepted interface. This one exposes the reverse direction's pure logic and
 * the registered source. Frozen, stateless and value-free: the attached-secret
 * map it can reach holds names and scopes, never a value.
 */
const ATTACH_SEAM = Object.freeze({
  version: 1,
  ATTACH_SLOT,
  CAPSULE_SLOT,
  ATTACH_PATH,
  RELEASE_PATH,
  ATTACHED_PATH,
  AVAILABLE_PATH,
  ADOPT_PATH,
  SECRET_SOURCE,
  ATTACH_NS,
  MARKER_RE,
  ATTACH_ZH,
  ATTACH_FAILURE,
  ATTACH_FAILURE_UNKNOWN,
  ATTACH_UNREACHABLE,
  markerOf,
  parseMarkers,
  readAttachResponse,
  readAttachedList,
  attachErrorFor,
  refreshAttached,
  refreshHistory,
  observeComposer,
  observedState,
  decideWithdraw,
  pendingTextOf,
  readReleaseResponse,
  WITHDRAW_DEBOUNCE_MS,
  historyOf,
  historyFailed,
  historyRead,
  readHistoryList,
  HISTORY_EVENTS,
  HISTORY_LABEL,
  historyEventKey,
  formatHistoryStamp,
  historyRowMeta,
  insertChip,
  refreshAvailable,
  availableOf,
  readAvailableList,
  readCandidateValue,
  candidateRows,
  describeAvailable,
  adoptErrorFor,
  readSpan,
  MAX_CANDIDATES,
  pendingPickOf,
  clearPendingPick,
  sourceOnPick,
  secretSource,
  SecretAttachToggle,
  SecretAttachCapsule,
  CHIP_KIND,
  messageTextBlocks,
  messageMarkers,
  secretAttachChipDefinition,
  SecretAttachChipRow,
  DETAIL_TAB_ID,
  DETAIL_TAB_KIND,
  DETAIL_TAB_PATTERN,
  secretAttachDetailDefinition,
  canOpenDetailAddress,
  variableOfAddress,
  pathOfAddress,
  sessionOfAddress,
  AttachDetailTab,
  currentMode,
  setAttachMode,
  subscribeAttached,
  attachmentCount,
  sessionAttachments,
})

;(globalThis as unknown as { __cordisSecretAttach?: unknown }).__cordisSecretAttach = ATTACH_SEAM

const loader = (globalThis as unknown as { __ModuleLoader__?: ModuleLoaderTarget }).__ModuleLoader__

loader?.load({
  id: PACKAGE_ID,
  factory(require) {
    React = require('react') as ReactLike

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx: ClientContextLike) {
        ensureCardStyle()
        ensureAttachStyle()
        // The one visible interaction surface: this plugin's own chat node.
        ctx.uiConversation.events.register(secretRequestDefinition)
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: CARD_KIND }, SecretRequestCard),
        )
        // Replace the generic Tool row for this call so exactly one face shows.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, HiddenSecretToolRow),
        )

        // The reverse direction's entry button: the same list-slot shape the
        // vision-mode toggle uses, with the same reactive-state split (the
        // registration supplies identity and actions; live state rides a store).
        ctx.slots.inject(ATTACH_SLOT, () =>
          ctx.slots.register(
            {
              name: ATTACH_SLOT,
              id: 'secret-attach-toggle',
              order: 30,
              inject: () => ({
                open: () => setAttachMode({ kind: 'fill' }),
                close: () => setAttachMode({ kind: 'idle' }),
              }),
            },
            SecretAttachToggle,
          ),
        )
        // The capsule, floating above the composer card.
        ctx.slots.inject(CAPSULE_SLOT, () =>
          ctx.slots.register(
            {
              name: CAPSULE_SLOT,
              id: 'secret-attach-capsule',
              order: 10,
            },
            SecretAttachCapsule,
          ),
        )
        // Requirement 1 / O2: the side-car row under every human message that
        // carries a marker. Its own node kind and its own slot entry, so no
        // existing registration or component is edited to add it.
        ctx.uiConversation.events.register(secretAttachChipDefinition)
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: CHIP_KIND }, SecretAttachChipRow),
        )
        // Requirement 1 / O1: answer the transcript capsule's own open request.
        // The harness renders that capsule as a file reference and opens it
        // through the right column's tab registry, so a viewer registered for our
        // addresses is what turns that click into this plugin's detail page.
        ctx.inject(['sidebarRightTabs'], (scoped) => {
          const tabs = scoped.sidebarRightTabs
          if (tabs?.register === undefined) return
          const disposeType = tabs.register(secretAttachDetailDefinition)
          const bodySeat = ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: DETAIL_TAB_ID,
                inject: (sessionId: unknown) => ({ sessionId: typeof sessionId === 'string' ? sessionId : '' }),
              },
              AttachDetailTab,
            ),
          )
          // Both seats are read defensively: the registry's own disposer is what
          // takes the type out, and the slot seat is only released when it
          // really handed one back.
          const disposeBody = typeof bodySeat === 'function' ? (bodySeat as () => void) : undefined
          return () => {
            disposeBody?.()
            disposeType()
          }
        })
        // Every optional service is reached through cordis's own optional seat.
        // Reading one that this environment does not have would throw inside the
        // context proxy and fail this whole entry, so each one registers itself
        // only when it is really there, and the rest keeps working without it.
        ctx.inject(['locale'], (scoped) => {
          // A dictionary only helps when a locale face exists to read it; without
          // one the components fall back to their own literal table.
          const locale = scoped.locale
          if (locale?.register === undefined) return
          locale.register(ATTACH_NS, { zh: ATTACH_ZH, en: ATTACH_EN })
        })
        ctx.inject(['inputTriggers'], (scoped) => {
          // The reference source: codec for the model form, lexicon for the
          // decorated plain token, openReference for the click.
          const triggers = scoped.inputTriggers
          if (triggers?.registerSource === undefined) return
          triggers.registerSource(secretSource)
        })
        ctx.inject(['sessions'], (scoped) => {
          // The chip rung needs the session scope; without it the insertion
          // ladder simply starts one rung lower.
          const sessions = scoped.sessions
          if (sessions === undefined) return
          sessionsScope = (sessionId: string) => sessions.scope(sessionId)
          scoped.effect?.(() => () => {
            sessionsScope = null
          })
        })
      },
    }
  },
})
