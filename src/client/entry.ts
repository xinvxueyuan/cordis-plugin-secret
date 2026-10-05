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

const loader = (globalThis as unknown as { __ModuleLoader__?: ModuleLoaderTarget }).__ModuleLoader__

loader?.load({
  id: PACKAGE_ID,
  factory(require) {
    React = require('react') as ReactLike

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx: ClientContextLike) {
        ensureCardStyle()
        // The one visible interaction surface: this plugin's own chat node.
        ctx.uiConversation.events.register(secretRequestDefinition)
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: CARD_KIND }, SecretRequestCard),
        )
        // Replace the generic Tool row for this call so exactly one face shows.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, HiddenSecretToolRow),
        )
      },
    }
  },
})
