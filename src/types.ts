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
