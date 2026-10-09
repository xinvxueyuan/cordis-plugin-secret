import type { SecretManageAction, SecretManageTarget, SecretRequestInput, SecretScope } from './types.ts'

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

/**
 * One validated `secret_manage` call.
 *
 * A discriminated union rather than one shape with optional fields: the `list`
 * arm has no variable to misuse and every other arm has to have one, so the
 * service cannot accidentally treat a listing as a change.
 */
export type ManageRequestInput =
  | { readonly action: 'list'; readonly reason: string }
  | {
      readonly action: Exclude<SecretManageAction, 'list'>
      readonly variable: string
      /** Present exactly for `scope`. */
      readonly to?: SecretScope
      /** Present exactly for `value`. */
      readonly target?: SecretManageTarget
      readonly reason: string
    }

/** Why one candidate management request is rejected, or the validated input. */
export type ManageRequestValidation =
  | { readonly ok: true; readonly value: ManageRequestInput }
  | { readonly ok: false; readonly error: string }

const MANAGE_ACTIONS: readonly string[] = ['list', 'unbind', 'delete', 'scope', 'value']

/**
 * Validate one `secret_manage` call.
 *
 * The schema already rejects malformed arguments, but this is the single owner
 * of the contract for every caller (the tests drive it too), and it is where
 * the one structural promise is enforced rather than merely documented: **there
 * is no field a value could travel in**. A call that carries one is refused
 * with a message that says why, instead of being quietly ignored.
 */
export function validateManage(raw: unknown): ManageRequestValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'secret_manage: arguments must be an object' }
  }
  const record = raw as Record<string, unknown>

  const action = nonEmptyString(record.action)
  if (action === undefined || !MANAGE_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: 'secret_manage: action is required and must be "list", "unbind", "delete", "scope" or "value"',
    }
  }

  if (record.value !== undefined) {
    return {
      ok: false,
      error: 'secret_manage: this tool never carries a value; a human types it into the confirmation surface',
    }
  }

  const reason = nonEmptyString(record.reason)
  if (reason === undefined) {
    return { ok: false, error: 'secret_manage: reason is required and must be a non-empty string' }
  }

  const rawVariable = record.variable
  const variable = rawVariable === undefined ? undefined : nonEmptyString(rawVariable)
  if (action === 'list') {
    if (rawVariable !== undefined) {
      return { ok: false, error: 'secret_manage: the "list" action takes no variable' }
    }
    return { ok: true, value: { action: 'list', reason } }
  }
  if (variable === undefined) {
    return { ok: false, error: `secret_manage: variable is required for the "${action}" action` }
  }
  if (!isExposedEnvVar(variable)) {
    return {
      ok: false,
      error: `secret_manage: variable "${variable}" must look like DSH_SECRET_OPENAI`,
    }
  }
  const kind = action as Exclude<SecretManageAction, 'list'>

  const hasTo = record.to !== undefined
  if (kind !== 'scope' && hasTo) {
    return { ok: false, error: `secret_manage: "to" is only accepted for the "scope" action, not "${kind}"` }
  }
  let to: SecretScope | undefined
  if (kind === 'scope') {
    if (!isSecretScope(record.to)) {
      return { ok: false, error: 'secret_manage: "to" is required for the "scope" action and must be "session" or "persistent"' }
    }
    to = record.to
  }

  const hasTarget = record.target !== undefined
  if (kind !== 'value' && hasTarget) {
    return { ok: false, error: `secret_manage: "target" is only accepted for the "value" action, not "${kind}"` }
  }
  let target: SecretManageTarget | undefined
  if (kind === 'value') {
    if (record.target !== 'session' && record.target !== 'store') {
      return { ok: false, error: 'secret_manage: "target" is required for the "value" action and must be "session" or "store"' }
    }
    target = record.target
  }

  return {
    ok: true,
    value: {
      action: kind,
      variable,
      ...(to === undefined ? {} : { to }),
      ...(target === undefined ? {} : { target }),
      reason,
    },
  }
}

// ---------------------------------------------------------------------------
// R1: a credential key the human left blank
//
// The rule this section exists to keep: the model is asked for a key, never for
// a value. What crosses the boundary is the human's own title plus a *shape*
// (length, character classes, and one public prefix-family token) — a token such
// as `openai-like` is the category name, and no substring of the value is ever
// part of it. Everything here is pure, so both the shape and the exact prompt
// text are asserted in tests.
// ---------------------------------------------------------------------------

/**
 * Deadline for one model suggestion, in milliseconds.
 *
 * Hardcoded on purpose (round 7 settled that the key is fixed before the marker
 * is inserted, so the attach may wait a *little* for a better name — never long
 * enough for a human to notice a stall). `SecretServiceDeps.nameDeadlineMs`
 * overrides it so tests can use a tiny value.
 */
export const NAME_DEADLINE_MS = 1500

/** The public prefix family a value's own characters reveal; a fixed token, never the prefix. */
export type SecretShapeCategory =
  | 'openai-like'
  | 'anthropic-like'
  | 'github-pat-like'
  | 'aws-access-key-like'
  | 'slack-like'
  | 'google-api-key-like'
  | 'jwt-like'
  | 'pem-private-key-like'
  | 'stripe-like'
  | 'unknown'

/**
 * The model-facing fingerprint of one value.
 *
 * Every field is a number or a token from a fixed vocabulary: there is no field
 * a plaintext could travel in, which is what makes the request safe to send.
 */
export interface SecretValueShape {
  readonly length: number
  /** Character-class class of the value (never the characters themselves). */
  readonly charset: 'base64url' | 'hex' | 'mixed' | 'other'
  readonly category: SecretShapeCategory
}

/** Prefix families of well-known credential formats, longest match first. */
const SHAPE_PREFIXES: readonly { readonly category: Exclude<SecretShapeCategory, 'unknown'>; readonly prefixes: readonly string[] }[] = [
  { category: 'pem-private-key-like', prefixes: ['-----BEGIN'] },
  { category: 'anthropic-like', prefixes: ['sk-ant-'] },
  { category: 'stripe-like', prefixes: ['sk_live_', 'rk_live_', 'sk_test_'] },
  { category: 'openai-like', prefixes: ['sk-'] },
  { category: 'github-pat-like', prefixes: ['github_pat_', 'ghp_', 'gho_', 'ghs_', 'ghu_'] },
  { category: 'aws-access-key-like', prefixes: ['AKIA', 'ASIA'] },
  { category: 'slack-like', prefixes: ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-'] },
  { category: 'google-api-key-like', prefixes: ['AIza', 'ya29.'] },
  { category: 'jwt-like', prefixes: ['eyJ'] },
]

/** The fallback key each public category suggests, before de-duplication. */
const KEY_BY_CATEGORY: Readonly<Record<Exclude<SecretShapeCategory, 'unknown'>, string>> = {
  'openai-like': 'openai-key',
  'anthropic-like': 'anthropic-key',
  'github-pat-like': 'github-token',
  'aws-access-key-like': 'aws-access-key',
  'slack-like': 'slack-token',
  'google-api-key-like': 'google-api-key',
  'jwt-like': 'jwt-token',
  'pem-private-key-like': 'private-key',
  'stripe-like': 'stripe-key',
}

/** The longest key this plugin will mint (leaves room for a `-99` de-duplication suffix). */
const MAX_MINTED_KEY = 36

function categoryOf(value: string): SecretShapeCategory {
  for (const family of SHAPE_PREFIXES) {
    if (family.prefixes.some((prefix) => value.startsWith(prefix))) return family.category
  }
  return 'unknown'
}

function charsetOf(value: string): SecretValueShape['charset'] {
  if (value.length === 0) return 'other'
  if (/^[0-9a-fA-F]+$/u.test(value)) return 'hex'
  if (/^[A-Za-z0-9_\-=+/]+$/u.test(value)) return 'base64url'
  if (/^[\u0020-\u007E]+$/u.test(value)) return 'mixed'
  return 'other'
}

/** The shape of one value, for the model and for the local fallback rule. */
export function describeValueShape(value: string): SecretValueShape {
  return {
    length: value.length,
    charset: charsetOf(value),
    category: categoryOf(value),
  }
}

/**
 * A key derived from a human title: lowercase, dashes for every run of
 * anything else, trimmed, and legal for {@link isCredentialName} or nothing.
 */
function slugOf(label: string): string | undefined {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, MAX_MINTED_KEY)
    .replace(/-+$/u, '')
  return isCredentialName(slug) ? slug : undefined
}

/**
 * Make one candidate key unique against the keys and record ids already taken.
 *
 * Both halves are compared because two distinct keys can share one record key
 * (`a_b` and `a-b` both record as `a-b`), and a new key must never be minted
 * onto an existing record.
 */
export function dedupeKey(base: string, taken: ReadonlySet<string>): string {
  const root = (isCredentialName(base) ? base : 'secret').slice(0, MAX_MINTED_KEY).replace(/-+$/u, '')
  const legalRoot = isCredentialName(root) ? root : 'secret'
  if (!taken.has(legalRoot) && !taken.has(recordKeyId(legalRoot))) return legalRoot
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${legalRoot}-${String(suffix)}`
    if (!taken.has(candidate) && !taken.has(recordKeyId(candidate))) return candidate
  }
  return `${legalRoot}-99`
}

/**
 * The key this plugin uses when no model is available, or when the model's
 * answer is late, empty or unusable.
 *
 * Follows the settled order: the value's public category first (it is the
 * strongest signal about *which* provider a key belongs to), then the human's
 * title, then a shape-based default.
 */
export function provisionalKey(label: string, shape: SecretValueShape, taken: ReadonlySet<string>): string {
  const byCategory = shape.category === 'unknown' ? undefined : KEY_BY_CATEGORY[shape.category]
  const byLabel = slugOf(label)
  const byShape =
    shape.charset === 'base64url' || shape.charset === 'hex'
      ? 'secret-token'
      : shape.charset === 'mixed'
        ? 'secret-key'
        : 'secret'
  return dedupeKey(byCategory ?? byLabel ?? byShape, taken)
}

/**
 * The credential key inside one model answer, or undefined when the answer has
 * none this plugin will accept.
 *
 * The answer is a model's text: it is reduced to its first non-empty line, then
 * to the legal key shape, and refused outright when that shape is not a
 * credential key — a refusal silently falls back to the local rule. A line with
 * more than four words is a sentence, not a key, and is refused as well (the
 * system instruction asks for at most four).
 */
export function modelKeyFromText(text: string): string | undefined {
  const line = text
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return undefined
  if (line.split(/\s+/u).length > 4) return undefined
  const cleaned = line
    .replace(/[`'"*]/gu, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, MAX_MINTED_KEY)
    .replace(/-+$/u, '')
  return isCredentialName(cleaned) ? cleaned : undefined
}

/**
 * The exact text one key suggestion sends.
 *
 * Two strings, and only two sources of content: the human's title (which the
 * page shows anyway) and {@link SecretValueShape} tokens. There is deliberately
 * no parameter here that could carry a value, so a caller cannot leak one by
 * accident.
 */
export function renderNamingPrompt(label: string, shape: SecretValueShape): { readonly system: string; readonly user: string } {
  const title = label.trim().length > 0 ? label.trim() : '(none given)'
  return {
    system:
      'You name credentials. Reply with one credential key only: lowercase ASCII, kebab-case or snake_case, starting with a letter, at most four words, no quotes, no explanation, no code, no punctuation beyond - and _.',
    user: [
      'Suggest one credential key for a secret that is being attached to a message.',
      `Human title: ${title}`,
      `Value shape (plaintext is not included): length=${String(shape.length)}, charset=${shape.charset}, category=${shape.category}`,
    ].join('\n'),
  }
}
