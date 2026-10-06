import { deriveEnvVar, isCredentialName, isExposedEnvVar, isSecretScope } from './naming.ts'
import type { ModalAnswer, PendingView, SecretAttachInput, SecretScope } from './types.ts'

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
  | { readonly ok: true; readonly value: { readonly sessionId: string; readonly envVar: string } }
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
  return { ok: true, value: { sessionId, envVar } }
}

/** The session id one attached-list query asks about, or undefined. */
export function attachedSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return trimmedString((raw as Record<string, unknown>).sessionId)
}

/** JSON response helper: no-store, JSON, and never an echoed value. */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}
