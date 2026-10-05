import { isSecretScope } from './naming.ts'
import type { ModalAnswer, PendingView, SecretScope } from './types.ts'

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

/** The dialog-facing view of one pending request. Never carries secret material. */
export function pendingView(request: {
  readonly id: string
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

/** JSON response helper: no-store, JSON, and never an echoed value. */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}
