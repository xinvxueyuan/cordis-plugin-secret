import type {
  ModalAnswer,
  SecretApprovedResult,
  SecretIgnoredResult,
  SecretOtherResult,
  SecretRefSpace,
  SecretRejectedResult,
  SecretScope,
} from './types.ts'

/** Where an approval is materialized. */
export type GrantStorage =
  /** Write the entered value into the credential store (durable). */
  | 'credentials-set'
  /** A value is already in the credential store; only the exposure is granted. */
  | 'credentials-existing'
  /** Hold the entered value in memory for this session only. */
  | 'session-entered'
  /** Hold the already-stored value in memory for this session only. */
  | 'session-from-store'

/** What the service must do to materialize one approval. */
export interface GrantPlan {
  /** Effective scope after any human override. */
  readonly scope: SecretScope
  /** Key space of the exposed reference. */
  readonly refSpace: SecretRefSpace
  /** Storage route chosen for this approval. */
  readonly storage: GrantStorage
  /** Provenance reported to the agent. */
  readonly source: 'store' | 'entered'
  /** The entered value to persist (durable) or to hold (session). */
  readonly persistValue?: string
  /** The value must be read back from the credential store. */
  readonly resolveValue: boolean
}

/** Inputs of the pure routing decision. */
export interface GrantPlanInput {
  /** Scope the human chose in the dialog (equal to the request's when unchanged). */
  readonly answerScope: SecretScope
  /** The value typed in the dialog, when the dialog collected one. */
  readonly answerValue?: string
  /** Whether the credential store already holds a value for the exposed name. */
  readonly alreadyConfigured: boolean
}

/**
 * Route one approval. The human's scope wins over the agent's request, and a
 * `persistent` approval whose value already exists must not rewrite the store.
 */
export function planGrant(input: GrantPlanInput): GrantPlan {
  if (input.answerScope === 'session') {
    return input.alreadyConfigured
      ? {
          scope: 'session',
          refSpace: 'session-shell-env',
          storage: 'session-from-store',
          source: 'store',
          resolveValue: true,
        }
      : {
          scope: 'session',
          refSpace: 'session-shell-env',
          storage: 'session-entered',
          source: 'entered',
          ...(input.answerValue === undefined ? {} : { persistValue: input.answerValue }),
          resolveValue: false,
        }
  }
  return input.alreadyConfigured
    ? {
        scope: 'persistent',
        refSpace: 'credential-ref',
        storage: 'credentials-existing',
        source: 'store',
        resolveValue: true,
      }
    : {
        scope: 'persistent',
        refSpace: 'credential-ref',
        storage: 'credentials-set',
        source: 'entered',
        ...(input.answerValue === undefined ? {} : { persistValue: input.answerValue }),
        resolveValue: false,
      }
}

/** The approved result for one plan. Carries a name, never a value. */
export function approvedResult(
  plan: GrantPlan,
  envVar: string,
  notice?: string,
): SecretApprovedResult {
  return {
    decision: 'approved',
    variable: envVar,
    scope: plan.scope,
    ref: { space: plan.refSpace, name: envVar },
    source: plan.source,
    ...(notice === undefined ? {} : { notice }),
  }
}

/** Map a non-approved decision onto its result. */
export function mapNonApproved(
  answer: Exclude<ModalAnswer, { decision: 'approved' }>,
): SecretRejectedResult | SecretIgnoredResult | SecretOtherResult {
  switch (answer.decision) {
    case 'rejected':
      return answer.reason === undefined
        ? { decision: 'rejected' }
        : { decision: 'rejected', reason: answer.reason }
    case 'ignored':
      return { decision: 'ignored' }
    case 'other':
      return { decision: 'other', text: answer.text }
  }
}
