import { findAnchorSeq, type AnchorSessionLike } from './anchor.ts'
import { type AttachDropReason, type AttachStore, type BoundAttach } from './attach.ts'
import type { SecretConfig } from './config.ts'
import { approvedResult, mapNonApproved, planGrant } from './decisions.ts'
import { GrantStore, type Grant, type GrantSessionLike } from './grants.ts'
import { HistoryStore } from './history.ts'
import {
  describeValueShape,
  effectiveEnvVar,
  isCredentialName,
  isExposedEnvVar,
  modelKeyFromText,
  NAME_DEADLINE_MS,
  provisionalKey,
  RECORD_SCOPE,
  recordKey,
  recordKeyId,
  renderNamingPrompt,
  type SecretValueShape,
  validateManage,
  validateRequest,
} from './naming.ts'
import {
  PendingStore,
  SecretAbortedError,
  type PendingRequest,
  type Scheduler,
  type WaitOutcome,
} from './pending.ts'
import {
  availableView,
  historyView,
  manageView,
  parseAdopt,
  parseAnswer,
  parseAttach,
  parseManage,
  parseRelease,
  type ManageWireAction,
} from './protocol.ts'
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
  SecretManageChange,
  SecretManageEntry,
  SecretManageResult,
  SecretManageTarget,
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
  /**
   * Remove one reference's value from the provider-managed source.
   *
   * Optional on the same terms as enumeration: a store without a removal face
   * answers `false`, and the management surface then reports that it could not
   * delete anything rather than claiming it did. Removing an absent reference
   * is a no-op at the seam.
   *
   * @returns whether the store offered (and performed) the removal.
   */
  unset?(ref: string): Promise<boolean>
  /**
   * Remove one stored record; removing an absent record is a no-op.
   *
   * This is the second half of a real deletion: a value lives in the reference
   * space and its authorization marker in the record space, and the two key
   * grammars are disjoint, so neither call can stand in for the other.
   *
   * @returns whether the store offered (and performed) the removal.
   */
  deleteRecord?(key: string): Promise<boolean>
  /** Presence and writability facts for one record; never its value. */
  describeRecord?(key: string): Promise<{ configured: boolean; kind?: string; writable: boolean } | undefined>
}

/** What one authorization attempt needs from its flow. */
export interface AuthorizationAttemptInput {
  /** Record key this attempt authorizes. */
  readonly key: string
  /** Human-facing flow label. */
  readonly label: string
  /** Whether the dialog collected a value that must be written to the store. */
  readonly valueNeeded: boolean
  /**
   * A value this session already holds, written into the store by the flow.
   *
   * Used when the human consents to making an existing session-held value
   * durable: the value never has to be typed again, but it is still written
   * inside the attempt and before the commit — the same order the prompt path
   * runs in, so the "may be stored even though the attempt failed" caveat keeps
   * its shape. Ignored while `valueNeeded` is true.
   */
  readonly preloaded?: string
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

/**
 * One optional, deadline-bounded request for a credential key the human left blank.
 *
 * The request carries exactly the two strings a model may see (built by
 * `renderNamingPrompt` from the human's title and a value *shape*), and the
 * session id only so the wiring can resolve which model that session is using.
 * There is deliberately no field for a value.
 */
export type NameSuggester = (request: {
  readonly sessionId: string
  /** Model-facing instruction; redacted facts only. */
  readonly system: string
  /** Model-facing text: the human's title plus the shape tokens, never the value. */
  readonly user: string
  readonly signal: AbortSignal
}) => Promise<string | undefined>

/** Everything the service reads from its host. */
export interface SecretServiceDeps {
  readonly config: SecretConfig
  readonly credentials: CredentialsPort
  readonly authorization: AuthorizationPort
  readonly envs: EnvPort
  /** Staged secrets a human attached and has not sent yet. */
  readonly attachments: AttachStore
  /**
   * Optional model suggestion for a credential key the human left blank.
   *
   * Absent (no `llm` service in the profile, or a test harness), the local rule
   * alone decides — an attach never depends on a model being there.
   */
  readonly nameSuggester?: NameSuggester
  /** Overrides {@link NAME_DEADLINE_MS}; tests use a tiny value. */
  readonly nameDeadlineMs?: number
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

/** The result of one info-box management submission, as the route reports it. */
export type ManageOutcome =
  | {
      readonly ok: true
      readonly action: ManageWireAction
      readonly variable: string
      /** The scope in force after the action. */
      readonly scope: SecretScope
      readonly changed: SecretManageChange
      readonly notice?: string
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** How one management action's target currently stands, as the Host itself verified it. */
interface ManageFacts {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  readonly state: SecretAttachState | 'stored'
  /** This session holds it (a staged entry, or a live grant). */
  readonly hasSession: boolean
  /** The credential store holds a durable record for it. */
  readonly hasStore: boolean
  /** This session's own copy of the material, when it really holds one. */
  readonly sessionValue?: string
}

/** What one management action asked for, once validated. */
interface ManageIntent {
  readonly action: ManageWireAction
  readonly to?: SecretScope
  readonly target?: SecretManageTarget
  /** The value a human typed, only ever present for `action:'value'`. */
  readonly value?: string
}

/** What one executed management action did. */
type ManageApplied =
  | {
      readonly ok: true
      readonly scope: SecretScope
      readonly changed: SecretManageChange
      readonly notice?: string
    }
  | { readonly ok: false; readonly status: number; readonly error: string }

/** How one durable-registration attempt ended. */
type PersistOutcome =
  | { readonly ok: true; readonly confirmed: boolean; readonly notice?: string }
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
 * The three fixed, value-free failures the management surface can produce.
 *
 * Same discipline as the read and write above, and for a sharper reason here:
 * the store's `unset` refuses by *throwing* (it will not write a reference the
 * launching environment shadows), and that thrown text names the shell the user
 * should fix. It is not ours to forward, and classification by string matching
 * would be a guess, so one wording that covers both causes without asserting
 * which one it was is used instead — the surface tells the human what is known.
 */
const STORE_DELETE_REFUSED_MESSAGE =
  '未能删除凭据库里的值（可能由启动 dsh 的环境只读提供，或凭据库写入失败）。本次未删除任何东西。'
const STORE_DELETE_RECORD_FAILED_MESSAGE =
  '值已删除，但授权标记记录未能删除（可再次执行真删以清理它）。'
const STORE_DELETE_UNSUPPORTED_MESSAGE = '当前凭据库实现不提供删除能力，本次未删除任何东西。'
const STORE_MANAGE_WRITE_FAILED_MESSAGE =
  '凭据库写入失败（上游细节已省略）。本次未改变作用域，也没有写入任何值。'

/**
 * The fixed notice one un-confirmed durable registration reports.
 *
 * Wording deliberately does not claim "nothing was written": the seam writes
 * the value before it commits the authorization record, so a failed attempt can
 * leave a value in the store that simply carries no record for this action.
 * This is the same caveat the request direction already documents (O1).
 */
const PERSIST_UNCONFIRMED_NOTICE =
  '未能完成持久化登记的确认：本次未改变作用域；若刚才的值已进入凭据库，它将不带本次授权记录。'

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
    // A management interaction states whether its approval must carry a value
    // (a `value` action always does, a `delete` never does). The request
    // direction states nothing and keeps its own rule, so its contract is
    // unchanged.
    const parsed = parseAnswer(raw, request.expectValue ?? !request.alreadyConfigured)
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
    // R1: a blank credential key is completed here, before anything is staged.
    // The key has to exist before the marker is inserted into the draft (the
    // marker is durable message text), which is why this happens at attach time
    // and never after the message was sent.
    const completed = await this.resolveAttachKey(raw)
    const parsed = parseAttach(completed)
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
   * Complete an attach body whose credential key was left blank (R1).
   *
   * The local rule runs first and always produces a legal, unused key, so this
   * method cannot fail and an attach can never be blocked (or lost) because a
   * model was slow, absent or unhelpful. A model suggestion is best-effort:
   * deadline-bounded, validated against the same contract, and only accepted
   * when it is free.
   *
   * An explicit key is passed through untouched — `parseAttach` keeps reporting
   * its own message for a malformed one, exactly as before this round.
   *
   * @param raw - the parsed JSON body of the attach request, as the route read it.
   * @returns the body to validate, with `name` (and an empty `label`) filled in.
   */
  private async resolveAttachKey(raw: unknown): Promise<unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
    const record = raw as Record<string, unknown>
    const given = typeof record.name === 'string' ? record.name.trim() : ''
    if (given.length > 0) return raw

    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const value = typeof record.value === 'string' ? record.value : ''
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    const shape = describeValueShape(value)
    const taken = await this.takenKeys(sessionId)
    const fallback = provisionalKey(label, shape, taken)
    const suggested = await this.suggestKey(sessionId, label, shape)
    const chosen =
      suggested !== undefined && !taken.has(suggested) && !taken.has(recordKeyId(suggested))
        ? suggested
        : fallback
    // The title falls back to the key when the human left it empty, which is
    // what `label ?? name` used to do before the key itself became optional.
    return { ...record, name: chosen, label: label.length > 0 ? label : chosen }
  }

  /**
   * Every credential key and record id this attach must not collide with.
   *
   * Both halves, because two keys can share one record key (`a_b` and `a-b`).
   * Enumeration is optional to the store, so a store that cannot list records
   * simply contributes nothing (the session's own keys still count).
   */
  private async takenKeys(sessionId: string): Promise<Set<string>> {
    const taken = new Set<string>()
    try {
      for (const entry of await this.storedEntries()) taken.add(entry.name)
    } catch {
      // A store that cannot enumerate is not an error here: nothing to avoid.
    }
    for (const staged of this.deps.attachments.list(sessionId)) taken.add(staged.name)
    const session = this.deps.sessionById(sessionId)
    if (session !== undefined) {
      for (const name of this.grants.validNames(session)) taken.add(name)
    }
    for (const name of [...taken]) taken.add(recordKeyId(name))
    return taken
  }

  /**
   * Ask the session's own model for a key, inside a hard deadline.
   *
   * Nothing here touches a session: the suggester receives the redacted prompt
   * and the session id only, and the wiring that implements it (see
   * `src/index.ts`) passes no `sessionId` to the model and appends no event.
   * The abort controller bounds both a late answer and the request itself.
   */
  private async suggestKey(sessionId: string, label: string, shape: SecretValueShape): Promise<string | undefined> {
    const suggest = this.deps.nameSuggester
    if (suggest === undefined) return undefined
    const deadlineMs = this.deps.nameDeadlineMs ?? NAME_DEADLINE_MS
    if (!(deadlineMs > 0)) return undefined
    const prompt = renderNamingPrompt(label, shape)
    const controller = new AbortController()
    let cancel: () => void = () => undefined
    const deadline = new Promise<undefined>((resolve) => {
      cancel = this.deps.schedule(deadlineMs, () => {
        resolve(undefined)
      })
    })
    try {
      const answer = await Promise.race([
        suggest({ sessionId, system: prompt.system, user: prompt.user, signal: controller.signal }).catch(
          () => undefined,
        ),
        deadline,
      ])
      return answer === undefined ? undefined : modelKeyFromText(answer)
    } finally {
      cancel()
      controller.abort()
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
   * Every secret the management surface may show this session.
   *
   * Unlike {@link available}, which answers "what may I use here" and therefore
   * collapses a variable that is both session-side and durable into the session
   * row, this answers "what can be managed, and how": the two sides are reported
   * as one row with both facts, and `can` says which actions the Host proved are
   * possible right now. A client never derives those booleans itself, so it can
   * never offer an action that would only fail.
   *
   * "Usable in this session" means both directions that put a record here: the
   * attach direction (`staged`/`bound`) and the ask direction (a live grant the
   * human approved through `secret_request`). Each row carries the direction it
   * came from in `origin`, so the two are never conflated, and at most one row
   * ever describes one variable.
   */
  async manageList(sessionId: string): Promise<readonly SecretManageEntry[]> {
    const session = this.deps.sessionById(sessionId)
    const storeSide = await this.storedEntries()
    const durable = new Set(storeSide.map((entry) => entry.variable))
    const rows: SecretManageEntry[] = []
    if (session !== undefined) {
      const sessionSide = [...this.attachedViews(sessionId)].sort(
        (left, right) =>
          (left.state === right.state ? 0 : left.state === 'bound' ? -1 : 1)
          || left.variable.localeCompare(right.variable),
      )
      for (const view of sessionSide) {
        const hasStore = durable.has(view.variable)
        rows.push({
          variable: view.variable,
          name: view.name,
          label: view.label,
          scope: view.scope,
          state: view.state,
          source: hasStore ? 'both' : 'session',
          origin: 'attach',
          can: { unbind: true, delete: hasStore, scope: true, value: true },
        })
      }
      rows.push(...this.requestViews(session, sessionId, durable, rows))
    }
    for (const stored of storeSide) {
      if (rows.some((row) => row.variable === stored.variable)) continue
      rows.push({
        variable: stored.variable,
        name: stored.name,
        label: stored.label,
        scope: 'persistent',
        state: 'stored',
        source: 'store',
        // A store-only row has no session-side record, so only the two actions
        // whose subject is the record itself are offered. "Re-scope" and
        // "unbind" would have nothing to act on here, and offering them would
        // teach the human that the buttons sometimes lie. No `origin` either:
        // there is no session-side direction to report.
        can: { unbind: false, delete: true, scope: false, value: true },
      })
    }
    return rows
  }

  /**
   * The session-side rows that come from the ask direction.
   *
   * `attachedViews` only ever describes the attach direction, so a variable the
   * human authorized through `secret_request` is usable (it is injected into
   * this session's shells) while being invisible to the management list — which
   * is exactly the gap the user's ruling closed. A grant with a tool call behind
   * it is the ask direction's own record; a grant the attach direction created
   * carries no `callId` and is already reported as its `staged`/`bound` row.
   *
   * One variable is still one row: a variable already covered keeps its attach
   * row, so the list never describes the same variable twice.
   */
  private requestViews(
    session: GrantSessionLike,
    sessionId: string,
    durable: ReadonlySet<string>,
    covered: readonly SecretManageEntry[],
  ): readonly SecretManageEntry[] {
    const seen = new Set(covered.map((row) => row.variable))
    const views: SecretManageEntry[] = []
    for (const name of [...this.grants.validNames(session)].sort((left, right) => left.localeCompare(right))) {
      const lookup = this.grants.resolve(session, name)
      const grant = lookup.code === 'ok' ? lookup.grant : undefined
      if (grant === undefined || grant.callId === undefined) continue
      if (seen.has(grant.envVar)) continue
      seen.add(grant.envVar)
      const hasStore = durable.has(grant.envVar)
      views.push({
        variable: grant.envVar,
        name: grant.name,
        // No attach metadata exists for this direction, so the last recorded
        // label is the honest one; the variable name is the last resort.
        label: this.history.latest(sessionId, grant.envVar)?.label ?? grant.envVar,
        scope: grant.scope,
        state: 'authorized',
        source: hasStore ? 'both' : 'session',
        origin: 'request',
        can: { unbind: true, delete: hasStore, scope: true, value: true },
      })
    }
    return views
  }

  /**
   * Run one management submission from the info box.
   *
   * The human's click *is* the confirmation (the page only offers the action
   * after the Host said it was possible, and the destructive one behind a second
   * click whose body says so), so no dialog is opened here. Nothing durable
   * happens before this method is called with a body the human composed.
   *
   * @param raw - parsed JSON body of the manage request.
   */
  async manage(raw: unknown): Promise<ManageOutcome> {
    const parsed = parseManage(raw)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
    const input = parsed.value
    const session = this.deps.sessionById(input.sessionId)
    if (session === undefined) {
      return { ok: false, status: 404, error: 'manage: 找不到该会话，本次未做任何改动' }
    }
    const facts = await this.factsFor(session, input.variable)
    if (facts === undefined) {
      return {
        ok: false,
        status: 404,
        error: `manage: 本会话与凭据库里都没有 ${input.variable}，本次未做任何改动`,
      }
    }
    const applied = await this.perform(facts, session, {
      action: input.action,
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.value === undefined ? {} : { value: input.value }),
    })
    if (!applied.ok) return applied
    return {
      ok: true,
      action: input.action,
      variable: input.variable,
      scope: applied.scope,
      changed: applied.changed,
      ...(applied.notice === undefined ? {} : { notice: applied.notice }),
    }
  }

  /**
   * Run one `secret_manage` call.
   *
   * `list` is read-only and answers without a human, so a delegated child may
   * ask it — though what it gets back is always *its own* session's facts, and
   * always with the reachability caveat below: `can` describes what a row
   * supports, not what a child may run. Every other action changes something, so
   * it needs a human answerer and therefore the live root, exactly like
   * `secret_request`.
   *
   * @param raw - model arguments, validated here.
   * @param caller - agent, tool-call identity, and cancellation.
   */
  async manageRequest(raw: unknown, caller: SecretCaller): Promise<SecretManageResult> {
    const validated = validateManage(raw)
    if (!validated.ok) throw new SecretFailure('BAD_REQUEST', validated.error)
    const input = validated.value

    const callerClass = this.deps.classifyCaller(caller.agent)
    const session = this.deps.sessionOf(caller.agent)
    if (input.action === 'list') {
      if (callerClass === 'not-live') throw callerFailure(callerClass)
      if (session === undefined) throw noSessionFailure('secret_manage')
      const entries = await this.manageList(String(session.id))
      return {
        decision: 'listed',
        entries: entries.map((entry) => manageView(entry)),
        ...(callerClass === 'delegated' ? { notice: DELEGATED_LIST_NOTICE } : {}),
      }
    }
    if (callerClass !== 'live-root') throw callerFailure(callerClass)
    if (session === undefined) throw noSessionFailure('secret_manage')

    const variable = input.variable
    const facts = await this.factsFor(session, variable)
    if (facts === undefined) {
      throw new SecretFailure(
        'NOT_FOUND',
        `secret_manage: 本会话与凭据库里都没有 ${variable}（变量名必须与现有条目完全一致；可先用 action:"list" 列出）。未执行任何动作。`,
      )
    }

    // A re-scope to the scope already in force changes nothing, so it is
    // answered without asking a human to confirm a no-op.
    if (input.action === 'scope' && input.to === facts.scope) {
      return {
        decision: 'applied',
        action: 'scope',
        variable,
        scope: facts.scope,
        changed: { session: false, store: false },
        notice: '该变量已经是这个作用域，未做任何改动。',
      }
    }
    const refusal = this.refuseBeforeAsking(facts, input)
    if (refusal !== undefined) throw refusal

    const id = this.deps.newId()
    const pending = this.pending.add(
      {
        id,
        callId: caller.callId,
        sessionId: String(session.id),
        name: facts.name,
        envVar: variable,
        label: facts.label,
        reason: input.reason,
        requestedScope: input.to ?? facts.scope,
        alreadyConfigured: facts.hasStore,
        createdAt: this.deps.now(),
        action: input.action,
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.to === undefined ? {} : { to: input.to }),
        // Only a value change needs the human to type something. A re-scope to
        // persistent writes the value this session already holds, which the
        // confirmation card says out loud; nothing there asks for it again.
        expectValue: input.action === 'value',
      },
      this.deps.config.maxPendingRequests,
    )
    if (pending === undefined) {
      throw new SecretFailure(
        'TOO_MANY_PENDING',
        `secret_manage: 已有 ${String(this.deps.config.maxPendingRequests)} 个授权请求在等待人工确认，请先处理它们再重试。`,
      )
    }

    try {
      const outcome = await this.pending.wait(id, {
        signal: caller.signal,
        timeoutMs: this.deps.config.requestTimeoutMs,
        schedule: this.deps.schedule,
      })
      if (outcome.kind === 'timeout') {
        throw new SecretFailure(
          'TIMEOUT',
          `secret_manage: 等待人工确认超过 ${String(this.deps.config.requestTimeoutMs)}ms 未获答复（可能没有打开可交互的 Web 界面）。未执行任何动作，持久状态未改变。`,
        )
      }
      const answer = outcome.answer
      if (answer.decision !== 'approved') return mapNonApproved(answer)
      const typed = answer.value
      if (input.action === 'value' && (typed === undefined || typed.length === 0)) {
        throw new SecretFailure('NO_VALUE', 'secret_manage: 未获得任何值，已放弃本次改值；未做任何改动。')
      }
      const applied = await this.perform(facts, session, {
        action: input.action,
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(typed === undefined ? {} : { value: typed }),
      })
      if (!applied.ok) {
        throw new SecretFailure(
          applied.status === 404 ? 'NOT_FOUND' : 'MANAGE_FAILED',
          applied.error,
        )
      }
      return {
        decision: 'applied',
        action: input.action,
        variable,
        scope: applied.scope,
        changed: applied.changed,
        ...(applied.notice === undefined ? {} : { notice: applied.notice }),
      }
    } finally {
      this.pending.remove(id)
    }
  }

  /**
   * The honest pre-dialog refusals: a management action whose target cannot
   * support it fails before a human is ever asked, so nobody is shown a
   * question whose only possible answer is "this cannot work".
   */
  private refuseBeforeAsking(facts: ManageFacts, input: ManageIntent): SecretFailure | undefined {
    if (input.action === 'delete' && !facts.hasStore) {
      return new SecretFailure(
        'NOT_FOUND',
        `secret_manage: 凭据库里没有 ${facts.variable} 的持久记录，未删除任何东西（"list" 的 can.delete 会告诉你哪些变量能真删）。`,
      )
    }
    if (input.action === 'value' && input.target === 'store' && !facts.hasStore) {
      return new SecretFailure(
        'STORE_EMPTY',
        `secret_manage: 凭据库里没有 ${facts.variable} 的持久记录，无法改库里的值；请改用 scope:"persistent" 让本会话这份值持久化，或重新授权。`,
      )
    }
    if ((input.action === 'unbind' || input.action === 'scope' || input.target === 'session')
      && !facts.hasSession) {
      return new SecretFailure(
        'NOT_FOUND',
        `secret_manage: 本会话没有 ${facts.variable}（它只在凭据库里）。解绑与改作用域都作用于本会话的这份记录。`,
      )
    }
    return undefined
  }

  /** The current state of one variable, as the Host itself verified it. */
  private async factsFor(session: GrantSessionLike, variable: string): Promise<ManageFacts | undefined> {
    const sessionId = String(session.id)
    const staged = this.deps.attachments.get(sessionId, variable)
    const grant = this.liveGrant(session, variable)
    const stored = (await this.storedEntries()).find((entry) => entry.variable === variable)
    if (staged === undefined && grant === undefined && stored === undefined) return undefined
    if (staged !== undefined) {
      return {
        variable,
        name: staged.name,
        label: staged.label,
        scope: staged.scope,
        state: 'staged',
        hasSession: true,
        hasStore: stored !== undefined,
        sessionValue: staged.value,
      }
    }
    if (grant !== undefined) {
      return {
        variable,
        name: grant.name,
        label: this.attached.get(sessionId)?.get(variable)?.label ?? variable,
        scope: grant.scope,
        state: 'bound',
        hasSession: true,
        hasStore: stored !== undefined,
        sessionValue: grant.value,
      }
    }
    return {
      variable,
      name: stored?.name ?? variable,
      label: stored?.label ?? variable,
      scope: 'persistent',
      state: 'stored',
      hasSession: false,
      hasStore: true,
    }
  }

  /** Run one already-authorized management action. */
  private async perform(
    facts: ManageFacts,
    session: GrantSessionLike,
    intent: ManageIntent,
  ): Promise<ManageApplied> {
    const sessionId = String(session.id)
    if (intent.action === 'unbind') {
      if (!facts.hasSession) {
        return { ok: false, status: 404, error: `manage: 本会话没有 ${facts.variable}，无法解绑。` }
      }
      if (facts.state === 'staged') {
        // The staged half is the existing release path on purpose: one removal,
        // one history event (`discarded`), one set of tests.
        const released = this.release({ sessionId, variable: facts.variable, reason: 'discarded' })
        if (!released.ok) return { ok: false, status: released.status, error: released.error }
        return {
          ok: true,
          scope: facts.scope,
          changed: { session: released.released, store: false },
          ...(released.released ? {} : { notice: '本会话没有这条暂存记录，未做任何改动。' }),
        }
      }
      const dropped = this.grants.unbind(sessionId, facts.variable)
      if (dropped === undefined) {
        return {
          ok: true,
          scope: facts.scope,
          changed: { session: false, store: false },
          notice: '这条授权已经不在有效期内（锚点已失效），未做任何改动。',
        }
      }
      // The bound meta is dropped with the exposure, so `attachedViews` cannot
      // later observe a missing grant and report a second, spurious `revoked`.
      this.attached.get(sessionId)?.delete(facts.variable)
      this.note(sessionId, 'unbound', facts.variable, {
        name: facts.name,
        label: facts.label,
        scope: dropped.scope,
        source: 'manage',
        anchorSeq: dropped.anchorSeq,
      })
      return { ok: true, scope: dropped.scope, changed: { session: true, store: false } }
    }

    if (intent.action === 'delete') {
      if (!facts.hasStore) {
        return {
          ok: false,
          status: 404,
          error: `manage: 凭据库里没有 ${facts.variable} 的持久记录，本次未删除任何东西。`,
        }
      }
      const removed = await this.deleteStore(facts)
      if (!removed.ok) return removed
      // The durable half is gone, so this session's exposure is session-scoped
      // now. Saying so is the only honest report: the value it injects is still
      // the one it held, but nothing on disk backs it any more.
      const downgraded = this.downgradeSession(facts, session)
      this.note(sessionId, 'deleted', facts.variable, {
        name: facts.name,
        label: facts.label,
        scope: 'persistent',
        source: 'manage',
      })
      return {
        ok: true,
        scope: 'session',
        changed: { session: downgraded, store: true },
        ...(downgraded
          ? { notice: '凭据库里的记录已删除；本会话仍持有该变量，作用域已如实降为仅本次会话。' }
          : { notice: '凭据库里的记录已删除。' }),
      }
    }

    if (intent.action === 'scope') {
      if (!facts.hasSession) {
        return {
          ok: false,
          status: 409,
          error: `manage: 本会话没有 ${facts.variable}，改作用域要先有本会话的这份记录。`,
        }
      }
      if (intent.to === 'persistent') {
        if (facts.scope === 'persistent') {
          return {
            ok: true,
            scope: 'persistent',
            changed: { session: false, store: false },
            notice: '这个变量已经是持久作用域，未做任何改动。',
          }
        }
        if (facts.sessionValue === undefined) {
          return { ok: false, status: 409, error: 'manage: 本会话已不再持有该变量的值，无法转为持久。' }
        }
        const written = await this.persistDurable(facts, facts.sessionValue)
        if (!written.ok) return written
        if (!written.confirmed) {
          // The human consented and the value may be on disk, but the durable
          // registration was not confirmed, so the scope is *not* reported as
          // changed. This is the request direction's own O1 caveat, reused.
          return {
            ok: true,
            scope: facts.scope,
            changed: { session: false, store: false },
            notice: PERSIST_UNCONFIRMED_NOTICE,
          }
        }
        const upgraded = this.upgradeSession(facts, session)
        this.note(sessionId, 'scope-changed', facts.variable, {
          name: facts.name,
          label: facts.label,
          scope: 'persistent',
          source: 'manage',
        })
        return {
          ok: true,
          scope: 'persistent',
          changed: { session: upgraded, store: true },
          ...(written.notice === undefined ? {} : { notice: written.notice }),
        }
      }
      // to === 'session': this session's exposure becomes session-scoped, and
      // the credential-store record is **kept**. The two are separate facts, and
      // the surface offers them as two separate buttons: "only make it session"
      // (this branch, nothing durable touched) and "stop being durable and
      // delete the record" (the `delete` action, which is the one that removes
      // it). No action here may carry a destructive side effect the human did
      // not name.
      if (facts.scope !== 'persistent') {
        return {
          ok: true,
          scope: 'session',
          changed: { session: false, store: false },
          notice: '这个变量本来就是仅本次会话有效，未做任何改动。',
        }
      }
      const downgraded = this.downgradeSession(facts, session)
      this.note(sessionId, 'scope-changed', facts.variable, {
        name: facts.name,
        label: facts.label,
        scope: 'session',
        source: 'manage',
      })
      return {
        ok: true,
        scope: 'session',
        changed: { session: downgraded, store: false },
        notice: facts.hasStore
          ? '本会话这份已改为仅本次会话；凭据库里的记录仍在（要一并删除请用「不再持久，并从库中删除」）。'
          : undefined,
      }
    }

    // intent.action === 'value'
    const typed = intent.value
    if (typed === undefined || typed.length === 0) {
      return { ok: false, status: 400, error: 'manage: 改值需要一个由人类输入的值。' }
    }
    if (intent.target === 'store') {
      if (!facts.hasStore) {
        return {
          ok: false,
          status: 404,
          error: `manage: 凭据库里没有 ${facts.variable} 的持久记录，无法改库里的值。`,
        }
      }
      const written = await this.persistDurable(facts, typed)
      if (!written.ok) return written
      const synced = this.replaceSessionValue(facts, session, typed)
      this.note(sessionId, 'updated', facts.variable, {
        name: facts.name,
        label: facts.label,
        scope: 'persistent',
        source: 'manage',
      })
      return {
        ok: true,
        scope: 'persistent',
        changed: { session: synced, store: written.confirmed },
        ...(written.notice === undefined ? {} : { notice: written.notice }),
      }
    }
    const replaced = this.replaceSessionValue(facts, session, typed)
    if (!replaced) {
      return {
        ok: false,
        status: 404,
        error: `manage: 本会话没有 ${facts.variable}，无法改本会话这份值（可改用 target:"store"）。`,
      }
    }
    this.note(sessionId, 'updated', facts.variable, {
      name: facts.name,
      label: facts.label,
      scope: facts.scope,
      source: 'manage',
    })
    return { ok: true, scope: facts.scope, changed: { session: true, store: false } }
  }

  /**
   * Remove one durable record: the value first, then its marker.
   *
   * Order matters. `unset` is the step that can refuse (the store will not write
   * a reference the launching environment supplies), and a refusal there leaves
   * the record untouched, so the outcome is "nothing was deleted" rather than a
   * half-state. A failure of the second call is reported as exactly that: the
   * value is gone and the marker remains, which the human can retry.
   */
  private async deleteStore(facts: ManageFacts): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const unset = this.deps.credentials.unset
    const remove = this.deps.credentials.deleteRecord
    if (typeof unset !== 'function' || typeof remove !== 'function') {
      return { ok: false, status: 501, error: STORE_DELETE_UNSUPPORTED_MESSAGE }
    }
    try {
      await unset.call(this.deps.credentials, facts.variable)
    } catch {
      // The backend's own text can name the shell that shadows the reference;
      // it is not ours to forward, and the fixed wording covers both causes
      // without asserting which one it was.
      return { ok: false, status: 500, error: STORE_DELETE_REFUSED_MESSAGE }
    }
    try {
      await remove.call(this.deps.credentials, recordKey(facts.name))
    } catch {
      return { ok: false, status: 500, error: STORE_DELETE_RECORD_FAILED_MESSAGE }
    }
    return { ok: true }
  }

  /**
   * Make this session's held value durable through the authorization seam.
   *
   * The seam is used for exactly what it is for — a durable record that is
   * observed to exist after the attempt — and its refusal to settle an attempt
   * that removed the record is why no deletion path can come through here.
   */
  private async persistDurable(facts: ManageFacts, value: string): Promise<PersistOutcome> {
    const attempt = await this.deps.authorization.attempt({
      key: recordKey(facts.name),
      label: facts.label,
      valueNeeded: false,
      preloaded: value,
      // The human consented on the surface that called this (a card's approved
      // answer, or the info box's own confirmed click), so the flow's question
      // is already answered.
      answer: async () => ({ decision: 'approved', scope: 'persistent' }),
      persist: async (entered) => {
        await this.deps.credentials.set(facts.variable, entered)
      },
      marker: () => ({
        version: 1,
        envVar: facts.variable,
        name: facts.name,
        scope: 'persistent',
        authorizedAt: this.deps.now(),
      }),
    })
    if (attempt.status === 'authorized') return { ok: true, confirmed: true }
    if (attempt.status === 'escaped') {
      // Only a human refusal or a scope override escapes, and neither can come
      // back here: the confirmation already happened on our own surface.
      return { ok: false, status: 409, error: 'manage: 人工确认未通过（已拒绝或改成了另一个作用域），本次未改变持久状态。' }
    }
    if (attempt.status === 'cancelled') {
      return { ok: false, status: 409, error: 'manage: 授权尝试在完成前被取消，本次未改变持久状态。' }
    }
    // The value may already be in the store — the seam writes before it commits
    // — so this is reported as an unconfirmed registration rather than as a
    // clean failure, exactly as the request direction reports it (O1).
    return { ok: true, confirmed: false, notice: PERSIST_UNCONFIRMED_NOTICE }
  }

  /** Replace this session's own copy of one variable's material. */
  private replaceSessionValue(facts: ManageFacts, session: GrantSessionLike, value: string): boolean {
    const sessionId = String(session.id)
    if (facts.state === 'staged') {
      return this.deps.attachments.reValue(sessionId, facts.variable, value)
    }
    if (facts.state === 'bound') {
      const grant = this.liveGrant(session, facts.variable)
      if (grant === undefined) return false
      // The anchor, the variable name and the scope are all untouched: this is
      // a change of material, not a new authorization, so rewind still revokes
      // it and the markers already in messages still name the same variable.
      this.grants.put({ ...grant, value, authorizedAt: this.deps.now() })
      return true
    }
    return false
  }

  /** Record this session's exposure as durable, after the store confirmed it. */
  private upgradeSession(facts: ManageFacts, session: GrantSessionLike): boolean {
    const sessionId = String(session.id)
    if (facts.state === 'staged') {
      const changed = this.deps.attachments.reScope(sessionId, facts.variable, 'persistent')
      const known = this.attached.get(sessionId)
      const meta = known?.get(facts.variable)
      if (known !== undefined && meta !== undefined && meta.scope !== 'persistent') {
        known.set(facts.variable, { ...meta, scope: 'persistent' })
      }
      return changed || meta !== undefined
    }
    const grant = this.liveGrant(session, facts.variable)
    if (grant === undefined) return false
    if (grant.scope !== 'persistent') this.grants.put({ ...grant, scope: 'persistent' })
    const known = this.attached.get(sessionId)
    const meta = known?.get(facts.variable)
    if (known !== undefined && meta !== undefined && meta.scope !== 'persistent') {
      known.set(facts.variable, { ...meta, scope: 'persistent' })
    }
    return grant.scope !== 'persistent' || meta !== undefined
  }

  /**
   * Mark this session's exposure as session-scoped after its durable half went
   * away. The value stays where it was (in P3/P4, in memory); what changes is
   * the truth about where the material lives.
   */
  private downgradeSession(facts: ManageFacts, session: GrantSessionLike): boolean {
    const sessionId = String(session.id)
    let changed = false
    if (facts.state === 'staged') changed = this.deps.attachments.reScope(sessionId, facts.variable, 'session')
    if (facts.state === 'bound') {
      const grant = this.liveGrant(session, facts.variable)
      if (grant !== undefined && grant.scope !== 'session') {
        this.grants.put({ ...grant, scope: 'session' })
        changed = true
      }
    }
    const known = this.attached.get(sessionId)
    const meta = known?.get(facts.variable)
    if (known !== undefined && meta !== undefined && meta.scope !== 'session') {
      known.set(facts.variable, { ...meta, scope: 'session' })
      changed = true
    }
    return changed
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
        : revocation.code === 'revoked-unbound'
          ? '上一次授权已被解除（从本会话移除），因此已失效；本次重新授权覆盖了它。'
          : '上一次授权已不再属于本会话（会话分叉或结束），本次重新授权覆盖了它。'
    const notices = [notice, extraNotice].filter(
      (value): value is string => value !== undefined && value.length > 0,
    )
    return approvedResult(plan, context.envVar, notices.length === 0 ? undefined : notices.join('\n'))
  }
}

/**
 * The value-free caveat a delegated caller's listing carries.
 *
 * `can` describes what a *row* supports — the same fact the human's info box
 * reads — not what the caller may run: every write action needs a human
 * answerer and therefore the live root. Saying so in the result is what keeps
 * the per-row capability line from reading as an offer the child cannot take
 * up (the rendering appends this notice verbatim).
 */
const DELEGATED_LIST_NOTICE =
  '你是被委派的子代理：上面每一行的动作是「这一行支持什么」，不是「你可以执行什么」——unbind/delete/scope/value 只对活跃的会话根代理开放，你调用任何一个都会得到 DELEGATED_CALLER，不会有任何对话框出现。需要写操作时请让主会话（会话根代理）执行。'

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

/**
 * The one structured failure a missing session produces, per tool.
 *
 * The wording names the tool that was called, so a reader never has to guess
 * which surface refused, and it is fixed rather than assembled from anything a
 * caller supplied.
 */
export function noSessionFailure(tool: string): SecretFailure {
  return new SecretFailure(
    'NO_SESSION',
    `${tool}: 找不到该 agent 的活跃会话，无法把这次操作锚定到可回答的人类；请在会话根代理中重试。`,
  )
}

export { SecretAbortedError }
