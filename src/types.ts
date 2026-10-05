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

/** What the dialog renders for one waiting request. Contains no secret material. */
export interface PendingView {
  readonly id: string
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
