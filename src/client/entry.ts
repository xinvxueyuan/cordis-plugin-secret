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
 * The dialog is the only place a secret value is ever typed. It travels in the
 * body of one authenticated POST to this plugin's own `/api` route and nowhere
 * else: never a query string, never a URL, never the session log.
 */

/** Just enough React surface for this one component. */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void]
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
}

interface PendingViewLike {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly reason: string
  readonly description?: string
  readonly requestedScope: 'session' | 'persistent'
  readonly variable: string
  readonly alreadyConfigured: boolean
}

type Scope = 'session' | 'persistent'
type Decision = 'approved' | 'rejected' | 'ignored' | 'other'

const PACKAGE_ID = '@xinvxueyuan/cordis-plugin-secret'
const SLOT_ID = 'secret.request.dialog'
const PENDING_PATH = '/api/secret.pending'
const ANSWER_PATH = '/api/secret.answer'
const POLL_MS = 1200
/** How long a one-shot notice stays on screen before dismissing itself. */
const NOTICE_MS = 8000

/** Every visible string of the dialog (this profile's UI language is Chinese). */
const TEXT = {
  title: '需要凭据授权',
  reasonCaption: '申请理由（原样展示给你）',
  descriptionCaption: '补充说明',
  scopeCaption: '授权范围',
  scopeSession: '仅本次会话有效',
  scopeSessionNote: '只在内存中保留，会话结束/回退/fork 后立即失效，不落盘。',
  scopePersistent: '持久保存到凭据库',
  scopePersistentNote: '写入 Harness 凭据库，之后可直接复用（落盘）。',
  requestedBy: 'Agent 请求的范围：',
  overridden: '你已把范围改为：',
  variableCaption: '对外暴露的变量名',
  valueCaption: '密钥值（只发给本机 Host，不进入会话记录）',
  valuePlaceholder: '粘贴密钥…',
  reveal: '显示',
  hide: '隐藏',
  configured: '该凭据已存在于凭据库，本次无需重新输入，只需决定是否授权本次使用。',
  approve: '同意',
  reject: '拒绝',
  ignore: '忽略',
  other: '其他',
  submitOther: '提交指示',
  back: '返回',
  otherCaption: '你希望 Agent 怎么做？',
  otherPlaceholder: '用自由文本告诉 Agent 你的指示…',
  busy: '提交中…',
  rejectHint: '拒绝：Agent 会停止，不会重试。',
  ignoreHint: '忽略：本次不授权，Agent 可稍后再问。',
  expired: '该授权请求已结束（超时、被取消，或已在另一个窗口处理），对话框已自动关闭。',
  dismiss: '关闭',
} as const

function firstView(payload: unknown): PendingViewLike | null {
  if (typeof payload !== 'object' || payload === null) return null
  const requests = (payload as { requests?: unknown }).requests
  if (!Array.isArray(requests) || requests.length === 0) return null
  const candidate = requests[0] as Partial<PendingViewLike>
  if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') return null
  return {
    id: candidate.id,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    label: candidate.label,
    reason: typeof candidate.reason === 'string' ? candidate.reason : '',
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    requestedScope: candidate.requestedScope === 'persistent' ? 'persistent' : 'session',
    variable: typeof candidate.variable === 'string' ? candidate.variable : '',
    alreadyConfigured: candidate.alreadyConfigured === true,
  }
}

/** Ids of every interaction still waiting, so a stale dialog can notice its own end. */
function waitingIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const requests = (payload as { requests?: unknown }).requests
  if (!Array.isArray(requests)) return []
  const ids: string[] = []
  for (const entry of requests) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

const loader = (globalThis as unknown as { __ModuleLoader__?: ModuleLoaderTarget }).__ModuleLoader__

loader?.load({
  id: PACKAGE_ID,
  factory(require) {
    const React = require('react') as ReactLike
    const h = React.createElement

    const overlayStyle: Record<string, unknown> = {
      position: 'fixed',
      inset: 0,
      zIndex: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      background: 'var(--dsw-alias-bg-mask-1)',
      // The overlay layer is click-through by design; this occupant opts back in.
      pointerEvents: 'auto',
    }
    const cardStyle: Record<string, unknown> = {
      width: 'min(560px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 48px)',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '20px',
      borderRadius: 'var(--dsw-radius-lg)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      boxShadow: 'var(--dsw-shadow-lv2)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'var(--dsw-font-family)',
      fontSize: 'var(--dsw-font-s-14-font-size, 14px)',
      lineHeight: 'var(--dsw-font-s-14-line-height, 20px)',
      outline: 'none',
    }
    const blockStyle: Record<string, unknown> = {
      padding: '10px 12px',
      marginTop: '10px',
      borderRadius: 'var(--dsw-radius-md)',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
    }
    const captionStyle: Record<string, unknown> = {
      fontSize: 'var(--dsw-font-xs-13-font-size, 13px)',
      color: 'var(--dsw-alias-label-tertiary)',
      marginBottom: '4px',
    }
    const inputStyle: Record<string, unknown> = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 'var(--dsw-radius-md)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
    }

    function buttonStyle(kind: 'primary' | 'ghost' | 'danger'): Record<string, unknown> {
      const base: Record<string, unknown> = {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        cursor: 'pointer',
      }
      if (kind === 'primary') {
        return {
          ...base,
          border: '1px solid transparent',
          background: 'var(--dsw-alias-button-primary-fill)',
          color: 'var(--dsw-alias-label-primary-foreground)',
        }
      }
      if (kind === 'danger') return { ...base, color: 'var(--dsw-alias-state-error-primary)' }
      return base
    }

    function SecretDialog() {
      const [request, setRequest] = React.useState<PendingViewLike | null>(null)
      const [value, setValue] = React.useState('')
      const [reveal, setReveal] = React.useState(false)
      const [scope, setScope] = React.useState<Scope>('session')
      const [mode, setMode] = React.useState<'decide' | 'other'>('decide')
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState<string | null>(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState<string | null>(null)

      /** One selectable scope, with the notice that explains what it means. */
      function scopeOption(next: Scope, title: string, note: string) {
        return h(
          'label',
          {
            key: next,
            style: {
              display: 'flex',
              gap: '8px',
              alignItems: 'flex-start',
              padding: '6px 0',
              cursor: 'pointer',
            },
          },
          h('input', {
            type: 'radio',
            name: 'dsh-secret-scope',
            checked: scope === next,
            onChange: () => setScope(next),
            style: { marginTop: '2px' },
          }),
          h(
            'span',
            null,
            h('span', { style: { display: 'block' } }, title),
            h('span', { style: { ...captionStyle, marginBottom: 0 } }, note),
          ),
        )
      }

      /**
       * The interaction currently on screen. The poll keys on this id rather than
       * on the whole view object, so a re-poll never overwrites what the human is
       * typing.
       */
      const displayedId = request === null ? null : request.id

      React.useEffect(() => {
        let alive = true
        const adopt = (view: PendingViewLike) => {
          setValue('')
          setText('')
          setError(null)
          setMode('decide')
          setReveal(false)
          setScope(view.requestedScope)
          setNotice(null)
          setRequest(view)
        }
        const poll = () => {
          void fetch(PENDING_PATH, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
            .then(async (response) => (response.ok ? await response.json() : undefined))
            .then((payload: unknown) => {
              if (!alive) return
              if (displayedId === null) {
                const view = firstView(payload)
                if (view !== null) adopt(view)
                return
              }
              // Keep an open dialog while its request is still waiting, and close
              // it the moment the Host dropped it — a timeout, a cancellation, a
              // reload, or an answer from another window. The overlay covers the
              // whole viewport and opts back into pointer events, so it must never
              // outlive its request.
              if (waitingIds(payload).includes(displayedId)) return
              setValue('')
              setText('')
              setError(null)
              setRequest(null)
              setNotice(TEXT.expired)
            })
            .catch(() => undefined)
        }
        poll()
        const timer = setInterval(poll, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [displayedId])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      async function submit(decision: Decision) {
        if (request === null || busy) return
        setBusy(true)
        setError(null)
        const body: Record<string, unknown> = { id: request.id, decision }
        if (decision === 'approved') {
          body.scope = scope
          if (!request.alreadyConfigured) body.value = value
        }
        if (decision === 'other') body.text = text
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
          if (payload?.ok !== true) {
            // A 409 means the Host is no longer waiting for this interaction
            // (timeout, another window answered it, or the plugin reloaded).
            // Keeping the dialog open would leave the full-viewport overlay stuck
            // with nothing left to answer, so close it and say why.
            if (response.status === 409) {
              setValue('')
              setText('')
              setRequest(null)
              setNotice(TEXT.expired)
              setBusy(false)
              return
            }
            setError(payload?.error ?? `提交失败（HTTP ${String(response.status)}）`)
            setBusy(false)
            return
          }
          setValue('')
          setText('')
          setRequest(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : '提交失败')
        } finally {
          setBusy(false)
          // The value is never logged, echoed or retained after submission.
        }
      }

      React.useEffect(() => {
        if (request === null) return undefined
        const onKey = (event: KeyboardEvent) => {
          if (event.key === 'Escape' && !busy) void submit('ignored')
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
        }
      }, [request, busy, scope, value, mode, text])

      if (request === null) {
        if (notice === null) return null
        // A one-shot, non-blocking notice: it never covers the UI the way the
        // dialog does (the wrapper is click-through; only the card is not).
        return h(
          'div',
          {
            style: {
              position: 'fixed',
              left: '50%',
              bottom: '24px',
              transform: 'translateX(-50%)',
              zIndex: 40,
              pointerEvents: 'none',
            },
          },
          h(
            'div',
            {
              role: 'status',
              style: {
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
                maxWidth: 'min(560px, calc(100vw - 32px))',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 'var(--dsw-radius-md)',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-base)',
                boxShadow: 'var(--dsw-shadow-lv2)',
                color: 'var(--dsw-alias-label-primary)',
                fontFamily: 'var(--dsw-font-family)',
                fontSize: 'var(--dsw-font-s-14-font-size, 14px)',
                pointerEvents: 'auto',
              },
            },
            h('span', null, notice),
            h(
              'button',
              { type: 'button', onClick: () => setNotice(null), style: buttonStyle('ghost') },
              TEXT.dismiss,
            ),
          ),
        )
      }

      const scopeTitle = scope === 'persistent' ? TEXT.scopePersistent : TEXT.scopeSession
      const requestedTitle = request.requestedScope === 'persistent' ? TEXT.scopePersistent : TEXT.scopeSession
      const overridden = scope !== request.requestedScope

      const children: unknown[] = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 'var(--dsw-font-m-18-font-size, 16px)', fontWeight: 600 } }, TEXT.title),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, request.label),
        ),
        h(
          'div',
          { key: 'variable', style: { ...captionStyle, marginTop: '6px' } },
          `${TEXT.variableCaption}：${request.variable}`,
        ),
        h(
          'div',
          { key: 'reason', style: blockStyle },
          h('div', { style: captionStyle }, TEXT.reasonCaption),
          h('div', { style: { whiteSpace: 'pre-wrap' } }, request.reason),
        ),
      ]

      if (request.description !== undefined) {
        children.push(
          h(
            'div',
            { key: 'description', style: blockStyle },
            h('div', { style: captionStyle }, TEXT.descriptionCaption),
            h('div', { style: { whiteSpace: 'pre-wrap' } }, request.description),
          ),
        )
      }

      children.push(
        h(
          'div',
          { key: 'scope', style: blockStyle },
          h('div', { style: captionStyle }, TEXT.scopeCaption),
          h('div', { style: { fontWeight: 600 } }, `${scopeTitle}`),
          h('div', { style: captionStyle }, `${TEXT.requestedBy}${requestedTitle}`),
          overridden
            ? h('div', { style: { color: 'var(--dsw-alias-state-warn-label)' } }, `${TEXT.overridden}${scopeTitle}`)
            : null,
          scopeOption('session', TEXT.scopeSession, TEXT.scopeSessionNote),
          scopeOption('persistent', TEXT.scopePersistent, TEXT.scopePersistentNote),
        ),
      )

      if (request.alreadyConfigured) {
        children.push(
          h('div', { key: 'configured', style: blockStyle }, TEXT.configured),
        )
      } else {
        children.push(
          h(
            'div',
            { key: 'value', style: blockStyle },
            h('div', { style: captionStyle }, TEXT.valueCaption),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: reveal ? 'text' : 'password',
                value,
                autoFocus: true,
                autoComplete: 'new-password',
                spellCheck: false,
                placeholder: TEXT.valuePlaceholder,
                onChange: (event: { target: { value: string } }) => setValue(event.target.value),
                style: inputStyle,
                'aria-label': TEXT.valueCaption,
              }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setReveal(!reveal),
                  'aria-pressed': reveal,
                  style: buttonStyle('ghost'),
                },
                reveal ? TEXT.hide : TEXT.reveal,
              ),
            ),
          ),
        )
      }

      if (mode === 'other') {
        children.push(
          h(
            'div',
            { key: 'other', style: blockStyle },
            h('div', { style: captionStyle }, TEXT.otherCaption),
            h('textarea', {
              value: text,
              rows: 3,
              autoFocus: true,
              placeholder: TEXT.otherPlaceholder,
              onChange: (event: { target: { value: string } }) => setText(event.target.value),
              style: { ...inputStyle, resize: 'vertical' },
              'aria-label': TEXT.otherCaption,
            }),
          ),
        )
      }

      if (error !== null) {
        children.push(
          h(
            'div',
            { key: 'error', style: { marginTop: '10px', color: 'var(--dsw-alias-state-error-primary)' } },
            error,
          ),
        )
      }

      children.push(
        h(
          'div',
          {
            key: 'actions',
            style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px', flexWrap: 'wrap' },
          },
          mode === 'other'
            ? h('button', { type: 'button', onClick: () => setMode('decide'), style: buttonStyle('ghost') }, TEXT.back)
            : null,
          mode === 'other'
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: busy || text.trim().length === 0,
                  onClick: () => void submit('other'),
                  style: buttonStyle('primary'),
                },
                TEXT.submitOther,
              )
            : h(
                'button',
                {
                  type: 'button',
                  autoFocus: request.alreadyConfigured,
                  disabled: busy || (!request.alreadyConfigured && value.length === 0),
                  onClick: () => void submit('approved'),
                  style: buttonStyle('primary'),
                },
                TEXT.approve,
              ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              title: TEXT.rejectHint,
              onClick: () => void submit('rejected'),
              style: buttonStyle('danger'),
            },
            TEXT.reject,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              title: TEXT.ignoreHint,
              onClick: () => void submit('ignored'),
              style: buttonStyle('ghost'),
            },
            TEXT.ignore,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => setMode(mode === 'other' ? 'decide' : 'other'),
              style: buttonStyle('ghost'),
            },
            TEXT.other,
          ),
        ),
      )
      if (busy) {
        children.push(
          h('div', { key: 'busy', style: { ...captionStyle, textAlign: 'right', marginTop: '6px' } }, TEXT.busy),
        )
      }

      return h(
        'div',
        { style: overlayStyle },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': TEXT.title,
            tabIndex: -1,
            style: cardStyle,
          },
          children,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx: ClientContextLike) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: SLOT_ID, order: 40, label: TEXT.title },
            SecretDialog,
          ),
        )
      },
    }
  },
})
