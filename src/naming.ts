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

/** Why one release was requested, as the history records it. */
export type ReleaseReason = 'discarded' | 'withdrawn'

/** Whether a raw value is one of the two release reasons the route accepts. */
export function isReleaseReason(value: unknown): value is ReleaseReason {
  return value === 'discarded' || value === 'withdrawn'
}

/** Whether a raw value is a well-formed credential key. */
export function isCredentialName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

/** Whether a raw value is an exposed variable name this plugin may own. */
export function isExposedEnvVar(value: unknown): value is string {
  return typeof value === 'string' && ENV_VAR_PATTERN.test(value) && !RESERVED_ENV_VARS.has(value)
}

/** Whether a credential key derives a variable the harness itself reserves. */
export function derivesReservedEnvVar(name: string): boolean {
  return RESERVED_ENV_VARS.has(deriveEnvVar(name))
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

/** Glyph that carries one attached secret, by name, inside ordinary message text. */
export const MARKER_PREFIX = '@'

/**
 * Marker matcher: an exposed variable name at a line start or after whitespace.
 *
 * The boundary discipline is deliberately the composer editor's own
 * (`TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g`), so the token the editor decorates
 * and the token this plugin binds are always the same one.
 */
const MARKER_PATTERN = /(^|\s)@(DSH_SECRET_[A-Z][A-Z0-9_]*)/gu

/** The marker one attached secret travels as. Never a value. */
export function markerFor(envVar: string): string {
  return `${MARKER_PREFIX}${envVar}`
}

/** The model-facing form of one marker: `[secret DSH_SECRET_X]`. Never a value. */
export function modelFormFor(envVar: string): string {
  return `[secret ${envVar}]`
}

/** Every distinct attached-secret marker in one text, in first-seen order. */
export function parseMarkers(text: string): readonly string[] {
  const found: string[] = []
  MARKER_PATTERN.lastIndex = 0
  let match = MARKER_PATTERN.exec(text)
  while (match !== null) {
    const envVar = match[2]
    if (envVar !== undefined && !found.includes(envVar)) found.push(envVar)
    match = MARKER_PATTERN.exec(text)
  }
  return found
}

/**
 * Render every marker in one text in its model-facing form.
 *
 * A pure function of the text alone: it never consults whether this session
 * still holds the variable, so the same text always yields the same model-side
 * words, and no `@`-prefixed token survives into the rendered result to be
 * mistaken for a file path.
 *
 * Note on where this runs: the durable `user/message` keeps the marker form
 * (`@DSH_SECRET_*`) because the harness derives every model request from that
 * log, so `src/inject.ts` does not rewrite the message body at admission — the
 * value-free note states the mapping per variable instead
 * ({@link renderAttachNote}). This function is the single owner of that
 * notation and is what a transcript consumer (or the note) renders with.
 */
export function rewriteMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, (_whole, lead: string, envVar: string) => `${lead}${modelFormFor(envVar)}`)
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
