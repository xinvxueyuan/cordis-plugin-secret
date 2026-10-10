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
  /**
   * Present only for a management interaction: which action is waiting.
   *
   * A request-direction interaction carries none of these four fields, which is
   * exactly how the management card refuses to claim one (and vice versa).
   */
  readonly action?: 'unbind' | 'delete' | 'scope' | 'value'
  readonly target?: 'session' | 'store'
  readonly to?: Scope
  readonly expectValue?: boolean
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
  paste: '粘贴',
  pasteUnavailable: '当前浏览器不允许脚本读取剪贴板，请手动粘贴（在输入框里按 Ctrl/⌘+V）。',
  pasteDenied: '读取剪贴板被拒绝（可能缺少权限），请手动粘贴。',
  pasteEmpty: '剪贴板里没有可粘贴的文本。',
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
    // The four management fields. Read one by one and only when they are
    // well-formed, so a mangled payload can never make this card offer an
    // action the Host did not state.
    ...(record.action === 'unbind' || record.action === 'delete' || record.action === 'scope' || record.action === 'value'
      ? { action: record.action }
      : {}),
    ...(record.target === 'session' || record.target === 'store' ? { target: record.target } : {}),
    ...(scopeOf(record.to) === undefined ? {} : { to: scopeOf(record.to) as Scope }),
    ...(record.expectValue === true ? { expectValue: true } : {}),
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

/**
 * The attribute bag every text/password field this plugin renders carries.
 *
 * The fields that receive a secret value are why it exists: a browser or a
 * password-manager extension must never autofill one, offer to save one, or
 * remember what was typed into one. No single attribute does that, so this is a
 * deliberately redundant set, one layer per line of defence:
 *
 * - `autocomplete="new-password"`: the one hint the HTML spec has for exactly
 *   this case — MDN's "How to turn off form autocompletion" documents it for
 *   "a user [who] can specify a new password for another person" and records
 *   that plain `off` is *ignored* by modern browsers for login-like fields.
 * - **no `name` attribute**: MDN's own fallback advice when a browser keeps
 *   suggesting is to change the field's `name`; a field with no name and no
 *   owning form is not something a browser can key a credential on.
 * - **no `<form>` and no submit button anywhere in this plugin's UI**: those are
 *   the conditions MDN lists for a browser to offer autocompletion or to build a
 *   login out of the fields. The capsule and the cards are plain `div`s and
 *   every button in them is `type="button"`.
 * - the vendor ignore attributes, each named by its own vendor:
 *   `data-1p-ignore` (1Password: "use the `data-1p-ignore` or `data-op-ignore`
 *   attribute to tell 1Password it should ignore the field"), `data-lpignore`
 *   (LastPass), `data-bwignore` (Bitwarden), `data-form-type="other"`
 *   (Dashlane) and `data-protonpass-ignore` (Proton Pass — the only one of the
 *   five whose vendor documentation we could not reach, kept because an extra
 *   attribute costs nothing while a missed one costs a copied key).
 * - `spellcheck=false`, `autocorrect="off"`, `autocapitalize="off"`: a secret is
 *   an opaque string, so it must not be sent to a spell service or silently
 *   rewritten.
 *
 * The masked state keeps `type="password"` on purpose. The alternative, a text
 * field obfuscated with `-webkit-text-security`, is non-standard — MDN marks it
 * "not standardized … we do not recommend using non-standard features in
 * production … limited browser support" — so a browser that ignores it would
 * render the key in clear text, a worse failure than the capture this bag
 * closes. Masking stays with the browser's own password field; suppression
 * stays with the attributes above.
 *
 * One trade-off is recorded rather than hidden: on a `new-password` field
 * Chromium may offer to *generate* a password. That offer neither autofills a
 * stored credential nor reads the field, and ignoring it is harmless.
 */
const SECRET_FIELD_SUPPRESSION = {
  autoComplete: 'new-password',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  'data-protonpass-ignore': 'true',
} as const

/**
 * The second layer for a field that can hold a secret: it starts `readOnly` and
 * is released the moment it is focused.
 *
 * Autofill primes fields on load, before the human has done anything, and a
 * read-only field is not a fill candidate for that pass. Nothing is lost: a
 * field cannot be typed into without being focused first, and the focus handler
 * here is what makes it editable again. This is why the guard is a pair of
 * props rather than a `readOnly: true` on its own (which would make the field
 * unusable).
 */
function secretFieldGuards(): { readOnly: true; onFocus: (event: unknown) => void } {
  return {
    readOnly: true,
    onFocus: (event: unknown) => {
      const node = event as { currentTarget?: { readOnly?: boolean }; target?: { readOnly?: boolean } }
      const field = node.currentTarget ?? node.target
      if (field !== undefined && field !== null) field.readOnly = false
    },
  }
}

/**
 * The same bag for the two **identifier** fields (the credential key and the
 * title), with one deliberate difference: `autocomplete="off"` instead of
 * `new-password`.
 *
 * The first-hand reason is the Chrome team's own Autofill guide: for a field
 * whose value is unique every time and can never be reused — its example is a
 * one-time code, and the credential key and title are the same shape of value —
 * it says to use `autocomplete="off"`, because "the value is different every
 * time, and the browser should not save the value or offer autofill options".
 * The same page records the limit that makes `off` the wrong token for the four
 * *secret* fields: "even with `autocomplete="off"`, the browser will still offer
 * password autofill options so that these password management tools keep
 * working" — a `type="password"` field keeps its credential UI, which is why
 * those four keep `new-password`.
 *
 * `new-password` on a plain text field is not a "do not autofill" hint at all: it
 * is the sign-up hint that tells Chrome to offer *generating* a password, which
 * is exactly the kind of noise the user reported on these two fields.
 *
 * @see https://web.dev/learn/forms/autofill (Learn Forms: Autofill)
 * @see https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Turning_off_form_autocompletion
 */
const IDENTIFIER_FIELD_SUPPRESSION = {
  ...SECRET_FIELD_SUPPRESSION,
  autoComplete: 'off',
} as const

/**
 * The hygiene subset for a free-text box that can hold no secret (the card's
 * "other instruction" field): no spelling service, no autocorrection, and no
 * autocomplete — but not the password-manager ignore attributes, because there
 * is no credential here for a manager to capture.
 */
const PLAIN_TEXT_HYGIENE = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const

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
            ...SECRET_FIELD_SUPPRESSION,
            ...secretFieldGuards(),
            id: valueId,
            className: C.input,
            type: reveal ? 'text' : 'password',
            value,
            placeholder: TEXT.valuePlaceholder,
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
          // R2: the card's value field gets the suffix action too, writing through
          // `setValue`. R3 is not wired here: a paste into this card is the
          // *request* direction's approval input (`POST /api/secret.answer`), not
          // an attach, so "register it as a new secret" would be a different act.
          pasteAction({
            t: (key) => (TEXT as unknown as Record<string, string | undefined>)[key] ?? key,
            className: C.toggle,
            disabled: !answerable,
            setNotice: setError,
            apply: (text) => setValue(text),
          }),
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
          h(
            'div',
            { className: C.inputRow },
            h('textarea', {
              ...PLAIN_TEXT_HYGIENE,
              id: `dsh-secret-other-${callId}`,
              className: C.textarea,
              value: otherText,
              placeholder: TEXT.otherPlaceholder,
              disabled: !answerable,
              onChange: (event: { target: { value: string } }) => setOtherText(event.target.value),
            }),
            // R2 only: free-text instructions are prose, never material, so this
            // one gets the paste action and no classifier (R3's scope ruling).
            pasteAction({
              t: (key) => (TEXT as unknown as Record<string, string | undefined>)[key] ?? key,
              className: C.toggle,
              disabled: !answerable,
              setNotice: setError,
              apply: (text) => setOtherText(text),
            }),
          ),
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
/**
 * The composer's compact-control seat, rendered before the submit action.
 *
 * Declared by `dsh-client-ui-conversation` as `{ kind: 'list', scope: 'session' }`
 * (`lib/types/client/contract/slots.d.ts:235`, rendered at `lib/client.js:17532`),
 * and its occupants receive the Session's standard props — `inputActions` among
 * them (`…/contract/slots.d.ts:332-339`). That is the whole reason this seat can
 * act on the editor at all; see {@link SecretComposerPaste} for the boundary.
 */
const INPUT_RIGHT_SLOT = 'conversation.input.right'
/** Locale namespace of the attach surface, when the runtime has a locale face. */
const ATTACH_NS = 'secretAttach'
const ATTACH_PATH = '/api/secret.attach'
const RELEASE_PATH = '/api/secret.release'
const ATTACHED_PATH = '/api/secret.attached'
/**
 * The scope an attach takes when nothing on screen chose one.
 *
 * The fill form starts on it, and the selection conversion (R5), which has no
 * form at all, uses this very constant — so the two ways a secret enters a
 * session can never drift into two different defaults. Session scope is the
 * narrower of the two: nothing is written to the credential store unless a human
 * asks for it.
 */
const DEFAULT_ATTACH_SCOPE: Scope = 'session'
/** Read-only history of this session's attachments and authorizations. */
const HISTORY_PATH = '/api/secret.history'
/** Every secret this session may use, plus what the credential store holds. */
const AVAILABLE_PATH = '/api/secret.available'
/** Register one durably stored secret for this session (the `@` menu's pick). */
const ADOPT_PATH = '/api/secret.adopt'
/**
 * The management surface: one path, two methods.
 *
 * GET lists (value-free); POST performs exactly one action, named by a closed
 * enum in the body. That closed enum is what keeps "从本会话移除" and "从凭据库
 * 真删" as separate wire actions rather than one action with a flag.
 */
const MANAGE_PATH = '/api/secret.manage'
/** The agent tool the management card belongs to. */
const MANAGE_TOOL_NAME = 'secret_manage'
/** Chat node kind of the management card. */
const MANAGE_CARD_KIND = 'sr-manage'
/** Value-free settlement payload kind the Host persists for that tool. */
const MANAGE_META_KIND = 'secret-manage'
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
  toggleConvert: '转为密钥',
  toggleConvertHint: '把选中的文本登记为本次会话的密钥，并把该段替换为标记胶囊（明文仍只交给宿主，不进入对话）',
  convertDone: '已登记，选中文本已替换为标记胶囊',
  convertManual: '已登记，但编辑器拒绝了自动替换；请在详情面用「插入到光标处」手工插入标记',
  fillTitle: '附加一枚密钥',
  detailTitle: '随这条消息附加的密钥',
  keyLabel: '凭据键',
  keyPlaceholder: '留空则由 AI 命名',
  keyHint: '可选：留空则由 AI 依据标题与值的形态推断（不含明文）；也可自己写小写 kebab/snake，例如 openai、openai-key',
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
  paste: '粘贴',
  pasteUnavailable: '当前浏览器不允许脚本读取剪贴板，请手动粘贴（在输入框里按 Ctrl/⌘+V）。',
  pasteDenied: '读取剪贴板被拒绝（可能缺少权限），请手动粘贴。',
  pasteEmpty: '剪贴板里没有可粘贴的文本。',
  // The insert side's own message. The clipboard read has already succeeded by
  // the time this one is shown, so it must not blame the clipboard; it names the
  // two things that actually failed (no scripted-insert capability, or nowhere to
  // put the text) and still tells the human how to get it in.
  pasteInsertFailed: '无法把内容插入输入框（编辑器不支持脚本插入，或当前没有可插入的光标位置），请手动粘贴（按 Ctrl/⌘+V）。',
  // D2: what happens after a paste the rules recognise. The lead is a question,
  // and the two answers are the two buttons — no timer, no toast.
  pasteAskLabel: '粘贴确认',
  pasteAskLead: '这段内容看起来像密钥。要登记为密钥，还是按普通文本粘贴？',
  pasteAskRegister: '登记为密钥',
  pasteAskText: '按普通文本粘贴',
  // (3): the click's first answer. The browser's permission prompt can hold
  // `readText()` for a while; without this the button looks dead.
  pasteReading: '正在读取剪贴板…',
  // t46: the composer's own takeover. The shape line is a rule name and a
  // length — a sanitized token, never a fragment of what was pasted.
  composerAskLabel: '粘贴确认',
  composerAskLead: '这段内容看起来像密钥，要转为密钥吗？',
  composerAskRegister: '转为密钥',
  composerAskShape: '形状',
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
  chipRemove: '移除',
  chipRemoveHint: '移除即解绑：从本会话移除这条登记，凭据库里的持久记录保持不变',
  chipRemoveStaged: '已丢弃尚未发送的登记',
  chipRemoveBound: '已从本会话解绑；凭据库未改动',
  chipRemoveGone: '这条在本会话里已经不存在了，未做任何改动',
  chipRemoveFailed: '未能移除，未做任何改动',
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
  // Round 5: the management surface. Every action says what it will do to which
  // half, because that is the distinction the two deletion tiers depend on.
  manageLink: '管理',
  manageTitle: '管理密钥（本会话与凭据库）',
  manageReading: '正在读取管理列表…',
  manageUnavailable: '暂时无法读取管理列表（「读不到」不等于「没有」）。',
  manageEmpty: '本会话与凭据库里都没有可管理的变量。',
  manageSectionSession: '本会话可用',
  manageSectionStore: '凭据库（持久）',
  manageNotice: '这里只显示变量名与元数据：值只在人类输入时存在，永不显示也永不回显。真删会同时删除凭据库里的值与授权标记，不可恢复。',
  manageSourceSession: '本会话',
  manageSourceStore: '凭据库',
  manageSourceBoth: '本会话 + 凭据库',
  manageOriginAttach: '人工附加',
  manageOriginRequest: 'Agent 索要',
  manageStateStaged: '已登记，等待发送',
  manageStateBound: '已绑定到消息',
  manageStateAuthorized: '已授权（Agent 经 secret_request 获得）',
  manageStateStored: '仅在凭据库',
  manageActValue: '改值',
  manageActScopeUp: '升为持久',
  manageActScopeDown: '仅改为本会话（保留库中记录）',
  manageActUnbind: '解绑',
  manageActDelete: '不再持久，并从库中删除',
  manageNone: '这条目前没有可执行的管理动作。',
  manageDone: '已完成：',
  manageScopeUpLead: '将把本会话当前持有的值写入凭据库，并把这份记录改为持久保存。',
  manageScopeUpCurrent: '当前值（掩码显示，永不回显）：',
  manageDeleteLead: '这会删除凭据库里的值与授权标记，所有会话都将再也用不到它，且不可恢复；本会话内存里那一份继续可用，作用域会如实降为「仅本次会话」。',
  editTitleSession: '改本会话这份值',
  editTitleStore: '改凭据库里的值',
  editValueLabel: '新密钥内容',
  editValuePlaceholder: '粘贴新的密钥…',
  editHintSession: '只替换本会话内存里的这一份，凭据库不动；变量名、作用域与锚点都不变。',
  editHintStore: '写入凭据库并重提授权标记；本会话里的那一份也会同步替换。',
  editApply: '写入',
  editNoValue: '请先填入新的密钥内容。',
  editFailed: '这次改值失败，未做任何改动。',
  editUnreachable: '暂时无法连接宿主，未做任何改动。',
  dangerUnbindTitle: '从本会话移除这个变量？',
  dangerUnbindBody: '只影响本会话：变量立刻不再注入。凭据库里的记录不动，之后还可以再登记回来。',
  dangerDeleteTitle: '从凭据库真删这条记录？',
  dangerDeleteBody: '会删除凭据库里的值与授权标记：所有会话都将再也用不到它，且不可恢复。本会话内存里那一份仍然保留，但作用域会如实降为「仅本次会话」。',
  dangerConfirmUnbind: '解绑',
  dangerConfirmDelete: '不再持久，并从库中删除',
  evUpdated: '值已改（人类输入）',
  evScopeChanged: '作用域已改',
  evUnbound: '已从本会话移除',
  evDeleted: '已从凭据库删除',
  sourceManage: '管理',
  reportUnbind: '已从本会话移除；凭据库未改动。',
  reportDelete: '已从凭据库删除这条记录（值与授权标记）。',
  reportScopeUp: '已升为持久保存；本会话这份值已写入凭据库。',
  reportScopeDown: '已降为仅本次会话；凭据库里的记录保留（要连记录一起删，请用「真删」）。',
  reportValueSession: '本会话这份值已改（人类输入）。',
  reportValueStore: '凭据库里的值已改，本会话这份已同步。',
}
const ATTACH_EN: Record<string, string> = {
  toggle: 'Attach secret',
  toggleOpen: 'Close attach panel',
  toggleHint: 'Attach a secret to this message: the value stays out of the conversation and the agent only receives the variable name',
  toggleConvert: 'Turn into a secret',
  toggleConvertHint: 'Register the selected text as a secret of this session and replace it with the reference marker (the value still goes only to the host, never into the conversation)',
  convertDone: 'Registered; the selected text is now a reference marker',
  convertManual: 'Registered, but the editor refused the replacement; insert the marker from the details face',
  fillTitle: 'Attach a secret',
  detailTitle: 'Secret attached to this message',
  keyLabel: 'Credential key',
  keyPlaceholder: 'Leave empty to let AI name it',
  keyHint: 'Optional: leave it empty and AI infers one from the title and the value shape (never the plaintext); or write lowercase kebab/snake, e.g. openai or openai-key',
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
  paste: 'Paste',
  pasteUnavailable: 'This browser does not let the page read the clipboard. Paste by hand instead (press Ctrl/⌘+V in the field).',
  pasteDenied: 'Reading the clipboard was refused (a permission may be missing). Paste by hand instead.',
  pasteEmpty: 'The clipboard holds no text to paste.',
  pasteInsertFailed: 'Could not insert the text into the composer (this editor does not accept scripted insertion, or there is no caret to insert at). Paste by hand instead (press Ctrl/⌘+V).',
  pasteAskLabel: 'Paste confirmation',
  pasteAskLead: 'This looks like a secret. Register it as a key, or paste it as plain text?',
  pasteAskRegister: 'Register as a key',
  pasteAskText: 'Paste as plain text',
  pasteReading: 'Reading the clipboard…',
  composerAskLabel: 'Paste confirmation',
  composerAskLead: 'This looks like a secret. Turn it into a key?',
  composerAskRegister: 'Turn into a key',
  composerAskShape: 'shape',
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
  chipRemove: 'Remove',
  chipRemoveHint: 'Removing here means unbinding: this session loses the record, the durable credential-store entry stays as it is',
  chipRemoveStaged: 'Discarded the staged record before it was sent',
  chipRemoveBound: 'Unbound from this session; the credential store is unchanged',
  chipRemoveGone: 'This session no longer holds it; nothing was changed',
  chipRemoveFailed: 'Not removed; nothing was changed',
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
  manageLink: 'Manage',
  manageTitle: 'Manage secrets (this session and the credential store)',
  manageReading: 'Reading the management list…',
  manageUnavailable: 'The management list cannot be read right now (unreadable is not the same as empty).',
  manageEmpty: 'Neither this session nor the credential store holds anything to manage.',
  manageSectionSession: 'Usable in this session',
  manageSectionStore: 'Credential store (durable)',
  manageNotice: 'Only variable names and metadata are shown here: a value exists only while a human types it, and is never displayed or echoed. A real delete removes both the stored value and its authorization marker, irreversibly.',
  manageSourceSession: 'This session',
  manageSourceStore: 'Credential store',
  manageSourceBoth: 'This session + credential store',
  manageOriginAttach: 'Attached by a human',
  manageOriginRequest: 'Requested by the agent',
  manageStateStaged: 'Registered, waiting to be sent',
  manageStateBound: 'Bound to a message',
  manageStateAuthorized: 'Authorized (obtained by the agent through secret_request)',
  manageStateStored: 'In the credential store only',
  manageActValue: 'Change value',
  manageActScopeUp: 'Make durable',
  manageActScopeDown: 'Make session-only (keep the record)',
  manageActUnbind: 'Unbind',
  manageActDelete: 'Stop being durable and delete it',
  manageNone: 'Nothing can be managed for this row right now.',
  manageDone: 'Done: ',
  manageScopeUpLead: 'This writes the value this session currently holds into the credential store, and makes this record durable.',
  manageScopeUpCurrent: 'Current value (masked, never echoed):',
  manageDeleteLead: 'This deletes the stored value and its authorization marker: no session can use it again, and it cannot be recovered. The copy in this session’s memory keeps working, and its scope is reported as “this session only”.',
  editTitleSession: 'Change this session’s value',
  editTitleStore: 'Change the stored value',
  editValueLabel: 'New secret value',
  editValuePlaceholder: 'Paste the new secret…',
  editHintSession: 'Replaces only this session’s in-memory copy; the credential store is untouched. The variable name, scope and anchor all stay the same.',
  editHintStore: 'Writes to the credential store and re-commits the authorization marker; this session’s copy is replaced too.',
  editApply: 'Write',
  editNoValue: 'Enter the new secret value first.',
  editFailed: 'This change failed; nothing was modified.',
  editUnreachable: 'The host is unreachable; nothing was modified.',
  dangerUnbindTitle: 'Remove this variable from this session?',
  dangerUnbindBody: 'This session only: the variable stops being injected immediately. The credential-store record is untouched and can be registered again later.',
  dangerDeleteTitle: 'Delete this record from the credential store?',
  dangerDeleteBody: 'This removes the stored value and its authorization marker: no session can use it again, and it cannot be recovered. The copy still held in this session’s memory stays usable, but its scope is reported as “this session only”.',
  dangerConfirmUnbind: 'Unbind',
  dangerConfirmDelete: 'Stop being durable and delete it',
  evUpdated: 'Value changed (human input)',
  evScopeChanged: 'Scope changed',
  evUnbound: 'Removed from this session',
  evDeleted: 'Deleted from the credential store',
  sourceManage: 'managed',
  reportUnbind: 'Removed from this session; the credential store is untouched.',
  reportDelete: 'Deleted this record (value and authorization marker) from the credential store.',
  reportScopeUp: 'Now durable; this session’s value was written to the credential store.',
  reportScopeDown: 'Now session-only; the credential-store record is kept (use the real deletion to remove it).',
  reportValueSession: 'This session’s value was changed (human input).',
  reportValueStore: 'The stored value was changed, and this session’s copy now matches it.',
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
  // A `<label>` that wraps the visible caption and the control, so the control
  // needs no `id` and the caption no `for`: implicit association.
  fieldGroup: `${AP}_fieldGroup`,
  label: `${AP}_label`,
  input: `${AP}_input`,
  inputRow: `${AP}_inputRow`,
  seat: `${AP}_seat`,
  seatNotice: `${AP}_seatNotice`,
  seatOffer: `${AP}_seatOffer`,
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
  chipPillGroup: `${AP}_chipPillGroup`,
  chipRemove: `${AP}_chipRemove`,
  toggleWrap: `${AP}_toggleWrap`,
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
.${A.toggleWrap}{align-items:center;gap:6px;display:inline-flex}
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
.${A.fieldGroup}{flex:auto;flex-direction:column;gap:6px;display:flex;min-width:0}
.${A.label}{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.${A.inputRow}{align-items:flex-end;gap:8px;display:flex}
/* D1: the identifier rows hold a caption+control column beside the action button.
   Centering would center the button against the caption too, which is half a line
   higher than the control it belongs to. The controls in these rows are all the
   same 32px tall, so bottom-aligning the row puts the button exactly on the
   control's own box — no magic offsets, and every row agrees. */
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
/* (2): the composer seat's notice must never move the button it belongs to. It
   is taken out of the row's flow (absolute, hanging to the left of the button)
   so appearing and disappearing change nothing about where the button sits. */
.${A.seat}{position:relative;display:inline-flex;align-items:center}
.${A.seatNotice}{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:6px 10px;position:absolute;right:calc(100% + 8px);top:50%;transform:translateY(-50%);width:max-content;max-width:min(60vw,420px);overflow-wrap:anywhere}
/* t46: the composer's paste offer. Same discipline as the notice above: out of
   the row's flow, so it cannot move the button it belongs to. */
.${A.seatOffer}{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);bottom:0;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;padding:8px 10px;position:absolute;right:calc(100% + 8px);width:max-content;max-width:min(70vw,520px);overflow-wrap:anywhere}
.${A.seatOffer} .${A.notice}{background:0 0;padding:0}
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
.${A.chipPillGroup}{align-items:center;gap:2px;display:inline-flex}
.${A.chipRemove}{background:0 0;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;line-height:18px;padding:0 4px;visibility:hidden}
.${A.chipPillGroup}:hover .${A.chipRemove},
.${A.chipPillGroup}:focus-within .${A.chipRemove},
.${A.chipRemove}:focus-visible{visibility:visible}
.${A.chipRemove}:hover{color:var(--dsw-alias-state-error-primary)}
.${A.chipRemove}:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-radius:var(--dsw-radius-xs)}
.${A.chipRemove}:disabled{cursor:default;opacity:.55}
@media (hover:none){.${A.chipRemove}{visibility:visible}}
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
  readonly source: 'attach' | 'request' | 'manage'
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
  'updated',
  'scope-changed',
  'unbound',
  'deleted',
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
/**
 * Which actions the Host proved are possible for one management row.
 *
 * All four are false unless the payload said otherwise: a shape this page
 * cannot read must not become an offer to do something.
 */
interface ManageCan {
  readonly unbind: boolean
  readonly delete: boolean
  readonly scope: boolean
  readonly value: boolean
}
/** One row of the management list. Never carries a value. */
interface ManageEntry {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: Scope
  readonly state: 'staged' | 'bound' | 'authorized' | 'stored'
  readonly source: 'session' | 'store' | 'both'
  /**
   * Which session-side direction put this row there. Absent for a store-only row
   * (no session side) and for a payload from a Host that predates the field.
   */
  readonly origin?: 'attach' | 'request'
  readonly can: ManageCan
}
/** The two halves one management action can address. */
type ManageTarget = 'session' | 'store'
/** The two destructive questions the danger face can ask. */
type ManageDanger = 'unbind' | 'delete'
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
  /** The reference occurrences of the draft, in clipboard-text coordinates. */
  readonly occurrences?: unknown
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
  /**
   * The management face: two sections (this session, the credential store),
   * each row offering only the actions the Host said are possible.
   */
  | { readonly kind: 'manage' }
  /**
   * The masked value form, for the one action whose material a human supplies.
   * `target` names which half of the variable the new value replaces.
   */
  | { readonly kind: 'edit'; readonly variable: string; readonly target: ManageTarget }
  /** The confirmation one destructive action needs before it runs. */
  | { readonly kind: 'danger'; readonly variable: string; readonly act: ManageDanger }

/** Attached secrets per session. Values are never stored here. */
const attachedBySession = new Map<string, Map<string, AttachedMeta>>()
/**
 * Sessions whose attachment list this page has really read from the host.
 *
 * It separates "the host answered and this session no longer holds it" from
 * "this page never asked". The side-car row's ✕ removes a capsule from the row,
 * so the row may only stop rendering one on positive evidence: a record it knows
 * to be `withdrawn`, or a variable absent from a list the host itself answered.
 * Hiding on ignorance would let a failed or never-attempted read erase a capsule.
 */
const attachedKnown = new Set<string>()
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
/** The one idle answer, so every "closed" read is the same object. */
const IDLE_MODE: AttachMode = { kind: 'idle' }
/** The live mode **and the session it was opened in** (D4b). */
let attachMode: { readonly sessionId: string | null; readonly mode: AttachMode } | null = null
const modeListeners = new Set<() => void>()
/**
 * The session the visible view belongs to, as observed by our own components
 * during render (D4b). One conversation view is mounted at a time, so this is the
 * session a click handler is acting for.
 */
let observedSession: string | null = null

/**
 * Read the live mode for one session.
 *
 * The mode carries the session it was opened in: a mode opened in another session
 * is *not* the current mode, so a remount in session B cannot draw the panel that
 * session A left open. With no session to check against — or a mode stored before
 * any session was observed — the stored mode is the answer, which is the
 * behaviour every existing caller already had.
 */
function currentMode(sessionId?: string): AttachMode {
  if (attachMode === null) return IDLE_MODE
  if (sessionId === undefined || attachMode.sessionId === null) return attachMode.mode
  return attachMode.sessionId === sessionId ? attachMode.mode : IDLE_MODE
}

/**
 * Observe which session the visible view belongs to, and drop a mode left over
 * from another one (D4b).
 *
 * Called **during render** by the session-scoped components: that is the only
 * moment this plugin gets before the new session's first frame, and the whole
 * point is that the new session must not draw the previous session's panel even
 * once. For that reason the clear is **silent** — it does not wake
 * `modeListeners`, which would mean updating other components' state in the middle
 * of rendering this one. It does not need to: every read in this same render goes
 * through `currentMode(sessionId)` and sees the cleared value anyway.
 */
function noteActiveSession(sessionId: string): void {
  if (observedSession === sessionId) return
  const previous = observedSession
  observedSession = sessionId
  if (previous === null || attachMode === null) return
  if (attachMode.sessionId !== null && attachMode.sessionId !== sessionId) attachMode = null
}

/**
 * Move the capsule between faces and wake every subscriber.
 *
 * A mode that is already bound to a session stays bound to it (every face
 * transition happens inside that session); a mode opened with no session at hand
 * takes the observed one, which is how the shell's own `open`/`close` callbacks —
 * invoked for the visible view — still bind the panel to a session (D4b).
 */
function setAttachMode(next: AttachMode): void {
  // A mode already bound to the session currently being observed stays bound to
  // it (every face transition happens inside that session). Anything else — a
  // mode stored before any view was observed, or a leftover from a session that
  // is no longer the observed one — is re-bound to what is observed now, so a
  // foreign session's identity can never be inherited by a later panel (D4b).
  const bound =
    attachMode !== null && attachMode.sessionId !== null && attachMode.sessionId === observedSession
      ? attachMode.sessionId
      : observedSession
  attachMode = { sessionId: bound, mode: next }
  for (const listener of [...modeListeners]) listener()
}

/** Open or close the panel for a session the caller knows first-hand. */
function setAttachModeFor(sessionId: string, next: AttachMode): void {
  attachMode = { sessionId, mode: next }
  for (const listener of [...modeListeners]) listener()
}

/**
 * Forget which session the view belongs to. Called when there is no view (the
 * test harness tears one down between cases), so a later panel cannot inherit the
 * previous session's identity.
 */
function resetSessionObservation(): void {
  observedSession = null
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

/** One attach attempt's outcome, exactly as the host answered it. */
type AttachAttempt =
  | { readonly ok: true; readonly variable: string; readonly scope: Scope }
  | { readonly ok: false; readonly error: string }

/**
 * Register one secret for this session: the one route a value leaves this file.
 *
 * Two callers use it — the fill form (where a human typed the value) and the
 * selection conversion (R5, where the value is the text the human selected) — and
 * both must send exactly the same thing: the field-validated body, this plugin's
 * own fixed failure sentences (never the host's text, which can quote a value),
 * and the same reading of the answer. An empty `name` is legal (R1): the host
 * settles the key itself, from a local rule and a deadline-bounded model
 * suggestion, and reports the variable it settled on.
 */
async function postAttach(input: {
  readonly sessionId: string
  readonly name: string
  readonly label: string
  readonly scope: Scope
  readonly value: string
}): Promise<AttachAttempt> {
  try {
    const response = await fetch(ATTACH_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: input.sessionId,
        name: input.name,
        label: input.label,
        scope: input.scope,
        value: input.value,
      }),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) return { ok: false, error: attachErrorFor(response.status) }
    const accepted = readAttachResponse(payload)
    if (accepted === null) return { ok: false, error: ATTACH_FAILURE_UNKNOWN }
    return { ok: true, variable: accepted.variable, scope: accepted.scope }
  } catch {
    return { ok: false, error: ATTACH_UNREACHABLE }
  }
}

/**
 * Write one freshly registered record into this page's own map, exactly as the
 * fill form always has: the new record takes the variable's slot over, so a
 * withdrawal timer armed for a replaced record can never fire against this one,
 * and "seen in the draft" stays false until the observer reports the marker.
 */
function noteStaged(sessionId: string, variable: string, name: string, label: string, scope: Scope): void {
  const map = sessionAttachments(sessionId)
  const known = map.get(variable)
  map.set(variable, {
    variable,
    name,
    label: label === '' ? name : label,
    scope,
    state: 'staged',
    createdAt: Date.now(),
    generation: known === undefined ? 0 : known.generation + 1,
    seenPresent: false,
  })
  publishAttached()
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
    // The host really answered for this session: from here on, "not in the map"
    // is evidence that the session no longer holds the variable (the side-car
    // row's own visibility rule reads this).
    attachedKnown.add(sessionId)
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
  updated: 'evUpdated',
  'scope-changed': 'evScopeChanged',
  unbound: 'evUnbound',
  deleted: 'evDeleted',
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
    entry.source === 'request' ? t('sourceRequest') : entry.source === 'manage' ? t('sourceManage') : t('sourceAttach'),
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
  const source = record.source === 'attach' ? 'attach' : record.source === 'request' ? 'request' : record.source === 'manage' ? 'manage' : undefined
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

/**
 * The last management list this page read, per session. Never a value.
 *
 * Kept apart from the `@` menu's list on purpose: that one collapses a variable
 * that is both session-side and durable into a single session row, while the
 * management surface has to show both sides of it and say which actions the
 * Host proved each side supports.
 */
const manageBySession = new Map<string, readonly ManageEntry[]>()
const manageInFlight = new Map<string, Promise<readonly ManageEntry[]>>()
/** Whether the last management read failed (fixed wording, never a false empty). */
const manageUnavailable = new Set<string>()
/** The last management action's own report, shown once in the manage face. */
let manageReport: string | null = null

/** Read one management row. Anything unreadable is dropped, never guessed at. */
function readManageEntry(raw: unknown): ManageEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const variable = text(record.variable)
  const name = text(record.name)
  const label = text(record.label)
  const scope = scopeOf(record.scope)
  const state =
    record.state === 'staged' || record.state === 'bound' || record.state === 'authorized' || record.state === 'stored'
      ? record.state
      : undefined
  const source =
    record.source === 'session' || record.source === 'store' || record.source === 'both'
      ? record.source
      : undefined
  const origin = record.origin === 'attach' || record.origin === 'request' ? record.origin : undefined
  if (variable === undefined || name === undefined || label === undefined) return null
  if (scope === undefined || state === undefined || source === undefined) return null
  let can: ManageCan = { unbind: false, delete: false, scope: false, value: false }
  if (typeof record.can === 'object' && record.can !== null && !Array.isArray(record.can)) {
    const raw = record.can as Record<string, unknown>
    // True only on an explicit `true`: every other shape means "not proven",
    // which is the safe direction for an action that changes durable state.
    can = {
      unbind: raw.unbind === true,
      delete: raw.delete === true,
      scope: raw.scope === true,
      value: raw.value === true,
    }
  }
  // An unreadable `origin` is simply absent: which direction a row came from is
  // information, not an action, so dropping it cannot offer anything that fails.
  return { variable, name, label, scope, state, source, ...(origin === undefined ? {} : { origin }), can }
}

/** Read the host's management answer. A malformed payload answers null. */
function readManageList(payload: unknown): readonly ManageEntry[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.ok !== true || !Array.isArray(record.entries)) return null
  const out: ManageEntry[] = []
  for (const raw of record.entries) {
    const entry = readManageEntry(raw)
    if (entry !== null) out.push(entry)
  }
  return out
}

/**
 * The one-line provenance of a management row, from the same literal table.
 *
 * The direction (a human attached it, or the agent asked for it) comes first
 * when the row has one: "usable in this session" covers two different stories,
 * and a reader must be able to tell which one they are looking at.
 */
function describeManage(entry: ManageEntry): string {
  const source =
    entry.source === 'both'
      ? ATTACH_ZH.manageSourceBoth ?? ''
      : entry.source === 'store'
        ? ATTACH_ZH.manageSourceStore ?? ''
        : ATTACH_ZH.manageSourceSession ?? ''
  const origin =
    entry.origin === 'request'
      ? ATTACH_ZH.manageOriginRequest ?? ''
      : entry.origin === 'attach'
        ? ATTACH_ZH.manageOriginAttach ?? ''
        : undefined
  const state =
    entry.state === 'bound'
      ? ATTACH_ZH.manageStateBound ?? ''
      : entry.state === 'staged'
        ? ATTACH_ZH.manageStateStaged ?? ''
        : entry.state === 'authorized'
          ? ATTACH_ZH.manageStateAuthorized ?? ''
          : ATTACH_ZH.manageStateStored ?? ''
  const scope = entry.scope === 'persistent' ? ATTACH_ZH.persistent ?? '' : ATTACH_ZH.session ?? ''
  return [...(origin === undefined ? [] : [origin]), source, scope, state].join(' · ')
}

/** Read the host's management list for one session (never a cached lie on failure). */
async function refreshManage(sessionId: string): Promise<readonly ManageEntry[]> {
  if (sessionId === '') return []
  const inFlight = manageInFlight.get(sessionId)
  if (inFlight !== undefined) return inFlight
  const run = (async (): Promise<readonly ManageEntry[]> => {
    try {
      const response = await fetch(`${MANAGE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        manageUnavailable.add(sessionId)
        publishAttached()
        return manageBySession.get(sessionId) ?? []
      }
      const list = readManageList(await response.json())
      if (list === null) {
        manageUnavailable.add(sessionId)
        publishAttached()
        return manageBySession.get(sessionId) ?? []
      }
      manageUnavailable.delete(sessionId)
      manageBySession.set(sessionId, list)
      publishAttached()
      return list
    } catch {
      manageUnavailable.add(sessionId)
      publishAttached()
      return manageBySession.get(sessionId) ?? []
    } finally {
      manageInFlight.delete(sessionId)
    }
  })()
  manageInFlight.set(sessionId, run)
  return run
}

/** The management list this page last read for one session (empty when it never did). */
function manageOf(sessionId: string): readonly ManageEntry[] {
  return manageBySession.get(sessionId) ?? []
}

/** Whether the last management read for this session failed. */
function manageFailed(sessionId: string): boolean {
  return manageUnavailable.has(sessionId)
}

/** Whether this page has ever completed a management read for one session. */
function manageRead(sessionId: string): boolean {
  return manageBySession.has(sessionId)
}

/** One management action's outcome, as the poster reports it. */
interface ManageAttempt {
  readonly ok: boolean
  readonly status: number
  readonly notice?: string
  readonly error?: string
}

/** The fixed sentence one refused management action reports. */
const MANAGE_FAILURE: Record<number, string> = {
  400: '这次请求的字段不合法，未做任何改动。',
  404: '目标已经不在（本会话或凭据库里都没有它），未做任何改动。',
  409: '目标状态已经变了，未做任何改动。',
  500: '宿主未能完成这次改动，未做任何改动。',
  501: '当前凭据库实现不提供删除能力，未做任何改动。',
}
const MANAGE_FAILURE_UNKNOWN = '宿主拒绝了这次管理动作，未做任何改动。'
const MANAGE_UNREACHABLE = '暂时无法连接宿主，未做任何改动。'

function manageErrorFor(status: number): string {
  return MANAGE_FAILURE[status] ?? MANAGE_FAILURE_UNKNOWN
}

/**
 * Post one management action.
 *
 * The host's own error text is never echoed (the same rule the attach face
 * follows): a credential backend's message can quote the value it was handed,
 * and one rule with no exceptions is easier to keep. A body this half cannot
 * read counts as a refusal, never as success.
 */
async function postManage(body: Record<string, unknown>): Promise<ManageAttempt> {
  try {
    const response = await fetch(MANAGE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      return { ok: false, status: response.status, error: manageErrorFor(response.status) }
    }
    const payload: unknown = await response.json().catch(() => undefined)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { ok: false, status: 0, error: MANAGE_FAILURE_UNKNOWN }
    }
    const record = payload as Record<string, unknown>
    if (record.ok !== true) {
      return { ok: false, status: 0, error: MANAGE_FAILURE_UNKNOWN }
    }
    const notice = text(record.notice)
    return { ok: true, status: response.status, ...(notice === undefined ? {} : { notice }) }
  } catch {
    return { ok: false, status: 0, error: MANAGE_UNREACHABLE }
  }
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
  setAttachModeFor(sessionId, { kind: 'confirm', variable: pick.v, name })
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

/**
 * The selection the editor is holding right now, or null when it holds none.
 *
 * `captureInsertion()` is the only public way to see a selection, and a collapsed
 * caret is reported as `start === end`, so a range is exactly `start !== end` (a
 * caret at the end of a draft and "no selection at all" are the same fact here).
 * The read is total: a missing action, a host shape this half cannot read and a
 * throwing editor all answer "no selection" instead of escaping — the caller is a
 * click handler, and an exception there would be an uncaught rejection.
 */
function selectedSpan(actions: InputActionsLike | undefined): TokenSpanLike | null {
  try {
    const span = readSpan(actions?.captureInsertion?.())
    if (span === null || span.start === span.end) return null
    return span
  } catch {
    return null
  }
}

/** One chip's two projections, as this half reads them off `InputState`. */
interface OccurrenceView {
  readonly offset: number
  readonly length: number
}

/**
 * The text one selection names, or null when the conversion cannot be trusted.
 *
 * `captureInsertion()` speaks **detect-projection** offsets (`chip = one U+FFFC`)
 * while `InputState.draft` is the **clipboard projection** (`chip = its
 * clipboardText`), so the span has to be folded back before `slice` can be
 * right (the design's §11.2 formula). The two texts agree character for
 * character outside chips, so the fold is exact once the chips before the
 * selection are known.
 *
 * Null — never a guess — when anything does not line up: an occurrence this half
 * cannot read, a chip whose two lengths disagree, a chip inside the selection
 * (that selection is not plain text), a negative offset, an end past the draft,
 * or a length that does not survive the fold. The caller then keeps the
 * original 「附密钥」 behaviour instead of registering the wrong bytes.
 */
function selectedTextIn(draft: string, occurrences: readonly unknown[], span: TokenSpanLike): string | null {
  if (span.end <= span.start) return null
  const chips: OccurrenceView[] = []
  for (const raw of occurrences) {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as { readonly offset?: unknown; readonly length?: unknown; readonly clipboardText?: unknown }
    const offset = record.offset
    const length = record.length
    if (typeof offset !== 'number' || typeof length !== 'number') return null
    if (!Number.isInteger(offset) || !Number.isInteger(length)) return null
    if (offset < 0 || length < 1) return null
    // The length the occurrence declares is the length of its clipboard form:
    // anything else means this half is not reading the shape it was written for.
    if (typeof record.clipboardText !== 'string' || record.clipboardText.length !== length) return null
    chips.push({ offset, length })
  }
  chips.sort((a, b) => a.offset - b.offset)
  // A chip occupies one U+FFFC in detect space and `length` characters in the
  // clipboard text, so everything after the k-th chip is shifted by the sum of
  // the chips before it.
  const detectAt: number[] = []
  let carried = 0
  for (const chip of chips) {
    const at = chip.offset - carried
    if (at < 0) return null
    detectAt.push(at)
    carried += chip.length - 1
  }
  let shiftStart = 0
  let shiftEnd = 0
  for (const [index, chip] of chips.entries()) {
    const at = detectAt[index] ?? 0
    if (at >= span.start && at < span.end) return null
    if (at < span.start) shiftStart += chip.length - 1
    if (at < span.end) shiftEnd += chip.length - 1
  }
  const start = span.start + shiftStart
  const end = span.end + shiftEnd
  if (start < 0 || end > draft.length) return null
  if (end - start !== span.end - span.start) return null
  const text = draft.slice(start, end)
  if (text.length === 0 || text.includes('\uFFFC')) return null
  return text
}

/**
 * The contract-external live cue for the label, isolated into one total function.
 *
 * The seat publishes **no** selection change (moving a caret neither bumps the
 * draft revision nor publishes `InputState`), so "the label follows the selection
 * while nothing is pressed" cannot be built on the contract at all. This is the
 * whole of the out-of-contract part: a DOM `selectionchange` listener may ask
 * *this*, and this only ever answers a boolean for the label. It answers `null`
 * — "no cue" — for everything unsupported or throwing, and it never decides
 * behaviour: the click reads the editor itself.
 */
function liveSelectionCue(actions: InputActionsLike | undefined, editableFocused: boolean): boolean | null {
  try {
    // Nothing editable focused is not "nothing selected": it is no information,
    // and a cue that is absent must never clear a label the press already set.
    if (!editableFocused) return null
    return selectedSpan(actions) !== null
  } catch {
    return null
  }
}

/**
 * Whether the focused element is an editable — the composer's own editor shape.
 *
 * This is the tightest scope a component with no DOM reference of its own can
 * apply: it keeps the cue from reacting to a selection made in ordinary prose.
 * Reading `document.activeElement` is not reading anyone's selection; the
 * selection itself only ever comes from the public `captureInsertion()`.
 */
function editableFocused(): boolean {
  try {
    const active = document.activeElement as
      | (Element & { readonly isContentEditable?: boolean; readonly tagName?: string })
      | null
    if (active === null || active === undefined) return false
    if (active.isContentEditable === true) return true
    return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT'
  } catch {
    return false
  }
}

/**
 * The selection the last press saw, waiting for its own click.
 *
 * A press and the click it produces are one gesture, and the contract only lets
 * this plugin observe the selection at the moment of an action — so the press
 * reads it and the click resolves against that reading, never against a value a
 * render forgot. Module scope, not component state, so a handler closure can
 * never be one render behind; `null` means "no press is waiting".
 */
let pressedSelection: { readonly sessionId: string; readonly span: TokenSpanLike | null } | null = null
/**
 * R5's own facts, per session.
 *
 * They live here rather than in `useState` on purpose: the standard seat hands
 * this control exactly one state slot, and a second one would be read
 * positionally against whatever else shares the renderer. Only the press verdict
 * decides behaviour; the live cue only moves the label; the notice is the one
 * sentence the human reads after a conversion.
 */
const pressedVerdict = new Map<string, boolean>()
const liveCue = new Map<string, boolean>()
const toggleNotice = new Map<string, string>()
const toggleBusy = new Set<string>()

/** The translate seat, with the literal table as the fallback. */
function attachT(props: { readonly t?: unknown }): (key: string) => string {
  const t = props.t
  if (typeof t === 'function') return t as (key: string) => string
  return (key: string) => ATTACH_ZH[key] ?? key
}

/**
 * A translator for a seat that belongs to another package's contract.
 *
 * The harness hands an occupant of a `conversation.*` seat a translator bound to
 * *its* namespaces; this plugin's keys live in `secretAttach`, which that bound
 * translator cannot resolve. Printing a raw key would be a visible defect, so the
 * bound one is used only when it actually knows the key, and our own table is the
 * fallback.
 */
function seatT(props: { readonly t?: unknown }): (key: string) => string {
  const bound = props.t
  if (typeof bound === 'function') {
    const translate = bound as (key: string) => string
    if (translate('paste') !== 'paste') return translate
  }
  return (key: string) => ATTACH_ZH[key] ?? key
}

/**
 * The composer's 「粘贴」 action (round 7, R2, composer half).
 *
 * It is the only place this plugin may act on the editor, and the boundary is
 * worth stating where it lives:
 *
 * - `inputActions` offers `captureInsertion` and `insertText` — **no way to write
 *   a controlled value**. The pasted text is inserted at the caret and the
 *   editor's own onChange/validation runs, exactly as if the human had pasted it
 *   by hand.
 * - Only *this* button is ours. The seat is a list (other plugins may add their
 *   own entries), and a third-party plugin's own input box cannot be decorated or
 *   covered from here.
 * - The `@` reference source (an `inputTriggers` source) and the floating capsule
 *   (`conversation.input.overlay`) are different registrations and are untouched.
 *
 * When the clipboard cannot be read, the three dictionary messages the capsule
 * uses are reused (`pasteUnavailable` / `pasteDenied` / `pasteEmpty`) — no
 * duplicate set of clipboard copy exists. The **insert** side is a different
 * failure with a different cause, so it has its own message
 * (`pasteInsertFailed`): by the time it is shown the clipboard read already
 * succeeded, and blaming it would be a wrong reason for a real failure. All
 * three insert-side branches answer with that message instead of throwing or
 * silently doing nothing, and focus is never taken from the editor.
 */
/** The composer editor the shell mounts (Lexical), as the live page measures it. */
const COMPOSER_EDITOR_SELECTOR = '[data-lexical-editor][data-composer-input]'

/**
 * Is this event target inside the composer editor?
 *
 * The composer's DOM belongs to the shell, so this is a query rather than a
 * contract: an element that cannot answer it — or throws while trying — is
 * simply not the editor, and the paste stays native. Our own panel inputs live
 * in other subtrees, so they never answer yes (t46 requirement: no friendly fire).
 */
function insideComposerEditor(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const node = target as { readonly closest?: unknown; readonly matches?: unknown }
  try {
    if (typeof node.closest === 'function') {
      return (node.closest as (selector: string) => unknown)(COMPOSER_EDITOR_SELECTOR) !== null
    }
    if (typeof node.matches === 'function') {
      return (node.matches as (selector: string) => boolean)(COMPOSER_EDITOR_SELECTOR) === true
    }
  } catch {
    return false
  }
  return false
}

/** The offered paste's shape: a rule name and a length, and nothing else. */
function composeOfferShape(verdict: { readonly rule?: string }, length: number): string {
  return `${verdict.rule ?? 'secret'} · ${length}`
}

/** One pending composer paste offer. Module scope, like the panel's mode: a
 *  single value, rendered by the seat, never carried into another session. */
let composerOffer: {
  readonly sessionId: string
  readonly text: string
  readonly shape: string
  readonly span: TokenSpanLike | null
} | null = null

/** The offer belonging to this session, or nothing: a stale one is not rendered. */
function pendingComposerOffer(sessionId: string): typeof composerOffer {
  return composerOffer !== null && composerOffer.sessionId === sessionId ? composerOffer : null
}
function setComposerOffer(offer: NonNullable<typeof composerOffer>): void {
  composerOffer = offer
}
function clearComposerOffer(): void {
  composerOffer = null
}

interface ComposerPasteGuard {
  readonly uninstall: () => void
  /** Let the next paste through untouched: the human's content is never trapped. */
  readonly allowNextPaste: () => void
}

/** The installed guard, so the seat's failure path can arm one native pass. */
let composerGuard: ComposerPasteGuard | null = null

/**
 * Decide what one composer paste should do. No DOM and no globals: everything it
 * needs is passed in, so the decision can be reasoned about (and tested) on its
 * own, and the listener below is only its delivery.
 *
 * `null` means "leave it alone": any other paste — prose, a code snippet, an
 * image with no text part — keeps the browser's behaviour.
 */
function composerPasteOffer(input: {
  readonly text: string
  readonly target: unknown
  readonly actions: InputActionsLike | undefined
  readonly recognize: (text: string) => { readonly secret?: boolean; readonly rule?: string }
}): { readonly text: string; readonly shape: string; readonly span: TokenSpanLike | null } | null {
  if (!insideComposerEditor(input.target)) return null
  // Both capabilities are needed before anything is taken over: without
  // `insertText` the text could never reach the draft again.
  if (typeof input.actions?.captureInsertion !== 'function') return null
  if (typeof input.actions?.insertText !== 'function') return null
  if (input.text.length === 0) return null
  let verdict: { readonly secret?: boolean; readonly rule?: string }
  try {
    verdict = input.recognize(input.text)
  } catch {
    return null
  }
  if (verdict.secret !== true) return null
  // Taken now, at the moment of the paste: the editor's own handler runs after
  // this capture listener and would move the caret.
  let span: TokenSpanLike | null = null
  try {
    span = input.actions.captureInsertion() ?? null
  } catch {
    span = null
  }
  return { text: input.text, shape: composeOfferShape(verdict, input.text.length), span }
}

/**
 * Watch the composer for a paste we must take over (t46).
 *
 * The listener is capture-phase on `document`, which is the only phase that runs
 * before the editor's own paste handling (Lexical takes the event on the editor
 * element itself). It is defensive by construction: a document that cannot
 * listen, a target that is not the editor, a classifier that throws — each of
 * those simply leaves the paste native. `preventDefault` and `stopPropagation`
 * happen **only** for an offer we actually take; stopping there does not silence
 * other listeners on this same node (that would need
 * `stopImmediatePropagation`), so the shell's own document-level handling still
 * sees the event.
 */
function guardComposerPaste(options: {
  readonly doc?: unknown
  readonly actions: InputActionsLike | undefined
  readonly recognize?: (text: string) => { readonly secret?: boolean; readonly rule?: string }
  readonly onOffer: (offer: {
    readonly text: string
    readonly shape: string
    readonly span: TokenSpanLike | null
  }) => void
}): ComposerPasteGuard {
  const doc = (options.doc ?? (typeof document === 'undefined' ? undefined : document)) as
    | { readonly addEventListener?: unknown; readonly removeEventListener?: unknown }
    | undefined
  const recognize = options.recognize ?? ((value: string) => classifyPastedText(value))
  let passNext = false
  const onPaste = (event: unknown): void => {
    try {
      if (passNext) {
        // The previous attempt could not place the text anywhere: this paste is
        // the human's next chance, and it goes to the browser untouched.
        passNext = false
        return
      }
      const paste = event as {
        readonly clipboardData?: { readonly getData?: (type: string) => string }
        readonly preventDefault?: () => void
        readonly stopPropagation?: () => void
        readonly target?: unknown
      }
      const text = paste.clipboardData?.getData?.('text/plain') ?? ''
      const offer = composerPasteOffer({ text, target: paste.target, actions: options.actions, recognize })
      if (offer === null) return
      paste.preventDefault?.()
      paste.stopPropagation?.()
      options.onOffer(offer)
    } catch {
      // Silent on purpose: nothing was prevented, so the paste is still native.
    }
  }
  const listening =
    doc !== undefined && typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function'
  if (listening) {
    try {
      ;(doc.addEventListener as (type: string, listener: unknown, capture: boolean) => void)('paste', onPaste, true)
    } catch {
      // A document that refuses the listener leaves every paste native.
    }
  }
  const handle: ComposerPasteGuard = {
    uninstall: () => {
      if (composerGuard === handle) composerGuard = null
      try {
        if (listening) {
          ;(doc?.removeEventListener as (type: string, listener: unknown, capture: boolean) => void)(
            'paste',
            onPaste,
            true,
          )
        }
      } catch {
        // Nothing to undo when the document refuses the removal.
      }
    },
    allowNextPaste: () => {
      passNext = true
    },
  }
  // The seat's failure paths reach the live guard through this reference, and a
  // test can install one exactly the way the seat's effect does.
  composerGuard = handle
  return handle
}

/**
 * Register the offered text as a secret and put its **marker** where the paste
 * was. The text itself only ever reaches `postAttach`; the draft receives the
 * marker, never the plaintext.
 */
async function attachComposerOffer(options: {
  readonly sessionId: string
  readonly text: string
  readonly span: TokenSpanLike
  readonly actions: InputActionsLike | undefined
  readonly settle: () => void
  readonly fail: (message: string) => void
}): Promise<void> {
  try {
    const attempt = await postAttach({
      sessionId: options.sessionId,
      // R1: an empty key and label are completed by the Host, so a human never
      // has to invent a key just to turn a paste into a secret.
      name: '',
      label: '',
      scope: DEFAULT_ATTACH_SCOPE,
      value: options.text,
    })
    if (!attempt.ok) {
      options.fail(attempt.error)
      return
    }
    noteStaged(options.sessionId, attempt.variable, '', '', attempt.scope)
    insertChip(options.sessionId, attempt.variable, options.span, options.actions)
    options.settle()
  } catch {
    options.fail(ATTACH_UNREACHABLE)
  }
}

function SecretComposerPaste(props: {
  readonly sessionId?: unknown
  readonly t?: unknown
  readonly inputActions?: InputActionsLike
}): unknown {
  const h = React.createElement
  const t = seatT(props)
  const actions = props.inputActions
  const sessionKey = text(props.sessionId) ?? ''
  const [notice, setNotice] = React.useState<string | null>(null)
  const [, setBump] = React.useState(0)
  const reflow = (): void => setBump((previous: number) => previous + 1)

  // t46: watch the composer for a paste we have to take over. The composer's DOM
  // belongs to the shell, so this is an out-of-contract listener: it is installed
  // by a guard that catches its own errors and is removed on unmount and on every
  // session change, and a paste it cannot help with stays native.
  React.useEffect(() => {
    const guard = guardComposerPaste({
      actions,
      onOffer: (offer) => {
        setComposerOffer({ sessionId: sessionKey, ...offer })
        reflow()
      },
    })
    return guard.uninstall
  }, [sessionKey])
  // Another session's pending offer is never rendered, and is dropped rather than
  // left for whenever that session comes back. This seat is always mounted for the
  // visible session, so it observes the session change too (D4b).
  noteActiveSession(sessionKey)
  if (composerOffer !== null && composerOffer.sessionId !== sessionKey) clearComposerOffer()
  const offer = pendingComposerOffer(sessionKey)

  /** The caret span the offer should use: the paste-time one, re-read if it was not given. */
  const offerSpan = (): TokenSpanLike | null => {
    if (offer === null) return null
    if (offer.span !== null) return offer.span
    try {
      return actions?.captureInsertion?.() ?? null
    } catch {
      return null
    }
  }

  /** 「转为密钥」: register through the existing route, then insert the marker. */
  const registerOffer = (): void => {
    const pending = offer
    if (pending === null) return
    const span = offerSpan()
    if (span === null) {
      // Nowhere to put the marker. Keep the offer (the plain-text escape is still
      // there) and let the NEXT paste through untouched, so the human's content
      // is never trapped behind a takeover that cannot finish.
      setNotice(t('pasteInsertFailed'))
      composerGuard?.allowNextPaste()
      return
    }
    void attachComposerOffer({
      sessionId: sessionKey,
      text: pending.text,
      span,
      actions,
      settle: () => {
        setNotice(null)
        clearComposerOffer()
        reflow()
      },
      fail: (message) => {
        // A refusal keeps the offer — and the escape — on screen, and never puts
        // the plaintext into the draft.
        setNotice(message)
        reflow()
      },
    })
  }

  /** 「按普通文本粘贴」: the escape hatch — the original text, in its place, no request. */
  const pasteOfferAsText = (): void => {
    const pending = offer
    if (pending === null) return
    const span = offerSpan()
    const insertText = actions?.insertText
    let inserted = false
    if (span !== null && typeof insertText === 'function') {
      try {
        inserted = insertText.call(actions, pending.text, span) === true
      } catch {
        inserted = false
      }
    }
    if (!inserted) {
      // The editor would not take it back either: hand the next paste to the
      // browser and say what happened, rather than keeping the text hostage.
      setNotice(t('pasteInsertFailed'))
      composerGuard?.allowNextPaste()
      clearComposerOffer()
      reflow()
      return
    }
    setNotice(null)
    clearComposerOffer()
    reflow()
  }

  const answer = (
    action: string,
    label: string,
    primary: boolean,
    onClick: () => void,
  ): unknown =>
    h(
      'button',
      {
        type: 'button',
        className: A.action,
        'aria-label': label,
        'data-action': action,
        'data-kind': primary ? 'primary' : 'secondary',
        onMouseDown: (event: { preventDefault?: () => void }) => {
          event.preventDefault?.()
        },
        onClick,
      },
      label,
    )

  return h(
    'span',
    { 'data-secret-paste-seat': 'composer', className: A.seat },
    // D5: this seat carries **no** 「粘贴」 button any more. It used to read the
    // clipboard and insert the text at the caret — a plain paste, behind a browser
    // permission prompt — while Ctrl+V inside the composer is now taken over by
    // the guard above. Two behaviours for one intention is exactly what this
    // plugin avoids, so the button is gone; the seat stays, because it is where
    // the takeover's own notice and offer are rendered.
    // (2): outside the row's flow, so appearing and disappearing changes nothing
    // about where anything else sits.
    notice === null ? null : h('span', { className: A.seatNotice, role: 'status' }, notice),
    // t46: the takeover's offer. The shape is a rule name and a length; the text
    // itself stays in the module's pending slot and is never rendered.
    offer === null
      ? null
      : h(
          'span',
          {
            className: A.seatOffer,
            'data-secret-paste-ask': 'composer',
            role: 'group',
            'aria-label': t('composerAskLabel'),
          },
          h('span', { className: A.notice, role: 'status' }, t('composerAskLead')),
          h(
            'span',
            { className: A.label, 'data-secret-paste-shape': offer.shape },
            `${t('composerAskShape')}: ${offer.shape}`,
          ),
          h(
            'span',
            { className: A.actions },
            answer('composer-ask-register', t('composerAskRegister'), true, registerOffer),
            answer('composer-ask-text', t('pasteAskText'), false, pasteOfferAsText),
          ),
        ),
  )
}

/**
 * The composer's entry button: a toggle whose pressed state and label follow the
 * capsule, exactly as the vision-mode toggle's follow theirs.
 *
 * R5 gives it a second reading. When the human has text selected in the editor,
 * this button does not open the capsule: it registers the selected text as a
 * secret of this session and replaces the selection with the reference marker.
 * The verdict is taken at the moment of the press — the one moment the frozen
 * contract offers — and the label changes with it; the selection itself is read
 * through `captureInsertion()` (never through the DOM), and the text behind the
 * span through `InputState`'s draft and occurrences. When that reading does not
 * line up exactly, the button keeps its original 「附密钥」 behaviour: nothing is
 * registered, nothing is lost.
 */
function SecretAttachToggle(props: {
  readonly sessionId?: unknown
  readonly open?: () => void
  readonly close?: () => void
  readonly t?: unknown
  readonly inputActions?: InputActionsLike
  /** The standard kit's selector hook for the composer's published state. */
  readonly useInput?: unknown
}): unknown {
  const h = React.createElement
  const t = attachT(props)
  const sessionId = text(props.sessionId) ?? ''
  const actions = props.inputActions
  // The one state slot this control has always had. Everything R5 adds is read
  // through it (a module-scope change bumps this counter to re-render) so this
  // registration never grows a second slot.
  const [snap, setSnap] = React.useState(0)
  const reflow = (): void => setSnap((previous: number) => previous + 1)
  React.useEffect(() => {
    const release = subscribeAttached(reflow)
    // The host is the authority for what is still attached after a reload.
    void refreshAttached(sessionId)
    return release
  }, [sessionId])
  // The contract-external enhancement (C): a DOM listener that may only move the
  // label. It is silent when the platform does not offer `selectionchange`, when
  // reading the editor throws, and when nothing editable is focused.
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onSelectionChange = (): void => {
      try {
        const cue = liveSelectionCue(actions, editableFocused())
        if (cue === null) return
        liveCue.set(sessionId, cue)
        reflow()
      } catch {
        // Silent on purpose: the label is a hint, and the press still decides.
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      try {
        document.removeEventListener('selectionchange', onSelectionChange)
      } catch {
        // Nothing to undo when the document refuses the removal.
      }
    }
  }, [sessionId])
  void snap

  const useInputSeat = typeof props.useInput === 'function' ? (props.useInput as SeatHook) : useAbsentSeat
  const draftSeat = text(useInputSeat((state: InputStateLike) => state.draft)) ?? ''
  const occurrencesSeat = useInputSeat((state: InputStateLike) => state.occurrences)
  const occurrences = Array.isArray(occurrencesSeat) ? occurrencesSeat : []

  // D4b: this control is always mounted for the visible session, so it is one of
  // the places the session change is observed — before the panel below reads it.
  noteActiveSession(sessionId)
  const open = currentMode(sessionId).kind !== 'idle'
  const count = attachmentCount(sessionId)
  // The label: a press that is still pending wins (it is what the click will act
  // on); otherwise the live cue; otherwise the last press verdict. With no
  // selection anywhere, all three agree on 「附密钥」.
  const pending = pressedSelection !== null && pressedSelection.sessionId === sessionId ? pressedSelection.span : undefined
  const converting =
    pending !== undefined ? pending !== null : (liveCue.get(sessionId) ?? pressedVerdict.get(sessionId) ?? false)
  const label = open ? t('toggleOpen') : converting ? t('toggleConvert') : t('toggle')
  const notice = toggleNotice.get(sessionId)
  const noticeText = typeof notice === 'string' && notice !== '' ? notice : null

  /**
   * The behaviour this button has always had: open the capsule, or close it.
   *
   * It is also the fallback for a selection this plugin cannot read exactly —
   * the same click then does exactly what 「附密钥」 always did, instead of
   * registering the wrong bytes or doing nothing at all.
   */
  const togglePanel = (): undefined => {
    if (open) {
      if (props.close !== undefined) props.close()
      else setAttachModeFor(sessionId, { kind: 'idle' })
      return undefined
    }
    if (props.open !== undefined) props.open()
    else setAttachModeFor(sessionId, { kind: 'fill' })
    return undefined
  }

  /**
   * Turn the selection into a secret, then replace it with the marker.
   *
   * The text comes from the two projections, so a selection that cannot be
   * resolved exactly registers nothing and falls back to the plain toggle. On a
   * refusal the draft is untouched (the marker only ever replaces the span after
   * the host accepted the value), and the sentence reported is this plugin's own.
   */
  const convert = async (span: TokenSpanLike): Promise<void> => {
    if (sessionId === '' || toggleBusy.has(sessionId)) return
    const selected = selectedTextIn(draftSeat, occurrences, span)
    if (selected === null) {
      // Not plain text this half can trust: never guess, never register — the
      // click keeps the original 「附密钥」 behaviour instead.
      pressedVerdict.set(sessionId, false)
      reflow()
      togglePanel()
      return
    }
    toggleBusy.add(sessionId)
    toggleNotice.delete(sessionId)
    reflow()
    try {
      const attempt = await postAttach({
        sessionId,
        // R1: an empty key and an empty title are legal, and they are what the
        // conversion sends — the host settles the key by its own rule.
        name: '',
        label: '',
        scope: DEFAULT_ATTACH_SCOPE,
        value: selected,
      })
      if (!attempt.ok) {
        toggleNotice.set(sessionId, attempt.error)
        return
      }
      noteStaged(sessionId, attempt.variable, '', '', attempt.scope)
      const applied = insertChip(sessionId, attempt.variable, span, actions)
      if (applied === 'manual') {
        // The editor refused both rungs: the variable is registered, and the one
        // honest offer left is the detail face's own insert action.
        toggleNotice.set(sessionId, t('convertManual'))
        setAttachMode({ kind: 'detail', variable: attempt.variable })
        return
      }
      toggleNotice.set(sessionId, t('convertDone'))
    } catch {
      toggleNotice.set(sessionId, ATTACH_UNREACHABLE)
    } finally {
      toggleBusy.delete(sessionId)
      reflow()
    }
  }

  return h(
    'span',
    { className: A.toggleWrap, 'data-secret-attach-toggle-wrap': 'true' },
    h(
      'button',
      {
        type: 'button',
        className: open ? `${A.btn} ${A.btnOn}` : A.btn,
        'data-secret-attach-toggle': 'true',
        'aria-pressed': open,
        'aria-label': label,
        title: converting ? t('toggleConvertHint') : t('toggleHint'),
        onMouseDown: (event: { preventDefault?: () => void }) => {
          event.preventDefault?.()
          // The verdict this gesture will act on, read where the contract allows
          // it: the press. It decides the label at once, which is the observable
          // difference between "before" and "after" here.
          const span = selectedSpan(actions)
          pressedSelection = { sessionId, span }
          pressedVerdict.set(sessionId, span !== null)
          // A new gesture is the human acting again: the last sentence has been
          // read (or is about to be replaced), so it does not linger for ever.
          toggleNotice.delete(sessionId)
          reflow()
        },
        onClick: () => {
          const press = pressedSelection
          pressedSelection = null
          // Keyboard activation fires no press: without one, the click reads the
          // editor itself rather than a verdict some earlier gesture left behind.
          const span = press === null || press.sessionId !== sessionId ? selectedSpan(actions) : press.span
          pressedVerdict.set(sessionId, span !== null)
          if (span === null) return togglePanel()
          return convert(span)
        },
      },
      h('span', { className: A.glyph, 'aria-hidden': true }, '🔑'),
      h('span', null, converting ? t('toggleConvert') : t('toggle')),
      count > 0 ? h('span', { className: A.badge }, String(count)) : null,
    ),
    noticeText === null ? null : h('span', { className: A.optionHint, role: 'status' }, noticeText),
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
  const [scope, setScope] = React.useState<Scope>(DEFAULT_ATTACH_SCOPE)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [tier, setTier] = React.useState<string | null>(null)
  /**
   * Material-shaped text the classifier recognised, waiting for the human's
   * explicit choice (D2). While this is set **nothing has happened**: the pasted
   * text is in the value field, and the two buttons under it are the only way
   * forward — no request, no clearing, no view change.
   */
  const [pasteOffer, setPasteOffer] = React.useState<string | null>(null)
  // The management flow's own state. The value a human types here lives in this
  // one component and in the request it is submitted with, nowhere else.
  const [editValue, setEditValue] = React.useState('')
  const [editReveal, setEditReveal] = React.useState(false)
  /**
   * D4: the session this panel belongs to.
   *
   * The comparison happens **during render** (this component's stubbed React has
   * no deps-aware effect, and a deps-aware one would run after paint anyway),
   * and the panel state itself is module-level, so a changed session closes the
   * panel before the new session's first frame draws: the idle guard below also
   * honours this flag, so not one frame of the previous session's face — or its
   * half-filled fields — is ever shown under the new session. The key is exactly
   * the session id: an unrelated re-render must never close a panel the human is
   * filling in.
   */
  const [seenSession, setSeenSession] = React.useState(sessionId)
  const sessionChanged = seenSession !== sessionId
  if (sessionChanged) {
    setSeenSession(sessionId)
    setAttachMode({ kind: 'idle' })
    setKey('')
    setLabel('')
    setValue('')
    setReveal(false)
    setScope(DEFAULT_ATTACH_SCOPE)
    setBusy(false)
    setError(null)
    setTier(null)
    setPasteOffer(null)
    setEditValue('')
    setEditReveal(false)
  }
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

  noteActiveSession(sessionId)
  const mode = currentMode(sessionId)
  const historyOpen = mode.kind === 'history'
  // Opening the history face is what asks the host for it. The dependency is the
  // boolean, not the mode object: the read publishes an attachment change, which
  // re-renders this component, and depending on that would loop the fetch.
  React.useEffect(() => {
    if (!historyOpen) return undefined
    void refreshHistory(sessionId)
    return undefined
  }, [sessionId, historyOpen])
  // Opening the management face is what asks the host for it — and it is also
  // what asks again after an action, because an action is what changes the
  // answer. Same dependency discipline as the history read above.
  const manageOpen = mode.kind === 'manage'
  React.useEffect(() => {
    if (!manageOpen) return undefined
    void refreshManage(sessionId)
    return undefined
  }, [sessionId, manageOpen])
  // Requirement 3: the observer. This entry is the one that stays mounted for the
  // whole session (an empty face still renders a component), which is exactly why
  // it is where the composer is watched.
  React.useEffect(() => {
    if (!watching) return undefined
    observeComposer(sessionId, { draft: draftSeat, phase: phaseSeat, pendingSubmissions: pendingSeat })
    return undefined
  }, [sessionId, watching, draftSeat, phaseSeat, pendingSeat])
  if (mode.kind === 'idle' || sessionChanged) return null

  /**
   * Register one attach: the single place a value leaves this component.
   *
   * `pasted` is the material to register. The form passes whatever the field
   * holds; the value field's paste paths (R3) pass the clipboard text, so a
   * pasted secret is registered through **exactly this route** — the same
   * validation, the same request, the same success handling (insert the chip,
   * open the detail face) — instead of a second, parallel one.
   *
   * The value field already holds whatever the human pasted — every path that
   * reaches here put it there — so a refusal simply leaves it in place, exactly
   * where they can see it, and nothing is lost.
   */
  async function registerValue(pasted: string): Promise<void> {
    if (busy) return
    const name = key.trim()
    // R1: the key is optional. An empty one is completed by the Host — the local
    // rule decides it, and a deadline-bounded model suggestion may improve it —
    // so a human never has to invent a key just to attach a secret.
    if (name.length > 0 && !ATTACH_KEY_RE.test(name)) {
      setError(t('badKey'))
      return
    }
    if (pasted.length === 0) {
      setError(t('noValue'))
      return
    }
    setBusy(true)
    setError(null)
    // The human chose "register" on the paste offer, so the offer is answered.
    setPasteOffer(null)
    const span = actions?.captureInsertion?.() ?? null
    try {
      // The request itself lives in `postAttach`, shared with the selection
      // conversion (R5): same body, same failure sentences, same reading of the
      // answer. This component's own work is only what it alone knows — the
      // fields, the record it keeps, and where the marker goes.
      const attempt = await postAttach({
        sessionId,
        name,
        label: label.trim(),
        scope,
        value: pasted,
      })
      if (!attempt.ok) {
        setError(attempt.error)
        return
      }
      // The value leaves this component here, and this is the only place it is
      // ever read: it is not stored, echoed, or carried into the detail view.
      setValue('')
      noteStaged(sessionId, attempt.variable, name, label.trim(), attempt.scope)
      const applied = insertChip(sessionId, attempt.variable, span, actions)
      setTier(applied)
      setAttachMode({ kind: 'detail', variable: attempt.variable })
    } catch {
      setError(ATTACH_UNREACHABLE)
    } finally {
      setBusy(false)
    }
  }

  /** The form's own submit: register whatever the value field holds. */
  async function submit(): Promise<void> {
    await registerValue(value)
  }

  /**
   * The value field's paste paths (R3 + D2).
   *
   * The native paste event and the 「粘贴」 button both land here, so one
   * intention has one behaviour. Material-shaped text is **offered**, never
   * registered on its own: the clipboard read already succeeded by now and the
   * text is in the field, so whether it becomes a secret is the human's call
   * (the two buttons under the field). Anything else is written exactly as
   * typing it would be.
   */
  function pasteIntoValue(text: string): void {
    setValue(text)
    setPasteOffer(classifyPastedText(text).secret ? text : null)
  }

  /**
   * The value field's native paste: take over only for material-shaped text.
   *
   * A paste the classifier does not recognise keeps the browser's own behaviour
   * (the field's `onChange` runs, as with typing) — the plugin must not swallow
   * text it cannot account for. A recognised one is still only *offered* here.
   */
  function onValuePaste(event: {
    readonly clipboardData?: { getData?: (type: string) => string }
    preventDefault?: () => void
  }): void {
    const text = event.clipboardData?.getData?.('text') ?? ''
    if (!classifyPastedText(text).secret) return
    event.preventDefault?.()
    pasteIntoValue(text)
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

  /**
   * Run one management action and report exactly what the host said.
   *
   * A refusal leaves every face as it was and only shows the fixed sentence for
   * that status: nothing here decides that an action "probably worked". On
   * success the three lists this page caches are re-read from the host (it is
   * the authority for what changed), and the route back is the management face.
   */
  async function runManage(body: Record<string, unknown>, report: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    manageReport = null
    try {
      const attempt = await postManage({ sessionId, ...body })
      if (!attempt.ok) {
        setError(attempt.error ?? MANAGE_FAILURE_UNKNOWN)
        return
      }
      manageReport = attempt.notice === undefined ? report : `${report}${attempt.notice}`
      // The value this form held leaves the component here and is never kept.
      setEditValue('')
      setAttachMode({ kind: 'manage' })
      await refreshManage(sessionId)
      await refreshAttached(sessionId)
      await refreshHistory(sessionId)
    } finally {
      setBusy(false)
    }
  }

  /** The one action whose material a human supplies. */
  async function submitEdit(variable: string, target: ManageTarget): Promise<void> {
    if (busy) return
    if (editValue.length === 0) {
      setError(t('editNoValue'))
      return
    }
    await runManage(
      { action: 'value', variable, target, value: editValue },
      target === 'store' ? t('reportValueStore') : t('reportValueSession'),
    )
  }

  /** The three destructive questions, each with its own body on the wire. */
  async function confirmDanger(variable: string, act: ManageDanger): Promise<void> {
    if (busy) return
    if (act === 'unbind') {
      await runManage({ action: 'unbind', variable }, t('reportUnbind'))
      return
    }
    if (act === 'delete') {
      // `confirm:true` is what makes this the real deletion; the route refuses
      // the action without it, so no client can trigger it by accident.
      await runManage({ action: 'delete', variable, confirm: true }, t('reportDelete'))
      return
    }
    await runManage({ action: 'scope', variable, to: 'session' }, t('reportScopeDown'))
  }

  /** The non-destructive direction of a scope change. */
  async function scopeUp(variable: string): Promise<void> {
    if (busy) return
    await runManage({ action: 'scope', variable, to: 'persistent' }, t('reportScopeUp'))
  }

  /**
   * The other direction, which is **not** destructive: this session's exposure
   * becomes session-only while the credential-store record stays exactly where
   * it is. It is a separate button from the deletion on purpose — the user
   * ruled that neither direction may carry a hidden destructive side effect.
   */
  async function scopeDown(variable: string): Promise<void> {
    if (busy) return
    await runManage({ action: 'scope', variable, to: 'session' }, t('reportScopeDown'))
  }

  // One header for every face of the box: the title names the face that is up,
  // the links are the ways between the management and history faces, and the
  // close button returns to the composer.
  const headTitle =
    mode.kind === 'fill'
      ? t('fillTitle')
      : mode.kind === 'confirm'
        ? t('confirmTitle')
        : mode.kind === 'manage'
          ? t('manageTitle')
          : mode.kind === 'edit'
            ? mode.target === 'store'
              ? t('editTitleStore')
              : t('editTitleSession')
            : mode.kind === 'danger'
              ? mode.act === 'unbind'
                ? t('dangerUnbindTitle')
                : t('dangerDeleteTitle')
              : mode.kind === 'history'
                ? mode.variable === undefined
                  ? t('historyTitle')
                  : t('historyForVariable')
                : t('detailTitle')
  const link = (key: string, action: string, label: string, onClick: () => void): unknown =>
    h('button', { type: 'button', className: A.link, 'data-action': action, key, onClick }, label)
  const historyLink = (action = 'history'): unknown =>
    link('history', action, t('historyLink'), () => {
      manageReport = null
      setAttachMode({ kind: 'history' })
    })
  const manageLink = (action = 'manage'): unknown =>
    link('manage', action, t('manageLink'), () => {
      manageReport = null
      setAttachMode({ kind: 'manage' })
    })
  const headLinks: unknown[] =
    // The confirm face is a question, not a place: it offers its two answers and
    // nothing else, so it carries no link out (a store-side pick may not even
    // have a variable this session can show a history for).
    mode.kind === 'confirm'
      ? []
      : mode.kind === 'manage' || mode.kind === 'edit' || mode.kind === 'danger'
        // Inside the management flow the way back is history; "manage" itself
        // would be a link to where the reader already is.
        ? [historyLink()]
        : mode.kind === 'history'
          ? mode.variable === undefined
            ? [manageLink()]
            : [
                link('history-all', 'history-all', t('historyAll'), () => {
                  setAttachMode({ kind: 'history' })
                }),
                manageLink(),
              ]
          : [historyLink(), manageLink()]
  const head = h(
    'header',
    { className: A.head },
    h('span', { className: A.title }, headTitle),
    ...headLinks,
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
          manageReport = null
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
          h(
            'div',
            { className: A.inputRow },
            // Implicit label association: the caption and the control live inside
            // one `<label>`, so the control carries no `id` and the caption no
            // `for`. Chrome's own Autofill guide says the browser stores and fills
            // a field by its `name` attribute and, in some browsers, its `id`, so
            // the stable identity is exactly what has to go; MDN documents the
            // nested form as the equivalent association ("the `for` and `id`
            // attributes are not needed because the association is implicit"), and
            // `aria-label` carries the same text as an explicit accessible name for
            // the assistive technologies that do not implement implicit labels.
            h(
              'label',
              { className: A.fieldGroup },
              h('span', { className: A.label }, t('labelLabel')),
              h('input', {
                ...IDENTIFIER_FIELD_SUPPRESSION,
                ...secretFieldGuards(),
                className: A.input,
                type: 'text',
                value: label,
                placeholder: t('labelPlaceholder'),
                disabled: busy,
                'aria-label': t('labelLabel'),
                onChange: (event: { target: { value: string } }) => setLabel(event.target.value),
              }),
            ),
            // The paste button sits **outside** the `<label>` on purpose: a
            // `<button>` is itself labelable, so inside it would become the
            // label's labelled control and click-to-focus would leave the input.
            pasteAction({
              t,
              className: A.toggle,
              disabled: busy,
              setNotice: setError,
              apply: (text) => setLabel(text),
            }),
          ),
        ),
        // R1: the credential key is the *second* identifier field (it used to be
        // the first), and it may be left empty — the Host then derives one.
        h(
          'div',
          { className: A.field },
          h(
            'div',
            { className: A.inputRow },
            // Outside the `<label>` for the same reason as the title field above:
            // a button inside it would become the label's labelled control.
            h(
              'label',
              { className: A.fieldGroup },
              h('span', { className: A.label }, t('keyLabel')),
              h('input', {
                ...IDENTIFIER_FIELD_SUPPRESSION,
                ...secretFieldGuards(),
                className: A.input,
                type: 'text',
                value: key,
                placeholder: t('keyPlaceholder'),
                disabled: busy,
                'aria-label': t('keyLabel'),
                // Pasting here writes through the field's own setter, exactly as
                // typing does; the key's validation still happens on submit, so a
                // pasted invalid key reaches the same `badKey` branch.
                onChange: (event: { target: { value: string } }) => setKey(event.target.value),
              }),
            ),
            pasteAction({
              t,
              className: A.toggle,
              disabled: busy,
              setNotice: setError,
              apply: (text) => setKey(text),
            }),
          ),
          h('span', { className: A.optionHint }, t('keyHint')),
        ),
        h(
          'div',
          { className: A.field },
          h('label', { className: A.label, htmlFor: 'dsh-secret-attach-value' }, t('valueLabel')),
          h(
            'div',
            { className: A.inputRow },
            h('input', {
              ...SECRET_FIELD_SUPPRESSION,
              ...secretFieldGuards(),
              id: 'dsh-secret-attach-value',
              className: A.input,
              type: reveal ? 'text' : 'password',
              value,
              placeholder: t('valuePlaceholder'),
              disabled: busy,
              'aria-label': t('valueLabel'),
              // R3: material-shaped pastes are taken over and registered; anything
              // else keeps the browser's own behaviour (onChange runs as with typing).
              onPaste: onValuePaste,
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
            // R2 + R3: the button takes the same offer path the native paste does.
            pasteAction({
              t,
              className: A.toggle,
              disabled: busy,
              setNotice: setError,
              apply: pasteIntoValue,
            }),
          ),
          // D2: the explicit choice. Nothing above registered anything — these two
          // buttons are the whole decision, and both keep focus where the human
          // was working (mousedown is prevented) while staying keyboard-reachable.
          pasteOffer === null
            ? null
            : h(
                'div',
                {
                  className: A.actions,
                  'data-secret-paste-ask': 'value',
                  role: 'group',
                  'aria-label': t('pasteAskLabel'),
                },
                h('span', { className: A.notice }, t('pasteAskLead')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: A.action,
                    'data-action': 'paste-ask-register',
                    'data-kind': 'primary',
                    disabled: busy,
                    'aria-label': t('pasteAskRegister'),
                    onMouseDown: (event: { preventDefault?: () => void }) => {
                      event.preventDefault?.()
                    },
                    onClick: () => {
                      void registerValue(pasteOffer)
                    },
                  },
                  t('pasteAskRegister'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: A.action,
                    'data-action': 'paste-ask-text',
                    disabled: busy,
                    'aria-label': t('pasteAskText'),
                    onMouseDown: (event: { preventDefault?: () => void }) => {
                      event.preventDefault?.()
                    },
                    onClick: () => {
                      // Plain text: the field keeps what was pasted, and nothing
                      // else happens — no request, no clearing, no view change.
                      setPasteOffer(null)
                    },
                  },
                  t('pasteAskText'),
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

  // The management face: both halves of every variable this session may manage,
  // with only the actions the host proved are possible. "Unbind" and "delete"
  // are separate buttons with separate wording and separate confirmation faces,
  // because they are separate facts about the world.
  if (mode.kind === 'manage') {
    const rows = manageOf(sessionId)
    const failed = manageFailed(sessionId)
    // One row per variable. A row that has both halves is the session section's
    // (its provenance line says "本会话 + 凭据库"), so the store section lists
    // only what this session does not hold — never the same row twice.
    const sessionRows = rows.filter((entry) => entry.source !== 'store')
    const storeRows = rows.filter((entry) => entry.source === 'store')
    const actionButton = (action: string, label: string, onClick: () => void): unknown =>
      h(
        'button',
        { type: 'button', className: A.action, 'data-action': action, disabled: busy, onClick },
        label,
      )
    const row = (entry: ManageEntry): unknown =>
      h(
        'li',
        {
          key: entry.variable,
          className: A.histItem,
          'data-secret-manage-row': entry.source,
          // Which direction put this row in the session section: `attach` and
          // `request` are different facts and the face must not merge them.
          ...(entry.origin === undefined ? {} : { 'data-secret-manage-origin': entry.origin }),
          'data-secret-manage-variable': entry.variable,
        },
        h(
          'span',
          { className: A.histEvent },
          h('code', { className: A.code }, entry.variable),
          ' ',
          h('span', { className: A.rowValue }, entry.label),
        ),
        h('span', { className: A.histMeta }, describeManage(entry)),
        h(
          'div',
          { className: A.actions },
          entry.can.value
            ? actionButton('manage-value', t('manageActValue'), () => {
                setEditValue('')
                setError(null)
                setAttachMode({
                  kind: 'edit',
                  variable: entry.variable,
                  target: entry.source === 'store' ? 'store' : 'session',
                })
              })
            : null,
          entry.can.scope
            ? entry.scope === 'session'
              ? actionButton('manage-scope-persist', t('manageActScopeUp'), () => void scopeUp(entry.variable))
              : actionButton('manage-scope-session', t('manageActScopeDown'), () => void scopeDown(entry.variable))
            : null,
          entry.can.unbind
            ? actionButton('manage-unbind', t('manageActUnbind'), () => {
                setError(null)
                setAttachMode({ kind: 'danger', variable: entry.variable, act: 'unbind' })
              })
            : null,
          entry.can.delete
            ? actionButton('manage-delete', t('manageActDelete'), () => {
                setError(null)
                setAttachMode({ kind: 'danger', variable: entry.variable, act: 'delete' })
              })
            : null,
          entry.can.value || entry.can.scope || entry.can.unbind || entry.can.delete
            ? null
            : h('span', { className: A.notice }, t('manageNone')),
        ),
      )
    const listFor = (items: readonly ManageEntry[]): unknown =>
      h('ul', { className: A.histList, 'data-secret-manage-count': String(items.length) }, ...items.map(row))
    return h(
      'div',
      {
        className: A.box,
        'data-secret-attach-capsule': 'manage',
        role: 'group',
        'aria-label': t('manageTitle'),
      },
      head,
      h(
        'div',
        { className: `${A.body} ${A.detail}` },
        // The two promises that make this face safe to use live in the picture,
        // not in a footnote: nothing here shows a value, and a real delete is
        // irreversible.
        h('p', { className: A.notice, 'data-secret-manage-notice': 'value' }, t('manageNotice')),
        manageReport === null ? null : h('p', { className: A.notice, 'data-kind': 'report', role: 'status' }, manageReport),
        error === null ? null : h('p', { className: A.notice, 'data-kind': 'error', role: 'alert' }, error),
        busy ? h('p', { className: A.notice }, t('busy')) : null,
        failed
          ? h('p', { className: A.notice, 'data-kind': 'error', role: 'status' }, t('manageUnavailable'))
          : !manageRead(sessionId)
            ? h('p', { className: A.notice, 'data-secret-manage-reading': 'true' }, t('manageReading'))
            : rows.length === 0
              ? h('p', { className: A.notice }, t('manageEmpty'))
              : null,
        sessionRows.length === 0 ? null : h('p', { className: A.sectionTitle }, t('manageSectionSession')),
        sessionRows.length === 0 ? null : listFor(sessionRows),
        storeRows.length === 0 ? null : h('p', { className: A.sectionTitle }, t('manageSectionStore')),
        storeRows.length === 0 ? null : listFor(storeRows),
        h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
      ),
    )
  }

  // The value face: one masked input, one show/hide, one write. The value lives
  // in this component's state and in the single request it is submitted with.
  if (mode.kind === 'edit') {
    const target = mode.target
    return h(
      'div',
      {
        className: A.box,
        'data-secret-attach-capsule': 'edit',
        'data-secret-manage-edit': target,
        role: 'group',
        'aria-label': target === 'store' ? t('editTitleStore') : t('editTitleSession'),
      },
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
        h('p', { className: A.notice }, target === 'store' ? t('editHintStore') : t('editHintSession')),
        h(
          'div',
          { className: A.field },
          h('label', { className: A.label, htmlFor: 'dsh-secret-manage-value' }, t('editValueLabel')),
          h(
            'div',
            { className: A.inputRow },
            h('input', {
              ...SECRET_FIELD_SUPPRESSION,
              ...secretFieldGuards(),
              id: 'dsh-secret-manage-value',
              className: A.input,
              type: editReveal ? 'text' : 'password',
              value: editValue,
              placeholder: t('editValuePlaceholder'),
              disabled: busy,
              'aria-label': t('editValueLabel'),
              onChange: (event: { target: { value: string } }) => setEditValue(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: A.toggle,
                'aria-pressed': editReveal,
                disabled: busy,
                onClick: () => setEditReveal(!editReveal),
              },
              editReveal ? t('hide') : t('show'),
            ),
            // R2: the change-value face gets the same suffix action, writing
            // through `setEditValue` — the same setter its onChange uses. R3 is
            // deliberately *not* wired here: this face changes an existing
            // record's material, and "register it as a new secret" is not what a
            // paste into it means.
            pasteAction({
              t,
              className: A.toggle,
              disabled: busy,
              setNotice: setError,
              apply: (text) => setEditValue(text),
            }),
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
              'data-action': 'manage-value-apply',
              'data-kind': 'primary',
              disabled: busy,
              onClick: () => void submitEdit(mode.variable, target),
            },
            t('editApply'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: A.link,
              'data-action': 'manage-value-cancel',
              disabled: busy,
              onClick: () => {
                // Cancelling must leave nothing behind: no request was made yet,
                // and the value exists only in this component's state.
                setEditValue('')
                setError(null)
                setAttachMode({ kind: 'manage' })
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

  // The danger face: one destructive question, its own wording, and a confirm
  // button that names what it does. Cancelling runs nothing at all.
  if (mode.kind === 'danger') {
    const act = mode.act
    const title = act === 'unbind' ? t('dangerUnbindTitle') : t('dangerDeleteTitle')
    const body = act === 'unbind' ? t('dangerUnbindBody') : t('dangerDeleteBody')
    const confirmLabel = act === 'unbind' ? t('dangerConfirmUnbind') : t('dangerConfirmDelete')
    return h(
      'div',
      {
        className: A.box,
        'data-secret-attach-capsule': 'danger',
        'data-secret-manage-danger': act,
        role: 'group',
        'aria-label': title,
      },
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
        h('p', { className: A.confirm }, body),
        h(
          'div',
          { className: A.actions },
          h(
            'button',
            {
              type: 'button',
              className: A.action,
              'data-action': `manage-danger-${act}`,
              'data-kind': 'danger',
              disabled: busy,
              onClick: () => void confirmDanger(mode.variable, act),
            },
            confirmLabel,
          ),
          h(
            'button',
            {
              type: 'button',
              className: A.link,
              'data-action': 'manage-danger-cancel',
              disabled: busy,
              onClick: () => {
                setError(null)
                setAttachMode({ kind: 'manage' })
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
        h(
          'button',
          {
            type: 'button',
            className: A.link,
            'data-action': 'manage-variable',
            onClick: () => {
              manageReport = null
              setAttachMode({ kind: 'manage' })
            },
          },
          t('manageLink'),
        ),
      ),
      busy ? h('p', { className: A.notice }, t('busy')) : null,
      error === null ? null : h('p', { className: A.notice, 'data-kind': 'error', role: 'alert' }, error),
      h('p', { className: A.foot }, `${t('footerLead')}${t('footerTail')}`),
    ),
  )
}

// ---------------------------------------------------------------------------
// The management card: the confirmation surface for one `secret_manage` call.
//
// It is a second card, keyed by its own tool name, so the request card's own
// definition, state machine and persisted meta are untouched. The two are told
// apart by the tool name on the durable `tool/call`, never by inspecting state:
// a `secret_manage` call can only ever claim this card, and vice versa.
//
// The card renders variable names and metadata; when an action needs a value, a
// human types it into this card's masked input, it is posted once, and it is
// cleared. Nothing here can be asked for by the agent.
// ---------------------------------------------------------------------------

/** One management call, as the card reads it out of the durable tool call. */
interface ManageCardRequest {
  readonly action: string
  readonly variable?: string
  readonly to?: Scope
  readonly target?: 'session' | 'store'
  readonly reason: string
}

/** One settled management result, as the Host reported it. */
interface ManageCardOutcome {
  readonly decision: 'listed' | 'applied' | 'rejected' | 'ignored' | 'other'
  readonly action?: string
  readonly variable?: string
  readonly scope?: Scope
  readonly count?: number
  readonly notice?: string
  readonly reason?: string
  readonly text?: string
}

/** The card's durable state: what was asked, and how it ended. */
interface ManageCardData {
  readonly callId: string
  readonly request: ManageCardRequest | null
  readonly requestUnreadable: boolean
  readonly settled: boolean
  readonly outcome: ManageCardOutcome | null
  readonly failure: CardFailure | null
}

/** Read one management call's arguments. Anything unreadable is a refusal. */
function parseManageCallRequest(argsRaw: unknown): ManageCardRequest | null {
  if (typeof argsRaw !== 'string' || argsRaw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const action = text(raw.action)
  const reason = text(raw.reason)
  if (action === undefined || reason === undefined) return null
  if (!['list', 'unbind', 'delete', 'scope', 'value'].includes(action)) return null
  const variable = text(raw.variable)
  const to = scopeOf(raw.to)
  const target = raw.target === 'session' ? 'session' : raw.target === 'store' ? 'store' : undefined
  return {
    action,
    ...(variable === undefined ? {} : { variable }),
    ...(to === undefined ? {} : { to }),
    ...(target === undefined ? {} : { target }),
    reason,
  }
}

/** Read the value-free settlement payload of one management call. */
function readManageOutcome(meta: unknown): ManageCardOutcome | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const raw = meta as Record<string, unknown>
  if (raw.kind !== MANAGE_META_KIND) return null
  const decision = raw.decision
  if (
    decision !== 'listed'
    && decision !== 'applied'
    && decision !== 'rejected'
    && decision !== 'ignored'
    && decision !== 'other'
  ) {
    return null
  }
  const action = text(raw.action)
  const variable = text(raw.variable)
  const scope = scopeOf(raw.scope)
  const notice = text(raw.notice)
  const reason = text(raw.reason)
  const instruction = text(raw.text)
  return {
    decision,
    ...(action === undefined ? {} : { action }),
    ...(variable === undefined ? {} : { variable }),
    ...(scope === undefined ? {} : { scope }),
    ...(typeof raw.count === 'number' && Number.isFinite(raw.count) ? { count: raw.count } : {}),
    ...(notice === undefined ? {} : { notice }),
    ...(reason === undefined ? {} : { reason }),
    ...(instruction === undefined ? {} : { text: instruction }),
  }
}

/** Read one management entry this card may answer. */
function readManagePending(raw: unknown): PendingEntry | null {
  const entry = readEntry(raw)
  if (entry === null) return null
  // A request-direction interaction has no action, so this card refuses to
  // claim it: two cards racing for one entry would show two different questions.
  return entry.action === undefined ? null : entry
}

/** The management card definition: one node per `secret_manage` call. */
const secretManageDefinition = {
  kind: MANAGE_CARD_KIND,
  target: 'chat',
  match(event: { readonly type?: unknown; readonly data?: unknown }): { id: string; role: 'start' | 'update' } | null {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown } | undefined
      if (data?.name !== MANAGE_TOOL_NAME || data.callId === undefined) return null
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
  start(_context: unknown, match: { readonly event: { readonly data?: unknown } }): ManageCardData {
    const data = match.event.data as { callId?: unknown; arguments?: unknown } | undefined
    const request = parseManageCallRequest(data?.arguments)
    return {
      callId: data?.callId === undefined ? '' : String(data.callId),
      request,
      requestUnreadable: request === null,
      settled: false,
      outcome: null,
      failure: null,
    }
  },
  update(context: { readonly state: ManageCardData }, match: { readonly event: unknown }): ManageCardData {
    const event = match.event as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'tool/result') return context.state
    const data = event.data as { meta?: unknown } | undefined
    const outcome = readManageOutcome(data?.meta)
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
    readonly state: ManageCardData | undefined
    readonly start: { readonly event: { readonly seq?: unknown } } | undefined
  }): Record<string, unknown> | null {
    if (context.start === undefined) return null
    const seq = context.start.event.seq
    const data = context.state ?? {
      callId: context.id,
      request: null,
      requestUnreadable: true,
      settled: false,
      outcome: null,
      failure: null,
    }
    return {
      key: context.key,
      kind: MANAGE_CARD_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: typeof seq === 'number' ? seq : 0,
      location: SESSION_LOCATION,
      visibility: 'visible',
      data,
    }
  },
}

/** Replaces the generic Tool row for `secret_manage`: the card is the surface. */
function HiddenSecretManageToolRow(): unknown {
  return null
}

/** Narrow a rendered node's payload back to this card's durable state. */
function asManageCardData(value: unknown): ManageCardData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const callId = text(raw.callId)
  if (callId === undefined) return null
  return {
    callId,
    request: raw.request === null || raw.request === undefined ? null : (raw.request as ManageCardRequest),
    requestUnreadable: raw.requestUnreadable === true,
    settled: raw.settled === true,
    outcome: raw.outcome === null || raw.outcome === undefined ? null : (raw.outcome as ManageCardOutcome),
    failure: raw.failure === null || raw.failure === undefined ? null : (raw.failure as CardFailure),
  }
}

/** What one management card calls the action it is confirming. */
function manageActionTitle(request: ManageCardRequest, t: (key: string) => string): string {
  if (request.action === 'unbind') return t('manageActUnbind')
  if (request.action === 'delete') return t('manageActDelete')
  if (request.action === 'value') {
    return request.target === 'store' ? t('editTitleStore') : t('editTitleSession')
  }
  if (request.action === 'scope') {
    return request.to === 'persistent' ? t('manageActScopeUp') : t('manageActScopeDown')
  }
  return t('manageTitle')
}

/**
 * One card for one `secret_manage` call.
 *
 * It polls the same waiting-interaction endpoint the request card does, claims
 * its own entry by call id (the Host states the action, so this card never
 * guesses), and shows either the confirmation or the settled one-line result.
 */
function SecretManageCard(props: {
  readonly node?: { readonly data?: unknown }
  readonly sessionId?: unknown
  readonly t?: unknown
}): unknown {
  const h = React.createElement
  const t = attachT(props)
  const data = asManageCardData(props.node === undefined ? null : props.node.data)
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
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)

  // Only management interactions may answer this card: the request direction's
  // entries carry no action, and showing one here would ask the wrong question.
  const probe: PendingProbe | null =
    snap.probe === null
      ? null
      : snap.probe.kind === 'ok'
        ? {
            kind: 'ok',
            entries: snap.probe.entries
              .map((raw) => readManagePending(raw))
              .filter((candidate): candidate is PendingEntry => candidate !== null),
          }
        : { kind: 'unreachable' }
  const resolved = nextPendingState(probe, { submitted }, { callId, sessionId })
  const entry = resolved.entry
  const request = data === null ? null : data.request
  const outcome = data === null ? null : data.outcome
  const failure = data === null ? null : data.failure
  const answerable = !settled && entry !== null && !busy
  const expectValue = entry?.expectValue === true || (request !== null && request.action === 'value')

  async function submit(decision: 'approved' | 'rejected' | 'ignored' | 'other', textInstruction?: string): Promise<void> {
    if (busy || settled || entry === null) return
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = {
      id: entry.id,
      decision,
      // The Host holds an approval to the value rule it set for this action;
      // the card still sends the scope field an approval requires.
      scope: entry.requestedScope ?? 'session',
    }
    if (decision === 'approved' && expectValue) body.value = value
    if (decision === 'other') body.text = textInstruction ?? ''
    try {
      const response = await fetch(ANSWER_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => undefined)) as { ok?: boolean; error?: string } | undefined
      if (payload?.ok === true) {
        setValue('')
        setSubmitted(true)
        return
      }
      if (response.status === 409) {
        setValue('')
        setSubmitted(true)
        setError(TEXT.statusConflict)
        return
      }
      setError(payload?.error ?? `提交失败（HTTP ${String(response.status)}）`)
    } catch {
      setError('提交失败')
    } finally {
      setBusy(false)
      // The value is never logged, echoed or retained after submission.
    }
  }

  const title = request === null ? TEXT.unreadable : manageActionTitle(request, t)
  const metaText = settled
    ? failure !== null
      ? `${TEXT.outcomeError}${TEXT.metaSeparator}${failure.code}`
      : outcome === null
        ? TEXT.unknownOutcome
        : outcome.decision === 'applied'
          ? `${outcome.action ?? ''}${outcome.scope === undefined ? '' : `${TEXT.metaSeparator}${outcome.scope === 'persistent' ? TEXT.persistent : TEXT.session}`}`
          : outcome.decision === 'listed'
            ? `列出 ${String(outcome.count ?? 0)} 条`
            : outcome.decision === 'rejected'
              ? TEXT.outcomeRejected
              : outcome.decision === 'ignored'
                ? TEXT.outcomeIgnored
                : TEXT.outcomeOther
    : resolved.status === 'linked'
      ? TEXT.metaRunning
      : resolved.status === 'unreachable'
        ? TEXT.metaConnecting
        : resolved.status === 'awaiting-result'
          ? TEXT.metaSubmitted
          : TEXT.metaPreparing
  const statusLine =
    settled || entry !== null
      ? null
      : resolved.status === 'lapsed'
        ? TEXT.statusLapsed
        : null
  const failureText = failure === null ? null : (TEXT.failure[failure.code] ?? `授权未完成（${failure.code}）。`)
  const notice = outcome?.notice ?? null
  const reason = request === null ? TEXT.unreadable : request.reason

  return h(
    'div',
    { className: C.root, 'data-secret-manage-card': request?.action ?? 'unknown' },
    h(
      'div',
      { className: C.head },
      h('span', { className: C.glyph, 'aria-hidden': true }, '🔐'),
      h('span', { className: C.title }, title),
      h('span', { className: metaText === '' ? C.metaMuted : C.meta }, metaText),
    ),
    h(
      'div',
      { className: C.body },
      h(
        'div',
        { className: C.field },
        h('span', { className: C.fieldLabel }, TEXT.reasonLabel),
        h('p', { className: C.reason }, reason),
      ),
      request === null || request.variable === undefined
        ? null
        : h(
            'div',
            { className: C.field },
            h('span', { className: C.fieldLabel }, '变量名'),
            h('code', { className: C.code }, request.variable),
          ),
      // The management card's own rule, said out loud: no value here can be
      // asked for by the agent, and one is only ever typed by the human.
      h('p', { className: C.notice }, '值只能由你在下面这个掩码框里输入；Agent 拿不到它，也不会看到它。'),
      // U2: making an existing session-held value durable must say exactly what
      // it writes, for which variable, at which scope — and it must not turn
      // into a field that asks the human to retype (or reveals) the value.
      request !== null && request.action === 'scope' && request.to === 'persistent'
        ? h(
            'div',
            { className: C.field, 'data-secret-manage-scope-up': 'true' },
            h('p', { className: C.notice }, t('manageScopeUpLead')),
            h('span', { className: C.fieldLabel }, t('manageScopeUpCurrent')),
            h(
              'div',
              { className: C.inputRow },
              h('input', {
                ...SECRET_FIELD_SUPPRESSION,
                className: C.input,
                // Masked and disabled: the value is never rendered here, and the
                // human is not asked for it again — the Host writes the copy this
                // session already holds.
                type: 'password',
                value: '',
                readOnly: true,
                disabled: true,
                'aria-label': t('manageScopeUpCurrent'),
                placeholder: '••••••••',
              }),
            ),
          )
        : null,
      // Deleting says what it deletes and what survives it: the session copy
      // keeps working, at session scope.
      request !== null && request.action === 'delete'
        ? h('p', { className: C.notice, 'data-secret-manage-delete': 'true' }, t('manageDeleteLead'))
        : null,
      expectValue && !settled
        ? h(
            'div',
            { className: C.field },
            h('span', { className: C.fieldLabel }, '新密钥内容'),
            h(
              'div',
              { className: C.inputRow },
              h('input', {
                ...SECRET_FIELD_SUPPRESSION,
                ...secretFieldGuards(),
                className: C.input,
                type: reveal ? 'text' : 'password',
                value,
                placeholder: '粘贴新的密钥…',
                disabled: busy || !answerable,
                'aria-label': '新密钥内容',
                onChange: (event: { target: { value: string } }) => setValue(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: C.toggle,
                  'aria-pressed': reveal,
                  disabled: busy || !answerable,
                  onClick: () => setReveal(!reveal),
                },
                reveal ? '隐藏' : '显示',
              ),
              // R2: the management confirmation card's value field, writing through
              // `setValue`. R3 is deliberately not wired here: this card answers a
              // `secret_manage` action (a change, `POST /api/secret.manage`), and a
              // paste into it must not become a second, parallel registration.
              pasteAction({
                t,
                className: C.toggle,
                disabled: busy || !answerable,
                setNotice: setError,
                apply: (text) => setValue(text),
              }),
            ),
          )
        : null,
      statusLine === null ? null : h('p', { className: C.notice }, statusLine),
      notice === null ? null : h('p', { className: C.notice }, `注意：${notice}`),
      failureText === null ? null : h('p', { className: C.notice }, failureText),
      error === null ? null : h('p', { className: C.notice, role: 'alert' }, error),
      settled
        ? null
        : h(
            'div',
            { className: C.actions },
            expectValue
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: C.btn,
                    'data-kind': 'approve',
                    disabled: !answerable || value.length === 0,
                    onClick: () => void submit('approved'),
                  },
                  '确认并写入',
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: C.btn,
                    'data-kind': 'approve',
                    disabled: !answerable,
                    onClick: () => void submit('approved'),
                  },
                  '确认',
                ),
            h(
              'button',
              {
                type: 'button',
                className: C.btn,
                disabled: !answerable,
                onClick: () => void submit('ignored'),
              },
              '稍后再说',
            ),
            h(
              'button',
              {
                type: 'button',
                className: C.btn,
                'data-kind': 'reject',
                disabled: !answerable,
                onClick: () => void submit('rejected'),
              },
              '拒绝',
            ),
          ),
      h('p', { className: C.foot }, '这个卡片只显示变量名与元数据；值不会进入对话或日志。'),
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
 * Whether one side-car row still shows a variable.
 *
 * The row renders what the message carried, so a capsule is normally present
 * because the message says so. It may only disappear on positive evidence that
 * this session no longer holds it: a record this page knows to be `withdrawn`,
 * or a variable missing from a list the host itself answered. A session this page
 * has never read keeps every capsule — "unknown" is not evidence, and a failed
 * read must not erase anything. Re-attaching the variable moves it back into the
 * live map, and the capsule reappears.
 */
function chipVariableVisible(sessionId: string, variable: string): boolean {
  const meta = attachedBySession.get(sessionId)?.get(variable)
  if (meta !== undefined) return meta.state !== 'withdrawn'
  return !attachedKnown.has(sessionId)
}

/**
 * The row's translator.
 *
 * The chat seat hands its occupant a translator bound to *its* namespace, which
 * cannot resolve this plugin's keys, so a bound one is used only when it really
 * knows a key of ours; otherwise this plugin's own table answers. That keeps the
 * ✕'s accessible name from ever rendering as a raw key.
 */
function rowT(props: { readonly t?: unknown }): (key: string) => string {
  const bound = props.t
  if (typeof bound === 'function') {
    const translate = bound as (key: string) => string
    if (translate('chipRemove') !== 'chipRemove') return translate
  }
  return (key: string) => ATTACH_ZH[key] ?? key
}

/** Variables whose removal is on the wire, so one click cannot post twice. */
const removalsInFlight = new Set<string>()

/**
 * One side-car row: the pills of one message, each with a remove action.
 *
 * The pill shows the variable name and opens the detail face; the ✕ beside it
 * removes the record from this session — the user's own ruling that the close
 * action *is* the unbind. `staged` goes through the existing release route,
 * `bound` through the management action `unbind`; neither ever touches the
 * credential store, so a durable record outlives the ✕ by construction. A
 * value can never appear here — the row's data holds two strings per message, a
 * message id and variable names.
 */
function SecretAttachChipRow(props: {
  readonly node?: { readonly data?: unknown }
  readonly sessionId?: unknown
  readonly t?: unknown
}): unknown {
  const h = React.createElement
  const t = rowT(props)
  const sessionId = text(props.sessionId) ?? ''
  // Re-render when the attachment store changes: the row's own visibility is
  // derived from it, so a removal performed anywhere must reach this component.
  const [snap, setSnap] = React.useState(0)
  const [notice, setNotice] = React.useState<{ readonly variable: string; readonly text: string } | null>(null)
  React.useEffect(() => subscribeAttached(() => setSnap((previous: number) => previous + 1)), [])
  void snap
  const data = props.node?.data as { messageId?: unknown } | undefined
  const messageId = text(data?.messageId) ?? ''
  const variables = chipRowVariables(props.node).filter((variable) => chipVariableVisible(sessionId, variable))
  // A shared renderer slot can carry a leftover value from another component in
  // these tests; only a real notice object is ever rendered.
  const noticeText =
    typeof notice === 'object' && notice !== null && typeof (notice as { text?: unknown }).text === 'string'
      ? (notice as { text: string }).text
      : null
  // A row with nothing left to show still renders its own outcome sentence: a
  // removal that worked must not take its report away with the capsule.
  if (variables.length === 0 && noticeText === null) return null

  /**
   * Remove one variable from this session, by the route its state calls for.
   *
   * Every outcome is reported as the host answered it: a refusal leaves the
   * capsule in place and says so instead of pretending the list changed.
   */
  const remove = async (variable: string): Promise<void> => {
    if (sessionId === '' || removalsInFlight.has(variable)) return
    removalsInFlight.add(variable)
    setNotice(null)
    try {
      const meta = attachedBySession.get(sessionId)?.get(variable)
      if (meta === undefined || meta.state === 'withdrawn') {
        // No live record this page knows of: never act on a guess. Ask the host
        // and report what its own answer says, without removing anything myself.
        await refreshAttached(sessionId)
        const after = attachedBySession.get(sessionId)?.get(variable)
        const live = after !== undefined && after.state !== 'withdrawn'
        setNotice({ variable, text: live || !attachedKnown.has(sessionId) ? t('chipRemoveFailed') : t('chipRemoveGone') })
        return
      }
      if (meta.state === 'staged') {
        const attempt = await postRelease(sessionId, variable, 'withdrawn')
        applyRelease(sessionId, variable, attempt.answer, 'withdrawn')
        const after = attachedBySession.get(sessionId)?.get(variable)
        const gone = attempt.ok && (after === undefined || after.state === 'withdrawn')
        setNotice({ variable, text: gone ? t('chipRemoveStaged') : t('chipRemoveFailed') })
      } else {
        const attempt = await postManage({ sessionId, action: 'unbind', variable })
        if (!attempt.ok) {
          setNotice({ variable, text: attempt.error ?? t('chipRemoveFailed') })
          return
        }
        // The host confirmed the exposure is gone and drops the record from its
        // own attached list, so this page mirrors the same fact at once rather
        // than waiting for a refresh that may never arrive.
        attachedBySession.get(sessionId)?.delete(variable)
        attachedKnown.add(sessionId)
        publishAttached()
        setNotice({ variable, text: t('chipRemoveBound') })
      }
      await refreshAttached(sessionId)
      await refreshHistory(sessionId)
      if (meta.state === 'bound') await refreshManage(sessionId)
    } catch {
      // Every reader below already reports its own failure; this is the last
      // guard so an unforeseen throw still leaves a sentence instead of an
      // unhandled rejection and a capsule that silently did nothing.
      setNotice({ variable, text: t('chipRemoveFailed') })
    } finally {
      removalsInFlight.delete(variable)
    }
  }

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
        // A container, not a button: the two actions are siblings, so no button
        // ever nests inside another button.
        'span',
        { key: variable, className: A.chipPillGroup, 'data-secret-variable': variable },
        h(
          'button',
          {
            type: 'button',
            className: A.chipPill,
            'data-secret-chip-open': variable,
            'aria-label': `${t('chipOpenHint')} @${variable}`,
            title: markerOf(variable),
            onClick: () => {
              setAttachMode({ kind: 'detail', variable })
            },
          },
          variable,
        ),
        h(
          'button',
          {
            type: 'button',
            className: A.chipRemove,
            'data-secret-chip-remove': variable,
            'aria-label': `${t('chipRemove')} @${variable}`,
            title: t('chipRemoveHint'),
            disabled: removalsInFlight.has(variable),
            // Taking this press is this button's own business: it must not move
            // focus to the pill, and it must not reach any ancestor.
            onMouseDown: (event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
              event.stopPropagation?.()
              event.preventDefault?.()
            },
            onClick: (event: { stopPropagation?: () => void; preventDefault?: () => void }) => {
              event.stopPropagation?.()
              event.preventDefault?.()
              return remove(variable)
            },
          },
          '✕',
        ),
      ),
    ),
    noticeText === null
      ? null
      : h(
          'span',
          {
            className: A.optionHint,
            role: 'status',
            'data-secret-chip-notice':
              typeof notice === 'object' && notice !== null ? String((notice as { variable?: unknown }).variable ?? '') : '',
          },
          noticeText,
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
    'sr-manage': SecretManageCardData
  }
}

/** The management card's payload, declared against the same node map. */
type SecretManageCardData = ManageCardData

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
 * The mechanical privacy classifier, **mirrored** from `src/privacy.ts`.
 *
 * This file is compiled to a classic script (`tsconfig.client.json` emits zero
 * `import`/`export`, and the harness loads exactly this one artifact), so it
 * cannot import the reference module. The rules are therefore spelled out again
 * here, exactly as the client already mirrors `deriveVariable`/`markerOf` — and
 * the two implementations are pinned together by one test that compares the
 * rule sets, the threshold constants and a shared corpus case by case
 * (`test/client-attach.test.ts` → "the client mirror and the reference
 * implementation agree"). Change one side without the other and that test fails.
 *
 * Keep this block free of dependencies (no `import`, no `require`) and free of
 * any value that travelled in from a paste: it only ever answers with ids.
 */
type ClientPrivacyRule =
  | 'pem'
  | 'jwt'
  | 'vendor-prefix'
  | 'long-concentrated'
  | 'high-entropy'
type ClientPrivacyExclusion =
  | 'empty'
  | 'reference'
  | 'url'
  | 'path'
  | 'email'
  | 'domain'
  | 'cjk'
  | 'multi-line'
  | 'whitespace'
  | 'identifier'
interface ClientPrivacyVerdict {
  readonly secret: boolean
  readonly rule?: ClientPrivacyRule
  readonly exclusion?: ClientPrivacyExclusion
}

/** Mirror of `PRIVACY_RULES` (`src/privacy.ts`). */
const PRIVACY_RULES: readonly ClientPrivacyRule[] = [
  'pem',
  'jwt',
  'vendor-prefix',
  'long-concentrated',
  'high-entropy',
]
/** Mirror of `PRIVACY_EXCLUSIONS` (`src/privacy.ts`). */
const PRIVACY_EXCLUSIONS: readonly ClientPrivacyExclusion[] = [
  'empty',
  'reference',
  'url',
  'path',
  'email',
  'domain',
  'cjk',
  'multi-line',
  'whitespace',
  'identifier',
]
/** Mirror of `PRIVACY_THRESHOLDS` (`src/privacy.ts`), value for value. */
const PRIVACY_THRESHOLDS = {
  minVendorPayload: 8,
  longTokenMinLength: 32,
  longTokenMinDistinct: 12,
  entropyTokenMinLength: 20,
  minBitsPerChar: 3.5,
  minDistinctChars: 10,
  identifierMaxLength: 40,
  identifierMaxSegments: 4,
} as const

/** Mirror of the vendor prefix table (`src/privacy.ts`, which names each vendor). */
const VENDOR_PREFIXES: readonly string[] = [
  'sk-', 'sk.', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_',
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
  'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-',
  'AKIA', 'ASIA', 'AIza', 'ya29.', 'SG.',
  'npm_', 'pypi-', 'dop_v1_', 'glpat-', 'hf_',
  'shpat_', 'shpss_', 'shpca_', 'sq0atp-', 'sq0csp-', 'dapi',
]
const PRIVACY_TOKEN_ALPHABET = /^[A-Za-z0-9+/=_.-]+$/
const PRIVACY_CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/
const PRIVACY_JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/
const PRIVACY_PEM_HEADER = /^-----BEGIN [A-Z0-9 ]{1,40}-----$/
const PRIVACY_URL_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const PRIVACY_PATH_SHAPES: readonly RegExp[] = [
  /^[A-Za-z]:[\\/]/,
  /^\\\\/,
  /^\//,
  /^\.{1,2}[\\/]/,
  /^~\//,
]
const PRIVACY_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/
const PRIVACY_DOMAIN_SHAPE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
const PRIVACY_IDENTIFIER_SHAPE = /^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+$/

/** Mirror of `distinctCharCount`. */
function distinctCharCount(text: string): number {
  return new Set(text).size
}

/** Mirror of `entropyBitsPerChar` (Shannon, bits per character). */
function entropyBitsPerChar(text: string): number {
  if (text.length === 0) return 0
  const counts = new Map<string, number>()
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const probability = count / text.length
    bits -= probability * Math.log2(probability)
  }
  return bits
}

/** Mirror of `isReferenceText`: a name, not material. */
function isReferenceText(text: string): boolean {
  return text.includes('@DSH_SECRET_')
    || text.includes('[secret ')
    || text.includes('dsh-resource://')
}

/** Mirror of `hasCjk`. */
function hasCjk(text: string): boolean {
  return PRIVACY_CJK.test(text)
}

function privacyIdentifierLike(text: string): boolean {
  if (text.length > PRIVACY_THRESHOLDS.identifierMaxLength) return false
  if (!PRIVACY_IDENTIFIER_SHAPE.test(text)) return false
  if (text.split(/[-_.]/).length > PRIVACY_THRESHOLDS.identifierMaxSegments) return false
  if (/\d{4,}/.test(text)) return false
  return text === text.toLowerCase() || text === text.toUpperCase()
}

function privacyLetterAndDigitCounts(text: string): { letters: number; digits: number } {
  let letters = 0
  let digits = 0
  for (const character of text) {
    if (character >= '0' && character <= '9') digits += 1
    else if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')) letters += 1
  }
  return { letters, digits }
}

function privacyPreciseRule(text: string): ClientPrivacyRule | undefined {
  if (PRIVACY_PEM_HEADER.test(text.split(/\r?\n/, 1)[0] ?? '')) return 'pem'
  if (PRIVACY_JWT_SHAPE.test(text)) return 'jwt'
  for (const prefix of VENDOR_PREFIXES) {
    if (!text.startsWith(prefix)) continue
    if (text.slice(prefix.length).length < PRIVACY_THRESHOLDS.minVendorPayload) continue
    if (!PRIVACY_TOKEN_ALPHABET.test(text)) continue
    return 'vendor-prefix'
  }
  return undefined
}

function privacyExclusionFor(text: string): ClientPrivacyExclusion | undefined {
  if (text.length === 0) return 'empty'
  if (isReferenceText(text)) return 'reference'
  if (PRIVACY_URL_SHAPE.test(text) || /^www\./i.test(text)) return 'url'
  if (PRIVACY_PATH_SHAPES.some((shape) => shape.test(text))) return 'path'
  if (PRIVACY_EMAIL_SHAPE.test(text)) return 'email'
  if (PRIVACY_DOMAIN_SHAPE.test(text)) return 'domain'
  if (hasCjk(text)) return 'cjk'
  if (text.includes('\n') || text.includes('\r')) return 'multi-line'
  if (/\s/.test(text)) return 'whitespace'
  if (privacyIdentifierLike(text)) return 'identifier'
  return undefined
}

function privacyStatisticalRule(text: string): ClientPrivacyRule | undefined {
  if (!PRIVACY_TOKEN_ALPHABET.test(text)) return undefined
  const { letters, digits } = privacyLetterAndDigitCounts(text)
  if (letters === 0 || digits === 0) return undefined
  const distinct = distinctCharCount(text)
  if (
    text.length >= PRIVACY_THRESHOLDS.longTokenMinLength
    && distinct >= PRIVACY_THRESHOLDS.longTokenMinDistinct
  ) {
    return 'long-concentrated'
  }
  if (
    text.length >= PRIVACY_THRESHOLDS.entropyTokenMinLength
    && distinct >= PRIVACY_THRESHOLDS.minDistinctChars
    && entropyBitsPerChar(text) >= PRIVACY_THRESHOLDS.minBitsPerChar
  ) {
    return 'high-entropy'
  }
  return undefined
}

/**
 * Mirror of `classifyPastedText` (`src/privacy.ts`): same order, same answer,
 * total and value-free. The paste path (a value field, R3) calls this and, when
 * `secret` is true, hands the text to the existing attach registration.
 */
function classifyPastedText(raw: string): ClientPrivacyVerdict {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const precise = privacyPreciseRule(text)
  if (precise !== undefined) return { secret: true, rule: precise }
  const exclusion = privacyExclusionFor(text)
  if (exclusion !== undefined) return { secret: false, exclusion }
  const statistical = privacyStatisticalRule(text)
  if (statistical !== undefined) return { secret: true, rule: statistical }
  return { secret: false }
}

/**
 * The clipboard reader, or undefined when this browser gives the page none.
 *
 * Asked once per click and never at module load: a browser without the API must
 * produce a message and a manual-paste hint, never a throw at script load.
 */
function clipboardReader(): (() => Promise<unknown>) | undefined {
  const navigatorLike = (globalThis as { navigator?: { clipboard?: { readText?: unknown } } }).navigator
  const clipboard = navigatorLike?.clipboard
  const readText = clipboard?.readText
  if (typeof readText !== 'function') return undefined
  return () => readText.call(clipboard) as Promise<unknown>
}

/**
 * Read the clipboard, trim it, and hand the text to `apply`.
 *
 * Never throws and never fails silently: a browser without the Clipboard API, a
 * refused read and an empty clipboard each put a fixed, dictionary-provided
 * message on screen telling the human to paste by hand. The text itself goes
 * only to `apply` — it is not logged, echoed, or stored anywhere here.
 */
async function pasteFromClipboard(options: {
  readonly t: (key: string) => string
  readonly setNotice: (message: string | null) => void
  readonly apply: (text: string) => void
}): Promise<void> {
  // (3): answer the click immediately. The browser's permission prompt can hold
  // `readText()` for a noticeable while, and a button that says nothing for that
  // long reads as broken. This is the same visible component and the same
  // dictionary; the outcome below replaces it.
  options.setNotice(options.t('pasteReading'))
  const read = clipboardReader()
  if (read === undefined) {
    options.setNotice(options.t('pasteUnavailable'))
    return
  }
  let raw: unknown
  try {
    raw = await read()
  } catch {
    options.setNotice(options.t('pasteDenied'))
    return
  }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) {
    options.setNotice(options.t('pasteEmpty'))
    return
  }
  // The reading state has been answered; whatever `apply` does next (including
  // setting its own message) is the outcome.
  options.setNotice(null)
  options.apply(text)
}

/**
 * Put the caret back in the field the button belongs to.
 *
 * The button lives in the field's own row, so the row's input or textarea is the
 * field the human was working in. Called as the last step of every click,
 * failure paths included: the point of the button is to save keystrokes, and a
 * click that leaves focus on a button costs a Tab.
 */
function focusAfterPaste(button: unknown): void {
  const row = (button as { parentElement?: { querySelector?: (selector: string) => unknown } } | null)?.parentElement
  const field = row?.querySelector?.('input, textarea') as { focus?: () => void } | null | undefined
  field?.focus?.()
}

/**
 * The suffix 「粘贴」 action every user-visible input gets (round 7, R2).
 *
 * `type="button"` so it can never submit anything; `aria-label` equal to the
 * visible text; `disabled` mirroring the field it belongs to; and a
 * `onMouseDown` that is prevented so pressing it does not move focus out of the
 * field before the click lands — the handler then hands focus back as its last
 * step regardless of how the read went.
 */
function pasteAction(options: {
  readonly t: (key: string) => string
  readonly className: string
  readonly disabled: boolean
  readonly setNotice: (message: string | null) => void
  readonly apply: (text: string) => void
}): unknown {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: options.className,
      'aria-label': options.t('paste'),
      'data-secret-paste': 'true',
      disabled: options.disabled,
      onMouseDown: (event: { preventDefault?: () => void }) => {
        event.preventDefault?.()
      },
      onClick: (event: unknown) => {
        // `currentTarget` is only valid during the handler, so the button node is
        // captured now and used once the clipboard read has settled.
        const button = (event as { currentTarget?: unknown }).currentTarget
        void pasteFromClipboard(options).then(() => {
          focusAfterPaste(button)
        })
      },
    },
    options.t('paste'),
  )
}

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
  // Test-only, like the blocks below: the stylesheet this surface injects, so a
  // test can hold the ✕'s visibility rules (default hidden, parent hover /
  // focus-within, `@media (hover:none)`) to the real text the page receives. It
  // is a constant string and carries no state and no value.
  ATTACH_CSS,
  // The mirrored privacy classifier (see the block above). Exposed so that one
  // test can hold this implementation and the reference one in `src/privacy.ts`
  // to the same answer: rule and exclusion sets, every threshold, and a shared
  // corpus case by case. **Test-only**: no production path reads these keys, and
  // they are pure functions and frozen constants — no state, no values.
  PRIVACY_RULES,
  PRIVACY_EXCLUSIONS,
  PRIVACY_THRESHOLDS,
  classifyPastedText,
  entropyBitsPerChar,
  distinctCharCount,
  isReferenceText,
  hasCjk,
  // Test-only, like the block above: the English dictionary is exposed so a test
  // can pin that both languages carry the paste copy (the rendered tree in tests
  // binds the Chinese one).
  ATTACH_EN,
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
  // Test-only, like the block above: the two pure readings the R5 conversion is
  // built from (the press-time selection, and the text a selection names across
  // the editor's two projections), the live-cue core whose failure mode the
  // documentation has to state, and the one default scope both attach paths
  // share. Total functions and frozen constants: no state, no values.
  selectedSpan,
  selectedTextIn,
  liveSelectionCue,
  DEFAULT_ATTACH_SCOPE,
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
  composerPasteOffer,
  guardComposerPaste,
  pendingComposerOffer,
  setComposerOffer,
  clearComposerOffer,
  insideComposerEditor,
  COMPOSER_EDITOR_SELECTOR,
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
  setAttachModeFor,
  resetSessionObservation,
  noteActiveSession,
  subscribeAttached,
  attachmentCount,
  sessionAttachments,
})

;(globalThis as unknown as { __cordisSecretAttach?: unknown }).__cordisSecretAttach = ATTACH_SEAM

/**
 * The management surface's own read-only seam.
 *
 * A third seam rather than more keys on either of the two above, for the reason
 * the second one gives: both of those are accepted, asserted contracts, and the
 * card's key set is asserted exactly by two test files. This one exposes the new
 * surface's pure logic and its definition. Frozen, stateless and value-free: the
 * management list it can reach holds names, scopes and the Host's own `can`
 * facts, never a value.
 */
const MANAGE_SEAM = Object.freeze({
  version: 1,
  MANAGE_PATH,
  MANAGE_TOOL_NAME,
  MANAGE_CARD_KIND,
  MANAGE_META_KIND,
  MANAGE_FAILURE,
  MANAGE_FAILURE_UNKNOWN,
  MANAGE_UNREACHABLE,
  readManageEntry,
  readManageList,
  readManagePending,
  readManageOutcome,
  parseManageCallRequest,
  asManageCardData,
  manageActionTitle,
  describeManage,
  refreshManage,
  manageOf,
  manageFailed,
  manageRead,
  manageErrorFor,
  postManage,
  secretManageDefinition,
  SecretManageCard,
  HiddenSecretManageToolRow,
})

;(globalThis as unknown as { __cordisSecretManage?: unknown }).__cordisSecretManage = MANAGE_SEAM

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
        // The management surface's own tool-row placeholder: appended beside the
        // request direction's own, which is untouched.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: MANAGE_TOOL_NAME }, HiddenSecretManageToolRow),
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
                // The shell calls these for the visible view: `setAttachMode`
                // binds the panel to the session observed for that view (D4b).
                open: () => setAttachMode({ kind: 'fill' }),
                close: () => setAttachMode({ kind: 'idle' }),
              }),
            },
            SecretAttachToggle,
          ),
        )
        // Requirement 2 (composer half): one compact 「粘贴」 control before the
        // submit action, acting on the editor through the seat's `inputActions`.
        // A different seat from the attach toggle (left) and the capsule
        // (overlay), so neither existing registration changes.
        ctx.slots.inject(INPUT_RIGHT_SLOT, () =>
          ctx.slots.register(
            {
              name: INPUT_RIGHT_SLOT,
              id: 'secret-paste-composer',
              order: 40,
            },
            SecretComposerPaste,
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
        // Round 5: the management card, appended after everything above so each
        // earlier registration keeps its identity, its key and its order. The two
        // cards can never claim each other's call: each matches one tool name.
        ctx.uiConversation.events.register(secretManageDefinition)
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: MANAGE_CARD_KIND }, SecretManageCard),
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
        })      },
    }
  },
})
