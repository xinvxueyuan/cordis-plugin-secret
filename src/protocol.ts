import { deriveEnvVar, isCredentialName, isExposedEnvVar, isReleaseReason, isSecretScope, type ReleaseReason } from './naming.ts'
import type {
  ModalAnswer,
  PendingView,
  SecretAttachInput,
  SecretAvailableEntry,
  SecretHistoryEntry,
  SecretManageAction,
  SecretManageEntry,
  SecretManageTarget,
  SecretScope,
} from './types.ts'

/** Upper bound on a rejection reason echoed back by the dialog. */
const MAX_REASON = 500
/** Upper bound on free-text instructions echoed back by the dialog. */
const MAX_OTHER_TEXT = 2000
/** Upper bound on a secret value accepted from the dialog. */
const MAX_VALUE = 65536

/** Why one dialog submission was refused, or the validated answer. */
export type AnswerValidation =
  | { readonly ok: true; readonly answer: ModalAnswer }
  | { readonly ok: false; readonly error: string }

function trimmedString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Validate one dialog submission. The result is rebuilt field by field, so a
 * submission can never smuggle extra fields (such as a value on a rejection)
 * into the result the agent sees.
 *
 * @param raw - parsed JSON body of the answer request.
 * @param expectValue - whether an approved answer must carry a value.
 */
export function parseAnswer(raw: unknown, expectValue: boolean): AnswerValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'answer must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const id = trimmedString(record.id)
  if (id === undefined) return { ok: false, error: 'answer.id is required' }

  switch (record.decision) {
    case 'approved': {
      if (!isSecretScope(record.scope)) {
        return { ok: false, error: 'answer.scope must be "session" or "persistent"' }
      }
      const scope: SecretScope = record.scope
      const value = typeof record.value === 'string' ? record.value : undefined
      if (expectValue) {
        if (value === undefined || value.length === 0) {
          return { ok: false, error: 'answer.value is required for an approval without a stored credential' }
        }
        if (value.length > MAX_VALUE) {
          return { ok: false, error: `answer.value must be at most ${String(MAX_VALUE)} characters` }
        }
      }
      return {
        ok: true,
        answer: value === undefined || value.length === 0 ? { decision: 'approved', scope } : { decision: 'approved', scope, value },
      }
    }
    case 'rejected': {
      const reason = trimmedString(record.reason)
      if (reason !== undefined && reason.length > MAX_REASON) {
        return { ok: false, error: `answer.reason must be at most ${String(MAX_REASON)} characters` }
      }
      return { ok: true, answer: reason === undefined ? { decision: 'rejected' } : { decision: 'rejected', reason } }
    }
    case 'ignored':
      return { ok: true, answer: { decision: 'ignored' } }
    case 'other': {
      const text = trimmedString(record.text)
      if (text === undefined) return { ok: false, error: 'answer.text is required for the "other" decision' }
      if (text.length > MAX_OTHER_TEXT) {
        return { ok: false, error: `answer.text must be at most ${String(MAX_OTHER_TEXT)} characters` }
      }
      return { ok: true, answer: { decision: 'other', text } }
    }
    default:
      return { ok: false, error: 'answer.decision must be "approved", "rejected", "ignored" or "other"' }
  }
}

/** The identifier carried by an answer submission, or undefined. */
export function answerId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return trimmedString((raw as Record<string, unknown>).id)
}

/** The card-facing view of one pending request. Never carries secret material. */
export function pendingView(request: {
  readonly id: string
  readonly callId: string
  readonly sessionId: string
  readonly name: string
  readonly label: string
  readonly reason: string
  readonly description?: string
  readonly requestedScope: SecretScope
  readonly envVar: string
  readonly alreadyConfigured: boolean
  readonly createdAt: number
  /** Present only for a management interaction; see `PendingView`. */
  readonly action?: Exclude<SecretManageAction, 'list'>
  readonly target?: SecretManageTarget
  readonly to?: SecretScope
  readonly expectValue?: boolean
}): PendingView {
  return {
    id: request.id,
    callId: request.callId,
    sessionId: request.sessionId,
    name: request.name,
    label: request.label,
    reason: request.reason,
    ...(request.description === undefined ? {} : { description: request.description }),
    requestedScope: request.requestedScope,
    variable: request.envVar,
    alreadyConfigured: request.alreadyConfigured,
    createdAt: request.createdAt,
    ...(request.action === undefined ? {} : { action: request.action }),
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.expectValue === undefined ? {} : { expectValue: request.expectValue }),
  }
}

/** One validated attach submission: the input plus the session it belongs to. */
export interface AttachRequestValue extends SecretAttachInput {
  readonly sessionId: string
}

/** Why one attach submission was refused, or the validated input. */
export type AttachValidation =
  | { readonly ok: true; readonly value: AttachRequestValue }
  | { readonly ok: false; readonly error: string }

/** One validated release request. */
export type ReleaseValidation =
  | {
      readonly ok: true
      readonly value: { readonly sessionId: string; readonly envVar: string; readonly reason: ReleaseReason }
    }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one attach submission field by field, so the value can never be
 * joined by fields the caller did not intend and every rejection is our own
 * fixed wording.
 *
 * The value itself is only length-checked here: it is the one field this plugin
 * must never inspect, compare, log or echo.
 */
export function parseAttach(raw: unknown): AttachValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'attach must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const sessionId = trimmedString(record.sessionId)
  if (sessionId === undefined) return { ok: false, error: 'attach.sessionId is required' }

  const name = trimmedString(record.name)
  if (name === undefined) return { ok: false, error: 'attach.name is required' }
  if (!isCredentialName(name)) {
    return { ok: false, error: `attach.name "${name}" must be lowercase kebab/snake, e.g. "openai" or "openai-key"` }
  }

  if (!isSecretScope(record.scope)) {
    return { ok: false, error: 'attach.scope must be "session" or "persistent"' }
  }

  const value = typeof record.value === 'string' ? record.value : undefined
  if (value === undefined || value.length === 0) {
    return { ok: false, error: 'attach.value is required' }
  }
  if (value.length > MAX_VALUE) {
    return { ok: false, error: `attach.value must be at most ${String(MAX_VALUE)} characters` }
  }

  const rawEnvVar = record.envVar
  let envVar = deriveEnvVar(name)
  if (rawEnvVar !== undefined && rawEnvVar !== null && rawEnvVar !== '') {
    const candidate = trimmedString(rawEnvVar)
    if (candidate === undefined) {
      return { ok: false, error: 'attach.envVar, when present, must be a non-empty string' }
    }
    envVar = candidate
  }
  if (!isExposedEnvVar(envVar)) {
    return {
      ok: false,
      error: `attach.envVar "${envVar}" must look like DSH_SECRET_OPENAI and must not be reserved by the Harness`,
    }
  }

  return {
    ok: true,
    value: {
      sessionId,
      name,
      label: trimmedString(record.label) ?? name,
      scope: record.scope,
      envVar,
      value,
    },
  }
}

/** Validate one release request: the session plus the exposed variable to drop. */
export function parseRelease(raw: unknown): ReleaseValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'release must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const sessionId = trimmedString(record.sessionId)
  if (sessionId === undefined) return { ok: false, error: 'release.sessionId is required' }
  const envVar = trimmedString(record.variable)
  if (envVar === undefined) return { ok: false, error: 'release.variable is required' }
  if (!isExposedEnvVar(envVar)) {
    return { ok: false, error: 'release.variable must look like DSH_SECRET_OPENAI' }
  }
  // The reason is diagnostic only: it decides which history event is recorded,
  // never whether the record is dropped. A caller that names none means the
  // human pressed discard, which is what every caller did before this round.
  const rawReason = record.reason
  if (rawReason !== undefined && !isReleaseReason(rawReason)) {
    return { ok: false, error: 'release.reason must be "discarded" or "withdrawn"' }
  }
  return { ok: true, value: { sessionId, envVar, reason: rawReason === undefined ? 'discarded' : rawReason } }
}

/** One validated adopt request: which stored secret to register for a session. */
export type AdoptValidation =
  | { readonly ok: true; readonly value: { readonly sessionId: string; readonly envVar: string } }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one adopt submission.
 *
 * Adopting is the `@` menu's path for a secret that is already durable in the
 * credential store but is not registered for this session: the Host resolves the
 * stored value itself, so the value never crosses the wire in either direction.
 */
export function parseAdopt(raw: unknown): AdoptValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'adopt must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const sessionId = trimmedString(record.sessionId)
  if (sessionId === undefined) return { ok: false, error: 'adopt.sessionId is required' }
  const envVar = trimmedString(record.variable)
  if (envVar === undefined) return { ok: false, error: 'adopt.variable is required' }
  if (!isExposedEnvVar(envVar)) {
    return { ok: false, error: 'adopt.variable must look like DSH_SECRET_OPENAI' }
  }
  return { ok: true, value: { sessionId, envVar } }
}

/** The session id one read-only query asks about, or undefined. */
export function sessionIdQuery(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return trimmedString((raw as Record<string, unknown>).sessionId)
}

/** The history entry as the wire carries it: rebuilt field by field. */
export function historyView(entry: SecretHistoryEntry): SecretHistoryEntry {
  return {
    at: entry.at,
    event: entry.event,
    variable: entry.variable,
    name: entry.name,
    label: entry.label,
    scope: entry.scope,
    source: entry.source,
    ...(entry.anchorSeq === undefined ? {} : { anchorSeq: entry.anchorSeq }),
    ...(entry.replaced === undefined ? {} : { replaced: entry.replaced }),
  }
}

/** One available row as the wire carries it: rebuilt field by field. */
export function availableView(entry: SecretAvailableEntry): SecretAvailableEntry {
  return {
    variable: entry.variable,
    name: entry.name,
    label: entry.label,
    scope: entry.scope,
    state: entry.state,
    source: entry.source,
  }
}

/** The session id one attached-list query asks about, or undefined. */
export function attachedSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return trimmedString((raw as Record<string, unknown>).sessionId)
}

/** The four management actions that change something (never `list`). */
export type ManageWireAction = Exclude<SecretManageAction, 'list'>

const MANAGE_WIRE_ACTIONS: readonly ManageWireAction[] = ['unbind', 'delete', 'scope', 'value']

/** One validated management submission from the info box. */
export interface ManageRequestValue {
  readonly sessionId: string
  readonly action: ManageWireAction
  readonly variable: string
  /** Present only for `scope`. */
  readonly to?: SecretScope
  /** Present only for `value`. */
  readonly target?: SecretManageTarget
  /** Present only for `value`: the value the human typed into the masked input. */
  readonly value?: string
  /** True exactly for `delete`, whose whole point is an irreversible removal. */
  readonly confirm: boolean
}

/** Why one management submission was refused, or the validated intent. */
export type ManageValidation =
  | { readonly ok: true; readonly value: ManageRequestValue }
  | { readonly ok: false; readonly error: string }

/**
 * Validate one info-box management submission field by field.
 *
 * The per-action field rules are the mechanism that keeps the two deletion
 * tiers apart instead of relying on wording: `unbind` refuses a `confirm` (it
 * needs none, and accepting one would suggest it is dangerous), `delete`
 * refuses the request without it, `value` is the only action that may carry a
 * value at all, and an action that carries a field it has no use for is
 * refused rather than quietly ignored.
 */
export function parseManage(raw: unknown): ManageValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'manage must be a JSON object' }
  }
  const record = raw as Record<string, unknown>
  const sessionId = trimmedString(record.sessionId)
  if (sessionId === undefined) return { ok: false, error: 'manage.sessionId is required' }

  const action = record.action
  if (typeof action !== 'string' || !(MANAGE_WIRE_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: 'manage.action must be "unbind", "delete", "scope" or "value" (the list is a GET)',
    }
  }
  const kind = action as ManageWireAction

  const variable = trimmedString(record.variable)
  if (variable === undefined) return { ok: false, error: 'manage.variable is required' }
  if (!isExposedEnvVar(variable)) {
    return { ok: false, error: 'manage.variable must look like DSH_SECRET_OPENAI' }
  }

  const hasValueField = record.value !== undefined
  if (kind !== 'value' && hasValueField) {
    return { ok: false, error: `manage.value is only accepted for the "value" action, not "${kind}"` }
  }
  let value: string | undefined
  if (kind === 'value') {
    value = typeof record.value === 'string' ? record.value : undefined
    if (value === undefined || value.length === 0) {
      return { ok: false, error: 'manage.value is required for the "value" action' }
    }
    if (value.length > MAX_VALUE) {
      return { ok: false, error: `manage.value must be at most ${String(MAX_VALUE)} characters` }
    }
  }

  const hasToField = record.to !== undefined
  if (kind !== 'scope' && hasToField) {
    return { ok: false, error: `manage.to is only accepted for the "scope" action, not "${kind}"` }
  }
  let to: SecretScope | undefined
  if (kind === 'scope') {
    if (!isSecretScope(record.to)) {
      return { ok: false, error: 'manage.to must be "session" or "persistent"' }
    }
    to = record.to
  }

  const hasTargetField = record.target !== undefined
  if (kind !== 'value' && hasTargetField) {
    return { ok: false, error: `manage.target is only accepted for the "value" action, not "${kind}"` }
  }
  let target: SecretManageTarget | undefined
  if (kind === 'value') {
    if (record.target !== 'session' && record.target !== 'store') {
      return { ok: false, error: 'manage.target must be "session" or "store"' }
    }
    target = record.target
  }

  const hasConfirmField = record.confirm !== undefined
  if (kind !== 'delete' && hasConfirmField) {
    return { ok: false, error: `manage.confirm is only meaningful for the "delete" action, not "${kind}"` }
  }
  const confirm = kind === 'delete' && record.confirm === true
  if (kind === 'delete' && !confirm) {
    return {
      ok: false,
      error: 'manage.confirm must be true: deleting the credential-store record is irreversible',
    }
  }

  return {
    ok: true,
    value: {
      sessionId,
      action: kind,
      variable,
      ...(to === undefined ? {} : { to }),
      ...(target === undefined ? {} : { target }),
      ...(value === undefined ? {} : { value }),
      confirm,
    },
  }
}

/** One management row as the wire carries it: rebuilt field by field. */
export function manageView(entry: SecretManageEntry): SecretManageEntry {
  return {
    variable: entry.variable,
    name: entry.name,
    label: entry.label,
    scope: entry.scope,
    state: entry.state,
    source: entry.source,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    can: {
      unbind: entry.can.unbind === true,
      delete: entry.can.delete === true,
      scope: entry.can.scope === true,
      value: entry.can.value === true,
    },
  }
}

/** JSON response helper: no-store, JSON, and never an echoed value. */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}
