import { findAnchorSeq, type AnchorSessionLike } from './anchor.ts'
import type { SecretConfig } from './config.ts'
import { approvedResult, mapNonApproved, planGrant } from './decisions.ts'
import { GrantStore, type Grant, type GrantSessionLike } from './grants.ts'
import { effectiveEnvVar, recordKey, validateRequest } from './naming.ts'
import {
  PendingStore,
  SecretAbortedError,
  type PendingRequest,
  type Scheduler,
  type WaitOutcome,
} from './pending.ts'
import { parseAnswer } from './protocol.ts'
import { redactSecrets } from './redact.ts'
import type { ModalAnswer, PendingView, SecretRequestInput, SecretRequestResult } from './types.ts'

/** How the caller of `secret_request` relates to the live runtime. */
export type CallerClass =
  /** The exact live root session: only it has a human answerer. */
  | 'live-root'
  /** Not the registry's live agent instance (stale id, foreign session). */
  | 'not-live'
  /** A live agent owned by another agent (a delegated subagent). */
  | 'delegated'

/** One tool invocation, as the service needs it. */
export interface SecretCaller {
  readonly agent?: unknown
  readonly callId: string
  readonly signal: AbortSignal
}

/** Credential-store operations this plugin needs. */
export interface CredentialsPort {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  set(ref: string, value: string): Promise<void>
  /** Commit the durable authorization marker for one credential key. */
  commitRecord(key: string, payload: unknown): Promise<void>
}

/** What one authorization attempt needs from its flow. */
export interface AuthorizationAttemptInput {
  /** Record key this attempt authorizes. */
  readonly key: string
  /** Human-facing flow label. */
  readonly label: string
  /** Whether the dialog collected a value that must be written to the store. */
  readonly valueNeeded: boolean
  /** Collect the human's decision from the dialog (runs inside the flow). */
  answer(): Promise<ModalAnswer>
  /** Write the entered value through the credentials service. */
  persist(value: string): Promise<void>
  /** The non-secret marker payload committed for this key. */
  marker(): unknown
}

/** How one authorization attempt ended. */
export type AuthorizationAttemptResult =
  /** The flow committed its durable record and the seam observed it. */
  | { readonly status: 'authorized' }
  /** The attempt ended without a decision (withdrawn, or the seam cancelled it). */
  | { readonly status: 'cancelled' }
  /** The human declined, or chose a scope the seam cannot commit. */
  | { readonly status: 'escaped'; readonly reason: string }
  /** The attempt failed for an operational reason; the message is value-free. */
  | { readonly status: 'failed'; readonly message: string }

/** The `ctx.authorization` seam, reduced to what this plugin uses. */
export interface AuthorizationPort {
  attempt(input: AuthorizationAttemptInput): Promise<AuthorizationAttemptResult>
}

/** The `ctx.shellEnv` seam, reduced to what this plugin uses. */
export interface EnvPort {
  /** Declare (once) the contributor that serves one exposed variable. */
  ensure(envVar: string): void
}

/** Structured, value-free failure raised by this plugin. */
export class SecretFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SecretFailure'
    this.code = code
  }
}

/** Everything the service reads from its host. */
export interface SecretServiceDeps {
  readonly config: SecretConfig
  readonly credentials: CredentialsPort
  readonly authorization: AuthorizationPort
  readonly envs: EnvPort
  classifyCaller(agent: unknown): CallerClass
  sessionOf(agent: unknown): GrantSessionLike | undefined
  /** Live session used to anchor approvals; must expose the event log. */
  anchorSessionOf(agent: unknown): AnchorSessionLike | undefined
  now(): number
  schedule: Scheduler
  newId(): string
}

/** The result of one dialog submission, as the route reports it. */
export type AnswerOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * The one operation behind both callers: the agent tool and the Web dialog.
 *
 * The service owns validation, caller authority, anchoring, the dialog
 * conversation, the storage route and the session grant. It never returns,
 * logs or throws a secret value.
 */
export class SecretService {
  readonly grants: GrantStore
  readonly pending = new PendingStore()
  private readonly deps: SecretServiceDeps

  constructor(deps: SecretServiceDeps, grants: GrantStore = new GrantStore()) {
    this.deps = deps
    this.grants = grants
  }

  /** The dialog-facing view of every waiting interaction. */
  views(): readonly PendingView[] {
    return this.pending.views()
  }

  /**
   * Submit one decision from the dialog.
   * @param raw - parsed JSON body.
   */
  answer(raw: unknown): AnswerOutcome {
    const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
    const id = body?.id
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, status: 400, error: 'answer.id is required' }
    }
    const request = this.pending.get(id)
    if (request === undefined) {
      return { ok: false, status: 409, error: 'this authorization request is no longer waiting' }
    }
    const parsed = parseAnswer(raw, !request.alreadyConfigured)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    if (!this.pending.settle(id, parsed.answer)) {
      return { ok: false, status: 409, error: 'this authorization request was already answered' }
    }
    return { ok: true }
  }

  /**
   * Run one `secret_request`.
   * @param raw - model arguments, validated here.
   * @param caller - agent, tool-call identity, and cancellation.
   */
  async request(raw: unknown, caller: SecretCaller): Promise<SecretRequestResult> {
    const validated = validateRequest(raw)
    if (!validated.ok) throw new SecretFailure('BAD_REQUEST', validated.error)
    const input = validated.value

    const callerClass = this.deps.classifyCaller(caller.agent)
    if (callerClass !== 'live-root') throw callerFailure(callerClass)

    const session = this.deps.sessionOf(caller.agent)
    const anchorSession = this.deps.anchorSessionOf(caller.agent)
    if (session === undefined || anchorSession === undefined) {
      throw new SecretFailure(
        'NO_SESSION',
        'secret_request: 找不到该 agent 的活跃会话，无法把授权锚定到本次工具调用；请在会话根代理中重试。',
      )
    }
    const anchorSeq = findAnchorSeq(anchorSession, caller.callId)
    if (anchorSeq === undefined) {
      throw new SecretFailure(
        'NO_ANCHOR',
        `secret_request: 无法在会话日志中定位工具调用 ${caller.callId} 的锚点事件；授权将无法在会话回退时失效，因此拒绝请求。`,
      )
    }

    const envVar = effectiveEnvVar(input)
    const described = await this.deps.credentials.describe(envVar)
    const alreadyConfigured = described.configured

    const id = this.deps.newId()
    const pending = this.pending.add(
      {
        id,
        name: input.name,
        envVar,
        label: input.label,
        reason: input.reason,
        ...(input.description === undefined ? {} : { description: input.description }),
        requestedScope: input.scope,
        alreadyConfigured,
        createdAt: this.deps.now(),
      },
      this.deps.config.maxPendingRequests,
    )
    if (pending === undefined) {
      throw new SecretFailure(
        'TOO_MANY_PENDING',
        `secret_request: 已有 ${String(this.deps.config.maxPendingRequests)} 个授权请求在等待人工确认，请先处理它们再重试。`,
      )
    }

    try {
      const outcome = await this.converse(input, pending, envVar, alreadyConfigured, caller)
      if (outcome.kind === 'timeout') {
        throw new SecretFailure(
          'TIMEOUT',
          `secret_request: 等待人工确认超过 ${String(this.deps.config.requestTimeoutMs)}ms 未获答复（可能没有打开可交互的 Web 界面）。未获授权，本次不会注入任何变量。`,
        )
      }
      return await this.complete(input, outcome.answer, {
        envVar,
        alreadyConfigured,
        session,
        anchorSeq,
        callId: caller.callId,
      })
    } finally {
      this.pending.remove(id)
    }
  }

  /**
   * Collect the human's decision.
   *
   * A `persistent` request runs inside the `ctx.authorization` seam: that is the
   * Harness's own credential-obtaining conversation, and its contract commits a
   * durable record for the key. A `session` request cannot use that seam — the
   * seam refuses to settle an attempt that committed nothing durable, and a
   * session grant must never touch disk — so it drives the same dialog directly
   * and keeps the value in memory.
   */
  private async converse(
    input: SecretRequestInput,
    pending: PendingRequest,
    envVar: string,
    alreadyConfigured: boolean,
    caller: SecretCaller,
  ): Promise<WaitOutcome> {
    let answerPromise: Promise<WaitOutcome> | undefined
    const settleOnce = (): Promise<WaitOutcome> => {
      answerPromise ??= this.pending.wait(pending.id, {
        signal: caller.signal,
        timeoutMs: this.deps.config.requestTimeoutMs,
        schedule: this.deps.schedule,
      })
      return answerPromise
    }
    const recorded = (): ModalAnswer | undefined => this.pending.get(pending.id)?.answer
    /** Last decision handed to the flow, kept for value-free failure redaction. */
    let lastAnswer: ModalAnswer | undefined

    if (input.scope === 'session') return await settleOnce()

    const attempt = await this.deps.authorization.attempt({
      key: recordKey(input.name),
      label: input.label,
      valueNeeded: !alreadyConfigured,
      answer: async () => {
        const outcome = await settleOnce()
        if (outcome.kind === 'timeout') {
          throw new SecretFailure('TIMEOUT', 'secret_request: 等待人工确认超时。')
        }
        lastAnswer = outcome.answer
        return outcome.answer
      },
      persist: async (value) => {
        await this.deps.credentials.set(envVar, value)
      },
      marker: () => ({
        version: 1,
        envVar,
        name: input.name,
        scope: 'persistent',
        authorizedAt: this.deps.now(),
      }),
    })

    const answer = recorded()
    if (answer !== undefined) return { kind: 'answer', answer }
    if (attempt.status === 'failed') {
      throw new SecretFailure(
        'AUTHORIZATION_FAILED',
        redactSecrets(
          `secret_request: 凭据授权流程失败：${attempt.message}`,
          lastAnswer?.decision === 'approved' ? [lastAnswer.value] : [],
        ),
      )
    }
    throw new SecretFailure(
      'AUTHORIZATION_CANCELLED',
      'secret_request: 授权尝试在人工答复前被取消（可能同一凭据已有另一个授权尝试在进行中）。未获授权。',
    )
  }

  /** Materialize one approved decision and record the session grant. */
  private async complete(
    input: SecretRequestInput,
    answer: ModalAnswer,
    context: {
      readonly envVar: string
      readonly alreadyConfigured: boolean
      readonly session: GrantSessionLike
      readonly anchorSeq: number
      readonly callId: string
    },
  ): Promise<SecretRequestResult> {
    if (answer.decision !== 'approved') return mapNonApproved(answer)

    const plan = planGrant({
      answerScope: answer.scope,
      ...(answer.value === undefined ? {} : { answerValue: answer.value }),
      alreadyConfigured: context.alreadyConfigured,
    })

    let value: string
    if (plan.persistValue !== undefined) {
      value = plan.persistValue
    } else if (plan.resolveValue) {
      const resolved = await this.deps.credentials.resolve(context.envVar)
      if (resolved === undefined) {
        throw new SecretFailure(
          'STORE_EMPTY',
          `secret_request: 凭据库中已没有 ${context.envVar} 的值（可能刚刚被移除）；请重新授权并提供新的值。`,
        )
      }
      value = resolved.value
    } else {
      throw new SecretFailure('NO_VALUE', 'secret_request: 未获得任何值，已放弃本次授权。')
    }

    const sessionId = String(context.session.id)
    const revocation = this.grants.revocationFor(sessionId, input.name)
    const grant: Grant = {
      sessionId,
      name: input.name,
      envVar: context.envVar,
      scope: plan.scope,
      value,
      source: plan.source,
      anchorSeq: context.anchorSeq,
      callId: context.callId,
      replaceGenerationAtApproval: context.session.surface.replaceGeneration,
      authorizedAt: this.deps.now(),
    }
    this.grants.put(grant)
    this.deps.envs.ensure(context.envVar)

    const notice = revocation === undefined
      ? undefined
      : revocation.code === 'revoked-anchor'
        ? '上一次授权所锚定的事件已不在当前会话表面上（会话回退/重写，或该事件被压缩覆盖），因此已失效并被本次重新授权覆盖。'
        : '上一次授权已不再属于本会话（会话分叉或结束），本次重新授权覆盖了它。'
    return approvedResult(plan, context.envVar, notice)
  }
}

/** The structured, value-free failure one caller class produces. */
export function callerFailure(callerClass: Exclude<CallerClass, 'live-root'>): SecretFailure {
  if (callerClass === 'not-live') {
    return new SecretFailure(
      'CALLER_NOT_LIVE',
      'secret_request: 只有活跃的会话根代理能够请求人工授权。本调用者不是注册表中的活跃 agent 实例（可能是陈旧或非本机的会话），因此不会等待人工回答。请在会话根代理中调用。',
    )
  }
  return new SecretFailure(
    'DELEGATED_CALLER',
    'secret_request: 只有活跃的会话根代理拥有可回答的人类；被委派的子代理（subagent）没有人工回答者，因此这里不会等待，也不会有人回答。请让父会话/主会话调用 secret_request，再把返回的变量名交给子代理使用。',
  )
}

export { SecretAbortedError }
