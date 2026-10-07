/**
 * Wire and result types for cordis-plugin-secret.
 *
 * Nothing in this module is imported at runtime: the whole file is type-level so
 * the Host half can be loaded by the Cordis Loader without pulling any extra
 * package into the profile's resolution graph.
 */

/** Where an approved secret lives. Chosen by the agent, overridable by the human. */
export type SecretScope = 'session' | 'persistent'

/** The four decisions a human can take in the approval dialog. */
export type SecretDecisionKind = 'approved' | 'rejected' | 'ignored' | 'other'

/** Arguments the agent supplies to `secret_request`. */
export interface SecretRequestInput {
  /** Credential key: lowercase kebab/snake, e.g. `openai`. */
  readonly name: string
  /** Human-readable title shown in the dialog. */
  readonly label: string
  /** Why the agent needs it; shown verbatim to the human who consents to it. */
  readonly reason: string
  /** The scope the agent asks for. */
  readonly scope: SecretScope
  /** Optional extra explanation shown in the dialog. */
  readonly description?: string
  /** Optional override of the exposed variable name. */
  readonly envVar?: string
}

/** Which key space the exposed reference lives in. */
export type SecretRefSpace =
  /** `ctx.credentials.resolve(name)` answers with the value (durable store). */
  | 'credential-ref'
  /** Only the `DSH_*` shell environment carries it, for this session only. */
  | 'session-shell-env'

/**
 * The human approved; the agent may use `variable`, never the value.
 *
 * Declared as object type aliases (not interfaces) so a result is structurally a
 * lossless JSON value the tool output contract accepts.
 */
export type SecretApprovedResult = {
  readonly decision: 'approved'
  /** The opaque variable name to pass downstream, e.g. `DSH_SECRET_OPENAI`. */
  readonly variable: string
  /** The effective scope after any human override. */
  readonly scope: SecretScope
  /** Where the agent can have the name resolved, and under which name. */
  readonly ref: { readonly space: SecretRefSpace; readonly name: string }
  /** Non-durable grants expire with their owner; durable ones carry no expiry. */
  readonly expiresAt?: number
  /** `store`: read from the credential store; `entered`: typed in the dialog. */
  readonly source: 'store' | 'entered'
  /**
   * Additive diagnostic (never secret material): set when an earlier grant for
   * this name was revoked, which is why this approval was requested again.
   */
  readonly notice?: string
}

/** The human refused. The agent must stop and must not retry. */
export type SecretRejectedResult = {
  readonly decision: 'rejected'
  readonly reason?: string
}

/** Not authorized this time. The agent may retry later. */
export type SecretIgnoredResult = {
  readonly decision: 'ignored'
}

/** The human answered with free text instead of a decision. */
export type SecretOtherResult = {
  readonly decision: 'other'
  readonly text: string
}

/** Everything `secret_request` can return. Never contains a secret value. */
export type SecretRequestResult =
  | SecretApprovedResult
  | SecretRejectedResult
  | SecretIgnoredResult
  | SecretOtherResult

/** One decision as it arrives from the dialog. */
export type ModalAnswer =
  | { readonly decision: 'approved'; readonly scope: SecretScope; readonly value?: string }
  | { readonly decision: 'rejected'; readonly reason?: string }
  | { readonly decision: 'ignored' }
  | { readonly decision: 'other'; readonly text: string }

/** What the card renders for one waiting request. Contains no secret material. */
export interface PendingView {
  readonly id: string
  /**
   * The `tool/call` identity that raised this request. The in-stream card is
   * built from the durable call event, so this is how it claims its own waiting
   * request instead of every reader racing for the first one.
   */
  readonly callId: string
  /** Session that owns the call, so two sessions can never claim each other's card. */
  readonly sessionId: string
  readonly name: string
  readonly label: string
  readonly reason: string
  readonly description?: string
  readonly requestedScope: SecretScope
  /** The variable name that will be exposed on approval. */
  readonly variable: string
  /** True when a value is already stored, so the dialog hides the value field. */
  readonly alreadyConfigured: boolean
  readonly createdAt: number
  /**
   * Present only for a `secret_manage` interaction: which action is waiting.
   *
   * Additive and optional on purpose. A `secret_request` interaction carries
   * none of these, and a reader that predates them simply ignores them, so the
   * request card's own contract is untouched.
   */
  readonly action?: Exclude<SecretManageAction, 'list'>
  /** Present only for `action:'value'`: which half the value replaces. */
  readonly target?: SecretManageTarget
  /** Present only for `action:'scope'`: the scope the exposure should become. */
  readonly to?: SecretScope
  /**
   * Whether an approval must carry a value.
   *
   * The Host decides this per interaction (a manage `value` action always
   * needs one, a manage `delete` never does), and the answer route holds an
   * approval to it. Absent, the answer route falls back to the request
   * direction's own rule (`!alreadyConfigured`).
   */
  readonly expectValue?: boolean
}

/**
 * Value-free settlement payload the tool persists on `tool/result.meta`.
 *
 * This is the durable, replay-safe source of a card's settled state: it is
 * never model-visible, and it deliberately carries no secret material — the
 * approved arm reports exactly the variable/scope/provenance the agent gets.
 *
 * Declared as an object type alias (not an interface) for the same reason the
 * results above are: structural assignability to the tool output contract's
 * `JsonValue`.
 */
export type SecretPresentationMeta = {
  readonly v: 1
  readonly kind: 'secret-request'
  readonly decision: SecretDecisionKind
  /** Present only for `approved`. */
  readonly variable?: string
  /** Present only for `approved`. */
  readonly scope?: SecretScope
  /** Present only for `approved`. */
  readonly source?: 'store' | 'entered'
  /** Additive diagnostic (never secret material), e.g. a revocation or fallback notice. */
  readonly notice?: string
  /** Present only for `rejected`: the human's optional reason, as the agent receives it. */
  readonly reason?: string
  /** Present only for `other`: the human's free-text instruction, as the agent receives it. */
  readonly text?: string
}

/**
 * What one human submits when they attach a secret to the message they are
 * about to send. The value lives in this request body and in the Host's staged
 * record, and nowhere else. Type-level only: nothing here is imported at runtime.
 */
export interface SecretAttachInput {
  /** Credential key: lowercase kebab/snake, e.g. `openai`. */
  readonly name: string
  /** Human-facing title; defaults to the key. */
  readonly label: string
  /** Where an approved secret lives. Chosen in the capsule; `session` by default. */
  readonly scope: SecretScope
  /** The exposed variable name (`DSH_SECRET_*`). */
  readonly envVar: string
  /** The value the human typed. */
  readonly value: string
}

/** Lifecycle of one attached secret as the capsule reports it. */
export type SecretAttachState =
  /** Registered and waiting for the message that carries it. Nothing is exposed yet. */
  | 'staged'
  /** Bound to a durable message; the variable is live for this session. */
  | 'bound'

/** The capsule-facing view of one attached secret. Never carries a value. */
export interface SecretAttachedView {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  readonly state: SecretAttachState
  readonly createdAt: number
}

/** The value-free outcome of one successful attach. */
export interface SecretAttachOutcome {
  readonly variable: string
  readonly scope: SecretScope
  /** True when this replaced an earlier attach for the same exposed variable. */
  readonly replaced: boolean
}

/**
 * One lifecycle transition of one secret in one session, as the history area
 * reports it. Every arm is a fact the Host observed, never an inference.
 */
export type SecretHistoryEvent =
  /** A human attached a secret (whether or not it replaced an earlier entry). */
  | 'staged'
  /** The staged entry reached a durable message and became a grant. */
  | 'bound'
  /** The human discarded the staged entry from the capsule. */
  | 'discarded'
  /** The marker left the draft and the staged entry was withdrawn. */
  | 'withdrawn'
  /** A bound entry was observed to have lost its anchored message. */
  | 'revoked'
  /** A staged entry reached its TTL. */
  | 'expired'
  /** An agent-asked authorization produced a grant. */
  | 'authorized'
  /** A human replaced this variable's material (the value, never the name). */
  | 'updated'
  /** The variable's scope changed; the entry's own `scope` is what it became. */
  | 'scope-changed'
  /** This session's exposure was withdrawn deliberately (not by an anchor loss). */
  | 'unbound'
  /** The durable credential-store record (value and marker) was removed. */
  | 'deleted'

/** Which direction produced one history entry. */
export type SecretHistorySource =
  /** The human attached it to their own message. */
  | 'attach'
  /** The agent asked for it through `secret_request`. */
  | 'request'
  /** Somebody managed it through `secret_manage` or the info box. */
  | 'manage'

/**
 * One record of the session's attachment/authorization history.
 *
 * Value-free by construction: there is no field a secret value could ride in,
 * and the client's reader rebuilds it field by field.
 */
export interface SecretHistoryEntry {
  readonly at: number
  readonly event: SecretHistoryEvent
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  /** The anchoring message sequence, once the entry reached a durable message. */
  readonly anchorSeq?: number
  readonly source: SecretHistorySource
  /** True when this attach replaced an earlier entry for the same variable. */
  readonly replaced?: boolean
}

/**
 * The history one session reports, newest first.
 *
 * The wrapper exists so the wire shape is frozen independently of the store's
 * own list type: a reader of this contract sees one named container, not a bare
 * array that could sprout fields later.
 */
export interface SecretHistoryView {
  readonly entries: readonly SecretHistoryEntry[]
}

/** Lifecycle of one row the `@` menu may list. */
export type SecretAvailableState =
  /** Registered for this session and waiting for the message that carries it. */
  | 'staged'
  /** Bound to a durable message of this session. */
  | 'bound'
  /** Durable in the credential store but not registered for this session yet. */
  | 'stored'

/** Where one available secret comes from, as the menu labels it. */
export type SecretAvailableSource = 'session' | 'store'

/** One row of the `@` menu's available-secret list. Never carries a value. */
export interface SecretAvailableEntry {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  readonly state: SecretAvailableState
  readonly source: SecretAvailableSource
}

/** One management action. `list` reads; the other four change something. */
export type SecretManageAction =
  /** Enumerate what this session may use, plus what the store holds. */
  | 'list'
  /** Remove the variable from this session only. Never touches the store. */
  | 'unbind'
  /** Remove the durable credential-store record (value and marker). */
  | 'delete'
  /** Re-scope this session's exposure. */
  | 'scope'
  /** Replace the material with a value a human typed. */
  | 'value'

/** Which half of one variable a management action addresses. */
export type SecretManageTarget = 'session' | 'store'

/** Where one management row's facts come from. */
export type SecretManageSource = 'session' | 'store' | 'both'

/**
 * Lifecycle of one row of the management list.
 *
 * `staged`/`bound` are the attach direction's two states (the `@` menu's own
 * vocabulary); `authorized` is the ask direction's — a live grant the human
 * approved for this session through `secret_request`, with no attach record
 * behind it; `stored` means the row has no session side at all.
 */
export type SecretManageState = SecretAvailableState | 'authorized'

/**
 * Which session-side direction put one management row there.
 *
 * `attach` is the human's own direction (the `@` menu: a staged entry, or a
 * grant bound to a message); `request` is the ask direction (`secret_request`,
 * approved by the human in the dialog). The two must stay distinguishable, and
 * the field is present exactly when the row has a session side: a store-only
 * row describes no session-side record, so it carries no origin.
 */
export type SecretManageOrigin = 'attach' | 'request'

/**
 * Which actions the Host proved are currently possible for one row.
 *
 * Computed by the Host from live facts (never inferred by a client, never taken
 * from the caller), so a UI can hide what cannot be done instead of offering an
 * action that would only fail.
 *
 * Declared as an object type alias (not an interface) for the reason the result
 * arms below give: a lossless JSON value the tool output contract accepts.
 */
export type SecretManageCan = {
  readonly unbind: boolean
  readonly delete: boolean
  readonly scope: boolean
  readonly value: boolean
}

/** One row of the management surface. Never carries a value. */
export type SecretManageEntry = {
  readonly variable: string
  readonly name: string
  readonly label: string
  readonly scope: SecretScope
  readonly state: SecretManageState
  readonly source: SecretManageSource
  /** Present exactly when this row has a session side: who created it. */
  readonly origin?: SecretManageOrigin
  readonly can: SecretManageCan
}

/** Arguments the agent supplies to `secret_manage`. There is no value field. */
export type SecretManageInput = {
  readonly action: SecretManageAction
  /** Required for every action except `list`. */
  readonly variable?: string
  /** Required for `scope`: the scope this session's exposure should become. */
  readonly to?: SecretScope
  /** Required for `value`: which half the human's new value replaces. */
  readonly target?: SecretManageTarget
  /** Why this is being asked; shown verbatim to the human who confirms it. */
  readonly reason: string
}

/** What one management submission changed, as both surfaces report it. */
export type SecretManageChange = {
  /** This session's own record (a staged entry or a live grant) changed. */
  readonly session: boolean
  /** The durable credential-store record changed. */
  readonly store: boolean
}

/** The listing: what this session may use. Carries names and metadata only. */
export type SecretManageListedResult = {
  readonly decision: 'listed'
  /**
   * A mutable array on purpose: a result is handed to the tool output contract
   * as a JSON value, and `readonly T[]` is not assignable to one.
   */
  readonly entries: SecretManageEntry[]
  readonly notice?: string
}

/** The action ran (or was a no-op the Host can account for). */
export type SecretManageAppliedResult = {
  readonly decision: 'applied'
  readonly action: Exclude<SecretManageAction, 'list'>
  readonly variable: string
  /** The scope in force after the action. */
  readonly scope: SecretScope
  readonly changed: SecretManageChange
  readonly notice?: string
}

/** Everything `secret_manage` can return. Never contains a secret value. */
export type SecretManageResult =
  | SecretManageListedResult
  | SecretManageAppliedResult
  | SecretRejectedResult
  | SecretIgnoredResult
  | SecretOtherResult

/** The decisions a management result can carry (adds the two non-dialog arms). */
export type SecretManageDecision = SecretDecisionKind | 'listed' | 'applied'

/**
 * Value-free settlement payload of `secret_manage`, persisted on
 * `tool/result.meta` exactly as the request tool's own meta is.
 */
export type SecretManageMeta = {
  readonly v: 1
  readonly kind: 'secret-manage'
  readonly decision: SecretManageDecision
  /** Present for `applied`. */
  readonly action?: Exclude<SecretManageAction, 'list'>
  /** Present for `applied`. */
  readonly variable?: string
  /** Present for `applied`. */
  readonly scope?: SecretScope
  /** Present for `listed`: how many rows the agent was told about. */
  readonly count?: number
  /** Additive, value-free diagnostic. */
  readonly notice?: string
  /** Present only for `rejected`. */
  readonly reason?: string
  /** Present only for `other`. */
  readonly text?: string
}
