import { findAnchorSeq, type AnchorSessionLike } from './anchor.ts'
import { type AttachDropReason, type AttachStore, type BoundAttach } from './attach.ts'
import type { SecretConfig } from './config.ts'
import { approvedResult, mapNonApproved, planGrant } from './decisions.ts'
import { GrantStore, type Grant, type GrantSessionLike } from './grants.ts'
import { HistoryStore } from './history.ts'
import {
  effectiveEnvVar,
  isCredentialName,
  isExposedEnvVar,
  RECORD_SCOPE,
  recordKey,
  validateRequest,
} from './naming.ts'
import {
  PendingStore,
  SecretAbortedError,
  type PendingRequest,
  type Scheduler,
  type WaitOutcome,
} from './pending.ts'
import { availableView, historyView, parseAdopt, parseAnswer, parseAttach, parseRelease } from './protocol.ts'
import { redactSecrets } from './redact.ts'
import type {
  ModalAnswer,
  PendingView,
  SecretAttachedView,
  SecretAttachOutcome,
  SecretAttachState,
  SecretAvailableEntry,
  SecretHistoryEntry,
  SecretHistoryEvent,
  SecretHistorySource,
  SecretHistoryView,
  SecretRequestInput,
  SecretRequestResult,
  SecretScope,
} from './types.ts'

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

/** One credential-store record address, as enumeration reports it (value-free). */
export interface CredentialRecordRef {
  readonly key: string
  /** Record kind tag the store assigned (this plugin commits `grant`). */
  readonly kind: string
}

/** One credential-store record read back by key. */
export interface CredentialRecordRead {
  readonly kind: string
  readonly payload: unknown
}

/** Credential-store operations this plugin needs. */
export interface CredentialsPort {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  set(ref: string, value: string): Promise<void>
  /** Commit the durable authorization marker for one credential key. */
  commitRecord(key: string, payload: unknown): Promise<void>
  /**
   * Enumerate the store's records.
   *
   * Optional to the rest of the plugin's job: an environment whose credentials
   * implementation cannot enumerate answers "nothing to enumerate", and the `@`
   * menu then lists only what the session itself holds. Enumeration is
   * value-free by contract — it reports record addresses, never payloads.
   */
  listRecords?(): Promise<readonly CredentialRecordRef[]>
  /**
   * Read one record back by key; a key with no record, or a store without
   * read-back, answers undefined.
   */
  readRecord?(key: string): Promise<CredentialRecordRead | undefined>
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
  /** Staged secrets a human attached and has not sent yet. */
  readonly attachments: AttachStore
  /**
   * The session-scoped, memory-only record of what happened to every secret
   * this session ever carried. It is the only place a released, discarded,
   * expired or revoked entry still exists, and it holds no value.
   *
   * Omitted, the service keeps its own store of the same shape (the unit
   * harnesses do this); production injects the one the plugin owns so the
   * `session/disposed` hook can forget a session's history with its grants.
   */
  readonly history?: HistoryStore
  classifyCaller(agent: unknown): CallerClass
  sessionOf(agent: unknown): GrantSessionLike | undefined
  /** The live session one attach submission names, or undefined. */
  sessionById(id: string): GrantSessionLike | undefined
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

/** The result of one attach submission, as the route reports it. */
export type AttachOutcome =
  | { readonly ok: true; readonly outcome: SecretAttachOutcome }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** The result of one release request, as the route reports it. */
export type ReleaseOutcome =
  | { readonly ok: true; readonly released: boolean; readonly state: SecretAttachState | 'none' }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** The result of one adopt request, as the route reports it. */
export type AdoptOutcome =
  | {
      readonly ok: true
      readonly outcome: { readonly variable: string; readonly scope: SecretScope; readonly replaced: boolean }
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

/**
 * The value-free facts one durable marker carries.
 *
 * Two writers commit markers (the attach direction adds `kind:'attachment'`, the
 * ask direction does not), so this reader tolerates both shapes and insists only
 * on what both promise: the exposed variable, the credential key, and a durable
 * scope. Anything else is not one of ours and is skipped rather than guessed at.
 */
function markerFacts(payload: unknown): { readonly envVar: string; readonly name: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (record.scope !== 'persistent') return undefined
  if (!isExposedEnvVar(record.envVar)) return undefined
  if (!isCredentialName(record.name)) return undefined
  return { envVar: record.envVar, name: record.name }
}

/**
 * How collecting one decision ended.
 *
 * `notice` is carried separately from the answer so the approved result can
 * report truthfully (for example: the durable registration could not be
 * confirmed, so the grant was degraded to this session only) without pretending
 * the flow succeeded.
 */
export type ConverseResult =
  | { readonly kind: 'answer'; readonly answer: ModalAnswer; readonly notice?: string }
  | { readonly kind: 'timeout' }

/** The fixed, value-free failure one credential-store read produces. */
const STORE_READ_FAILED_MESSAGE = '凭据库读取失败；细节已省略'

/**
 * The fixed, value-free failure one credential-store write produces.
 *
 * Identical discipline to the read above: a backend that fails after being
 * handed the value may quote it in its own error text, so the text is dropped
 * and only our own wording is reported.
 */
const ATTACH_STORE_FAILED_MESSAGE = '凭据库写入失败；细节已省略，本次附加未登记'

/**
 * Run one credential-store read, collapsing every upstream failure into this
 * plugin's own value-free failure.
 *
 * A credential backend's error text is outside this plugin's control: it may
 * quote the reference, a path, or whatever the provider chose to print. None of
 * that belongs in a tool result, so the message here is fixed and the upstream
 * error is dropped rather than forwarded.
 */
async function readStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    throw new SecretFailure('STORE_READ_FAILED', STORE_READ_FAILED_MESSAGE)
  }
}

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
  /**
   * Attachment metadata per session, keyed by exposed variable.
   *
   * Only what the capsule needs to describe an entry that has left the staged
   * store — the credential key, a label, a scope and when it was created (plus
   * the anchor of a bound entry, for the history). It never holds a value: the
   * value lives in the staged store until it is bound, and afterwards only in
   * the grant store.
   */
  private readonly attached = new Map<
    string,
    Map<string, { name: string; label: string; scope: SecretScope; createdAt: number; anchorSeq?: number }>
  >()
  /** The history this service writes to: the injected one, or its own. */
  private readonly history: HistoryStore
  private readonly deps: SecretServiceDeps

  constructor(deps: SecretServiceDeps, grants: GrantStore = new GrantStore()) {
    this.deps = deps
    this.grants = grants
    this.history = deps.history ?? new HistoryStore({ capacity: deps.config.maxHistoryPerSession })
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
   * Register one human-attached secret for a session.
   *
   * Staging is not exposure. Nothing is injected while the attach waits for the
   * message that carries it: a staged entry is invisible to the grant store, so
   * an attach that is never sent yields no variable, no contributor and no
   * grant. The single durable write in this plugin's reverse direction happens
   * here, and only because the human explicitly chose `persistent`.
   *
   * @param raw - parsed JSON body of the attach request.
   */
  async attach(raw: unknown): Promise<AttachOutcome> {
    const parsed = parseAttach(raw)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    const input = parsed.value
    const session = this.deps.sessionById(input.sessionId)
    if (session === undefined) {
      return { ok: false, status: 404, error: 'attach: 找不到该会话，本次附加未登记' }
    }
    const existing = this.deps.attachments.get(input.sessionId, input.envVar)
    if (existing === undefined && this.deps.attachments.countFor(input.sessionId) >= this.deps.config.maxAttachmentsPerSession) {
      return {
        ok: false,
        status: 409,
        error: `attach: 本会话登记的附加密钥已达上限（${String(this.deps.config.maxAttachmentsPerSession)}）`,
      }
    }

    if (input.scope === 'persistent') {
      try {
        await this.deps.credentials.set(input.envVar, input.value)
        // The durable record is the value-free marker, exactly as the agent-ask
        // direction commits it: an authorization exists for this key, and the
        // marker never quotes what was written.
        await this.deps.credentials.commitRecord(recordKey(input.name), {
          version: 1,
          kind: 'attachment',
          envVar: input.envVar,
          name: input.name,
          scope: 'persistent',
          authorizedAt: this.deps.now(),
        })
      } catch {
        // The backend's own text can quote the value it was handed, so it is
        // dropped rather than forwarded (the same rule as a store read).
        return { ok: false, status: 500, error: ATTACH_STORE_FAILED_MESSAGE }
      }
    }

    const written = this.deps.attachments.put({
      sessionId: input.sessionId,
      name: input.name,
      label: input.label,
      scope: input.scope,
      envVar: input.envVar,
      value: input.value,
      createdAt: this.deps.now(),
    })
    if (written === undefined) {
      return {
        ok: false,
        status: 409,
        error: `attach: 本会话登记的附加密钥已达上限（${String(this.deps.config.maxAttachmentsPerSession)}）`,
      }
    }
    this.note(input.sessionId, 'staged', input.envVar, {
      name: input.name,
      label: input.label,
      scope: input.scope,
      source: 'attach',
      replaced: written.replaced,
    })
    return {
      ok: true,
      outcome: { variable: input.envVar, scope: input.scope, replaced: written.replaced },
    }
  }

  /**
   * Drop one staged attach.
   *
   * A bound attachment is not released here on purpose: it is anchored to a
   * message, and the only truthful way to take it back is to take the message
   * back. The caller is told which state it found instead of being told a lie.
   */
  release(raw: unknown): ReleaseOutcome {
    const parsed = parseRelease(raw)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    const { sessionId, envVar, reason } = parsed.value
    // Read the entry before it is dropped: a history entry has to name the
    // credential and its scope, and the store is the only place they exist.
    const staged = this.deps.attachments.get(sessionId, envVar)
    if (this.deps.attachments.remove(sessionId, envVar)) {
      this.attached.get(sessionId)?.delete(envVar)
      if (staged !== undefined) {
        this.note(sessionId, reason === 'withdrawn' ? 'withdrawn' : 'discarded', envVar, {
          name: staged.name,
          label: staged.label,
          scope: staged.scope,
          source: 'attach',
        })
      }
      return { ok: true, released: true, state: 'staged' }
    }
    const session = this.deps.sessionById(sessionId)
    const bound = session !== undefined && this.liveGrant(session, envVar) !== undefined
    return { ok: true, released: false, state: bound ? 'bound' : 'none' }
  }

  /**
   * The capsule-facing view of every secret a human attached in one session.
   *
   * An entry whose bound message has left the live surface (a rewind, a fork, a
   * session end) is forgotten here, so the capsule can never report an exposure
   * that no longer exists.
   */
  attachedViews(sessionId: string): readonly SecretAttachedView[] {
    const views: SecretAttachedView[] = []
    const seen = new Set<string>()
    for (const item of this.deps.attachments.list(sessionId)) {
      views.push({
        variable: item.envVar,
        name: item.name,
        label: item.label,
        scope: item.scope,
        state: 'staged',
        createdAt: item.createdAt,
      })
      seen.add(item.envVar)
    }
    const known = this.attached.get(sessionId)
    if (known === undefined) return views
    const session = this.deps.sessionById(sessionId)
    for (const [envVar, meta] of [...known]) {
      if (seen.has(envVar)) continue
      const live = session === undefined ? undefined : this.liveGrant(session, envVar)
      if (live === undefined) {
        known.delete(envVar)
        // A bound entry whose anchor left the live surface is observed here and
        // nowhere else: the history reports a revocation only once somebody has
        // actually looked, so it never invents an exposure nobody could see.
        this.note(sessionId, 'revoked', envVar, {
          name: meta.name,
          label: meta.label,
          scope: meta.scope,
          source: 'attach',
          ...(meta.anchorSeq === undefined ? {} : { anchorSeq: meta.anchorSeq }),
        })
        continue
      }
      views.push({
        variable: envVar,
        name: live.name,
        label: meta.label,
        scope: live.scope,
        state: 'bound',
        createdAt: meta.createdAt,
      })
    }
    return views
  }

  /** Record that one attachment reached a message (called by the binding hook). */
  noteBound(attach: BoundAttach): void {
    const known = this.attached.get(attach.sessionId)
      ?? new Map<string, { name: string; label: string; scope: SecretScope; createdAt: number; anchorSeq?: number }>()
    const session = this.deps.sessionById(attach.sessionId)
    const grant = session === undefined ? undefined : this.liveGrant(session, attach.variable)
    known.set(attach.variable, {
      name: attach.name,
      label: attach.label,
      scope: attach.scope,
      createdAt: attach.createdAt,
      ...(grant === undefined ? {} : { anchorSeq: grant.anchorSeq }),
    })
    this.attached.set(attach.sessionId, known)
    this.note(attach.sessionId, 'bound', attach.variable, {
      name: attach.name,
      label: attach.label,
      scope: attach.scope,
      source: 'attach',
      ...(grant === undefined ? {} : { anchorSeq: grant.anchorSeq }),
    })
  }

  /**
   * Record one staged entry that left the store on its own.
   *
   * Only a TTL expiry is reported: the store also reports every explicit
   * removal, and those are recorded by the caller that asked for them (the
   * capsule's discard, the draft watcher's withdrawal) — or, when the binding
   * consumes an entry, are not a loss at all.
   */
  noteDropped(sessionId: string, envVar: string, reason: AttachDropReason): void {
    if (reason !== 'expired') return
    this.note(sessionId, 'expired', envVar, {})
  }

  /** Drop every attachment record of one session (session end). */
  forgetAttachments(sessionId: string): void {
    this.deps.attachments.forget(sessionId)
    this.attached.delete(sessionId)
  }

  /** The value-free history of one session, newest first. */
  historyFor(sessionId: string): SecretHistoryView {
    return { entries: this.history.list(sessionId).map((entry) => historyView(entry)) }
  }

  /**
   * Every secret the `@` menu may offer this session: what the session itself
   * holds, then what the credential store holds durably.
   *
   * A variable that is both is listed once, as the session's own row: the menu's
   * job is to say what is *usable here*, and the session-side entry is the one
   * that already has a staged or bound record behind it.
   */
  async available(sessionId: string): Promise<readonly SecretAvailableEntry[]> {
    const entries: SecretAvailableEntry[] = []
    const seen = new Set<string>()
    const sessionSide = [...this.attachedViews(sessionId)].sort(
      (left, right) =>
        (left.state === right.state ? 0 : left.state === 'bound' ? -1 : 1)
        || left.variable.localeCompare(right.variable),
    )
    for (const view of sessionSide) {
      if (seen.has(view.variable)) continue
      seen.add(view.variable)
      entries.push({
        variable: view.variable,
        name: view.name,
        label: view.label,
        scope: view.scope,
        state: view.state,
        source: 'session',
      })
    }
    for (const stored of await this.storedEntries()) {
      if (entries.length >= this.deps.config.maxAvailableEntries) break
      if (seen.has(stored.variable)) continue
      seen.add(stored.variable)
      entries.push(stored)
    }
    return entries
  }

  /**
   * Register one durably stored secret for this session.
   *
   * The `@` menu cannot put a marker in a message that has nothing behind it: a
   * marker with no record would produce no note and no variable, which is a lie
   * the human would only discover at the far end. So a store-only pick first
   * asks the Host to adopt it, and only then inserts the chip. The Host resolves
   * the value itself — it never crosses the wire in either direction.
   */
  async adopt(raw: unknown): Promise<AdoptOutcome> {
    const parsed = parseAdopt(raw)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    const { sessionId, envVar } = parsed.value
    if (this.deps.sessionById(sessionId) === undefined) {
      return { ok: false, status: 404, error: 'adopt: 找不到该会话，本次未登记' }
    }
    const existing = this.deps.attachments.get(sessionId, envVar)
    if (
      existing === undefined
      && this.deps.attachments.countFor(sessionId) >= this.deps.config.maxAttachmentsPerSession
    ) {
      return {
        ok: false,
        status: 409,
        error: `adopt: 本会话登记的附加密钥已达上限（${String(this.deps.config.maxAttachmentsPerSession)}）`,
      }
    }
    const stored = (await this.storedEntries()).find((entry) => entry.variable === envVar)
    if (stored === undefined) {
      return { ok: false, status: 404, error: 'adopt: 凭据库里没有这个变量的持久记录' }
    }
    let value: string | undefined
    try {
      value = (await this.deps.credentials.resolve(envVar))?.value
    } catch {
      return { ok: false, status: 500, error: STORE_READ_FAILED_MESSAGE }
    }
    if (value === undefined || value.length === 0) {
      // Nothing is staged on this path: a record with no resolvable value would
      // give the human a chip that cannot be injected, so it fails closed.
      return { ok: false, status: 404, error: 'adopt: 凭据库里已经没有这个变量的值' }
    }
    const written = this.deps.attachments.put({
      sessionId,
      name: stored.name,
      label: stored.label,
      scope: 'persistent',
      envVar,
      value,
      createdAt: this.deps.now(),
    })
    if (written === undefined) {
      return {
        ok: false,
        status: 409,
        error: `adopt: 本会话登记的附加密钥已达上限（${String(this.deps.config.maxAttachmentsPerSession)}）`,
      }
    }
    this.note(sessionId, 'staged', envVar, {
      name: stored.name,
      label: stored.label,
      scope: 'persistent',
      source: 'attach',
      replaced: written.replaced,
    })
    return { ok: true, outcome: { variable: envVar, scope: 'persistent', replaced: written.replaced } }
  }

  /**
   * Every record this plugin committed that is still durably usable.
   *
   * Enumeration and read-back are both optional capabilities: a store that
   * cannot list, or a record that cannot be read, contributes nothing — the
   * menu reports only what it could verify, never a guess.
   */
  private async storedEntries(): Promise<readonly SecretAvailableEntry[]> {
    const enumerate = this.deps.credentials.listRecords
    const readBack = this.deps.credentials.readRecord
    // Both capabilities are optional: a store that cannot enumerate contributes
    // nothing, and the menu still lists the session's own entries.
    if (typeof enumerate !== 'function' || typeof readBack !== 'function') return []
    let records: readonly CredentialRecordRef[]
    try {
      records = await enumerate.call(this.deps.credentials)
    } catch {
      return []
    }
    const out: SecretAvailableEntry[] = []
    const seen = new Set<string>()
    for (const record of records) {
      if (out.length >= this.deps.config.maxAvailableEntries) break
      if (!record.key.startsWith(`${RECORD_SCOPE}/`)) continue
      let read: CredentialRecordRead | undefined
      try {
        read = await readBack.call(this.deps.credentials, record.key)
      } catch {
        continue
      }
      const facts = markerFacts(read?.payload)
      if (facts === undefined || seen.has(facts.envVar)) continue
      seen.add(facts.envVar)
      out.push({
        variable: facts.envVar,
        name: facts.name,
        // The marker carries no human-written title (both writers commit the
        // same value-free facts), so the variable name is the honest label: it
        // is what the human will see in their own message.
        label: facts.envVar,
        scope: 'persistent',
        state: 'stored',
        source: 'store',
      })
    }
    return out.sort((left, right) => left.variable.localeCompare(right.variable))
  }

  /**
   * Record one lifecycle transition, inheriting what the transition cannot know.
   *
   * A TTL expiry or a revoked anchor reports no facts of its own — by the time
   * either is observed the entry is gone. Rather than invent a credential key or
   * a scope, the entry inherits them from the variable's last recorded state;
   * with no earlier entry there is nothing truthful to write, so nothing is.
   */
  private note(
    sessionId: string,
    event: SecretHistoryEvent,
    variable: string,
    facts: {
      readonly name?: string
      readonly label?: string
      readonly scope?: SecretScope
      readonly anchorSeq?: number
      readonly source?: SecretHistorySource
      readonly replaced?: boolean
    },
  ): void {
    const previous = this.history.latest(sessionId, variable)
    const name = facts.name ?? previous?.name
    const label = facts.label ?? previous?.label
    const scope = facts.scope ?? previous?.scope
    if (name === undefined || label === undefined || scope === undefined) return
    this.history.push(sessionId, {
      at: this.deps.now(),
      event,
      variable,
      name,
      label,
      scope,
      source: facts.source ?? previous?.source ?? 'attach',
      ...(facts.anchorSeq === undefined ? {} : { anchorSeq: facts.anchorSeq }),
      ...(facts.replaced === undefined ? {} : { replaced: facts.replaced }),
    })
  }

  /** The live grant one session holds for one exposed variable, if any. */
  private liveGrant(session: GrantSessionLike, envVar: string): Grant | undefined {
    for (const name of this.grants.namesForEnvVar(envVar)) {
      const lookup = this.grants.resolve(session, name)
      if (lookup.code === 'ok') return lookup.grant
    }
    return undefined
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
    const described = await readStore(() => this.deps.credentials.describe(envVar))
    const alreadyConfigured = described.configured

    const id = this.deps.newId()
    const pending = this.pending.add(
      {
        id,
        callId: caller.callId,
        sessionId: String(session.id),
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
      return await this.complete(
        input,
        outcome.answer,
        {
          envVar,
          alreadyConfigured,
          session,
          anchorSeq,
          callId: caller.callId,
        },
        outcome.notice,
      )
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
  ): Promise<ConverseResult> {
    let answerPromise: Promise<WaitOutcome> | undefined
    /**
     * Set the moment this wait itself ends in a timeout, so a seam that later
     * reports `failed` cannot turn our timeout into a generic failure (O2).
     */
    let timedOut = false
    const settleOnce = (): Promise<WaitOutcome> => {
      answerPromise ??= this.pending
        .wait(pending.id, {
          signal: caller.signal,
          timeoutMs: this.deps.config.requestTimeoutMs,
          schedule: this.deps.schedule,
        })
        .then((outcome) => {
          if (outcome.kind === 'timeout') timedOut = true
          return outcome
        })
      return answerPromise
    }
    const recorded = (): ModalAnswer | undefined => this.pending.get(pending.id)?.answer
    /** A wait that timed out is always a timeout, whatever the seam made of it. */
    const timeoutFailure = (): SecretFailure =>
      new SecretFailure(
        'TIMEOUT',
        `secret_request: 等待人工确认超过 ${String(this.deps.config.requestTimeoutMs)}ms 未获答复（可能没有打开可交互的 Web 界面）。未获授权，本次不会注入任何变量。`,
      )

    if (input.scope === 'session') {
      const outcome = await settleOnce()
      return outcome.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'answer', answer: outcome.answer }
    }

    const attempt = await this.deps.authorization.attempt({
      key: recordKey(input.name),
      label: input.label,
      valueNeeded: !alreadyConfigured,
      answer: async () => {
        const outcome = await settleOnce()
        if (outcome.kind === 'timeout') {
          throw new SecretFailure('TIMEOUT', 'secret_request: 等待人工确认超时。')
        }
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
    if (attempt.status === 'failed') {
      if (timedOut) throw timeoutFailure()
      // O1: the human's recorded approval stands, but the flow never confirmed
      // the durable registration. Never report this as persisted: materialize it
      // for this session only, and say what is actually known.
      //
      // The wording deliberately does not claim "nothing was written": the seam
      // persists the value before it commits the authorization record, so a
      // failed attempt can leave a value in the store that simply carries no
      // grant record for this authorization.
      if (answer?.decision === 'approved') {
        return {
          kind: 'answer',
          answer:
            answer.value === undefined
              ? { decision: 'approved', scope: 'session' }
              : { decision: 'approved', scope: 'session', value: answer.value },
          notice:
            '未能完成持久化登记的确认：已按「仅本次会话有效」降级生效；若刚才的值已进入凭据库，它将不带本次授权记录。如需持久保存，请重试或改用手工配置。',
        }
      }
      // The same no-passthrough rule as a failing store read: the seam's error
      // text comes from a credential backend this plugin does not control (a
      // `persist` that fails before `commit` can quote the value it was handed),
      // so the failure identity is reported and the text is dropped. The
      // plugin's own redaction is still applied as a second layer, so wording
      // alone can never be the only thing keeping a value out of the result.
      const seen = recorded()
      const recordedValue = seen?.decision === 'approved' ? seen.value : undefined
      throw new SecretFailure(
        'AUTHORIZATION_FAILED',
        redactSecrets(
          'secret_request: 凭据授权流程失败（上游细节已省略）。未获授权，本次不会注入任何变量。',
          [recordedValue],
        ),
      )
    }
    if (answer !== undefined) return { kind: 'answer', answer }
    if (timedOut) throw timeoutFailure()
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
    /** Additive, value-free notice the approved result must also carry verbatim. */
    extraNotice?: string,
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
      const resolved = await readStore(() => this.deps.credentials.resolve(context.envVar))
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
    // The ask direction lands in the same flow the attach direction does: one
    // history, two sources, so "what happened in this session" has one answer.
    this.note(sessionId, 'authorized', context.envVar, {
      name: input.name,
      label: input.label,
      scope: plan.scope,
      source: 'request',
      anchorSeq: context.anchorSeq,
    })

    const notice = revocation === undefined
      ? undefined
      : revocation.code === 'revoked-anchor'
        ? '上一次授权所锚定的事件已不在当前会话表面上（会话回退/重写，或该事件被压缩覆盖），因此已失效并被本次重新授权覆盖。'
        : '上一次授权已不再属于本会话（会话分叉或结束），本次重新授权覆盖了它。'
    const notices = [notice, extraNotice].filter(
      (value): value is string => value !== undefined && value.length > 0,
    )
    return approvedResult(plan, context.envVar, notices.length === 0 ? undefined : notices.join('\n'))
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
