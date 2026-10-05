import type { SecretRequestInput, SecretScope } from './types.ts'

/** Every exposed variable starts with this prefix. */
export const SECRET_PREFIX = 'DSH_SECRET_'

/** Scope segment of this plugin's credential records (`<scope>/<id>`). */
export const RECORD_SCOPE = 'cordis-plugin-secret'

/** Lowercase kebab/snake credential key. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/** Exposed variable name: `DSH_` namespace, uppercase snake suffix. */
const ENV_VAR_PATTERN = /^DSH_SECRET_[A-Z][A-Z0-9_]*$/

/** Shell-env keys owned by the registry itself; a contributor may not claim them. */
const RESERVED_ENV_VARS = new Set([
  'DSH_HOME',
  'DSH_SHELL',
  'DSH_SESSION_ID',
  'DSH_PROFILE',
  'DSH_PROFILE_DIR',
])

const SCOPES: readonly SecretScope[] = ['session', 'persistent']

/** Whether a raw value is one of the two accepted scopes. */
export function isSecretScope(value: unknown): value is SecretScope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value)
}

/** Derive the default exposed variable name from a credential key. */
export function deriveEnvVar(name: string): string {
  return SECRET_PREFIX + name.replace(/[-_]+/gu, '_').toUpperCase()
}

/**
 * The `<id>` half of this credential's record key. `CredentialKey` segments must
 * match `/^[a-z][a-z0-9-]*$/`, so underscores in a credential key become dashes.
 */
export function recordKeyId(name: string): string {
  const id = name.replace(/_/gu, '-')
  return id.length > 0 ? id : 'secret'
}

/** The record key this plugin commits for one credential. */
export function recordKey(name: string): string {
  return `${RECORD_SCOPE}/${recordKeyId(name)}`
}

/** The exposed variable name for one resolved input (`envVar` wins). */
export function effectiveEnvVar(input: SecretRequestInput): string {
  const override = input.envVar?.trim()
  return override !== undefined && override.length > 0 ? override : deriveEnvVar(input.name)
}

/** Why one candidate request is rejected, or the validated input. */
export type RequestValidation =
  | { readonly ok: true; readonly value: SecretRequestInput }
  | { readonly ok: false; readonly error: string }

function nonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Validate one request. The tool schema already rejects malformed model
 * arguments, but the same validation guards every other caller of the service
 * (and the tests), so it is the single owner of the input contract.
 */
export function validateRequest(raw: unknown): RequestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'secret_request: arguments must be an object' }
  }
  const record = raw as Record<string, unknown>

  const name = nonEmptyString(record.name)
  if (name === undefined) return { ok: false, error: 'secret_request: name is required and must be a non-empty string' }
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: `secret_request: name "${name}" must be lowercase kebab/snake, e.g. "openai" or "openai-key"` }
  }

  const label = nonEmptyString(record.label)
  if (label === undefined) return { ok: false, error: 'secret_request: label is required and must be a non-empty string' }

  const reason = nonEmptyString(record.reason)
  if (reason === undefined) return { ok: false, error: 'secret_request: reason is required and must be a non-empty string' }

  if (!isSecretScope(record.scope)) {
    return { ok: false, error: 'secret_request: scope is required and must be "session" or "persistent"' }
  }

  const description = record.description === undefined ? undefined : nonEmptyString(record.description)
  if (record.description !== undefined && description === undefined) {
    return { ok: false, error: 'secret_request: description, when present, must be a non-empty string' }
  }

  let envVar: string | undefined
  if (record.envVar !== undefined) {
    envVar = nonEmptyString(record.envVar)
    if (envVar === undefined) {
      return { ok: false, error: 'secret_request: envVar, when present, must be a non-empty string' }
    }
    if (!ENV_VAR_PATTERN.test(envVar)) {
      return { ok: false, error: `secret_request: envVar "${envVar}" must match ${String(ENV_VAR_PATTERN)}` }
    }
    if (RESERVED_ENV_VARS.has(envVar)) {
      return { ok: false, error: `secret_request: envVar "${envVar}" is reserved by the Harness` }
    }
  }

  const derived = deriveEnvVar(name)
  if (RESERVED_ENV_VARS.has(derived)) {
    return { ok: false, error: `secret_request: name "${name}" derives the reserved variable "${derived}"` }
  }

  return {
    ok: true,
    value: {
      name,
      label,
      reason,
      scope: record.scope,
      ...(description === undefined ? {} : { description }),
      ...(envVar === undefined ? {} : { envVar }),
    },
  }
}
