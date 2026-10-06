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

/** Which direction produced one history entry. */
export type SecretHistorySource = 'attach' | 'request'

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
